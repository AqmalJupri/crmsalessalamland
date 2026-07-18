const fs = require("node:fs/promises");
const path = require("node:path");

const runtimePath = process.argv[2] || "data/runtime.json";
const APP_TIME_ZONE = process.env.APP_TIME_ZONE || "Asia/Kuala_Lumpur";

function parseDelimitedIds(value = "") {
  return String(value)
    .split(/[,\n]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function localIsoDate(value = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: APP_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(value instanceof Date ? value : new Date(value));
}

function addDays(isoDate, days) {
  const date = new Date(`${String(isoDate).slice(0, 10)}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return localIsoDate(date);
}

async function fetchFormLeads(runtime, connection, formId) {
  const apiVersion = runtime.integrations?.meta?.apiVersion || "v22.0";
  const url = new URL(`https://graph.facebook.com/${apiVersion}/${formId}/leads`);
  url.searchParams.set("fields", "id,created_time,ad_id,form_id");
  url.searchParams.set("limit", "100");
  url.searchParams.set("access_token", connection.metaAccessToken);
  const response = await fetch(url);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error?.message || `Meta form ${formId} failed HTTP ${response.status}`);
  }
  return Array.isArray(payload.data) ? payload.data : [];
}

(async () => {
  const raw = await fs.readFile(runtimePath, "utf8");
  const runtime = JSON.parse(raw);
  const metaDateMap = new Map();

  for (const connection of runtime.integrations.connections || []) {
    if (!connection.metaEnabled || !connection.metaAccessToken) continue;
    for (const formId of parseDelimitedIds(connection.metaFormIds)) {
      const leads = await fetchFormLeads(runtime, connection, formId);
      leads.forEach((lead) => {
        if (!lead.id || !lead.created_time) return;
        metaDateMap.set(String(lead.id), {
          createdAt: localIsoDate(lead.created_time),
          metaCreatedTime: String(lead.created_time),
          formId: String(lead.form_id || formId),
          adId: String(lead.ad_id || "")
        });
      });
    }
  }

  let changed = 0;
  const changedRecords = [];
  runtime.records = (runtime.records || []).map((record) => {
    if (record.details?.externalPlatform !== "meta") return record;
    const meta = metaDateMap.get(String(record.details.externalLeadId || ""));
    if (!meta || record.createdAt === meta.createdAt) {
      if (meta?.metaCreatedTime && !record.details.metaCreatedTime) {
        record.details.metaCreatedTime = meta.metaCreatedTime;
      }
      return record;
    }
    const oldDate = record.createdAt;
    const oldFollowUp = record.nextFollowUp;
    const oldExpectedFollowUp = addDays(oldDate, 14);
    const next = {
      ...record,
      createdAt: meta.createdAt,
      details: {
        ...record.details,
        metaCreatedTime: meta.metaCreatedTime,
        metaFormId: record.details.metaFormId || meta.formId,
        metaAdId: record.details.metaAdId || meta.adId
      },
      updatedAt: new Date().toISOString()
    };
    if (!oldFollowUp || oldFollowUp === oldExpectedFollowUp) {
      next.nextFollowUp = addDays(meta.createdAt, 14);
    }
    changed += 1;
    changedRecords.push({
      leadId: record.details.externalLeadId,
      name: record.customerName,
      staff: record.staff,
      from: oldDate,
      to: next.createdAt
    });
    return next;
  });

  if (changed) {
    const backupPath = path.join(path.dirname(runtimePath), `runtime-before-meta-date-fix-${Date.now()}.json`);
    await fs.writeFile(backupPath, raw);
    runtime.updatedAt = new Date().toISOString();
    await fs.writeFile(runtimePath, JSON.stringify(runtime, null, 2));
  }

  console.log(JSON.stringify({ ok: true, changed, changedRecords: changedRecords.slice(0, 20) }, null, 2));
})();

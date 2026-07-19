const fs = require("node:fs");

const RUNTIME_PATH = process.argv[2] || "data/runtime.json";
const runtime = JSON.parse(fs.readFileSync(RUNTIME_PATH, "utf8"));
const today = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Kuala_Lumpur",
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
}).format(new Date());

function parseDelimitedIds(value = "") {
  return String(value)
    .split(/[,\n]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function pickField(map, keys) {
  for (const key of keys) {
    if (map[key]) return map[key];
  }
  return "";
}

function fieldMap(lead) {
  const map = {};
  for (const item of lead.field_data || []) {
    const value = Array.isArray(item.values) ? item.values[0] : "";
    map[item.name] = value || "";
  }
  return map;
}

function localDate(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kuala_Lumpur",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(value));
}

function summarizeRecord(record) {
  return {
    id: record.id,
    externalLeadId: record.details?.externalLeadId || "",
    name: record.customerName || "",
    phone: record.phone || "",
    source: record.source || "",
    staff: record.staff || "",
    status: record.status || "",
    createdAt: record.createdAt || "",
    formId: record.details?.metaFormId || "",
    campaign: record.details?.metaCampaignName || record.campaignId || ""
  };
}

async function fetchFormLeads(connection, formId) {
  const apiVersion = runtime.integrations?.meta?.apiVersion || "v22.0";
  const url = new URL(`https://graph.facebook.com/${apiVersion}/${formId}/leads`);
  url.searchParams.set("fields", "id,created_time,ad_id,ad_name,adset_name,campaign_id,campaign_name,form_id,field_data");
  url.searchParams.set("limit", "100");
  url.searchParams.set("access_token", connection.metaAccessToken);
  const leads = [];
  const seen = new Set();
  let nextUrl = url.toString();
  for (let page = 0; nextUrl && page < 20; page += 1) {
    const response = await fetch(nextUrl);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      return { formId, ok: false, error: payload.error?.message || `HTTP ${response.status}`, leads };
    }
    for (const lead of Array.isArray(payload.data) ? payload.data : []) {
      const id = String(lead.id || "");
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      leads.push(lead);
    }
    nextUrl = payload?.paging?.next || "";
  }
  return { formId, ok: true, leads };
}

(async () => {
  const salamLeads = runtime.records
    .filter((record) => record.companyId === "salam-land" && record.kind === "lead")
    .map(summarizeRecord);
  const crmExternalIds = new Set(salamLeads.map((record) => record.externalLeadId).filter(Boolean));
  const connections = runtime.integrations.connections
    .filter((connection) => connection.companyId === "salam-land");
  const output = {
    runtimeUpdatedAt: runtime.updatedAt,
    todayMalaysia: today,
    crm: {
      totalSalamLeads: salamLeads.length,
      todaySalamLeads: salamLeads.filter((record) => record.createdAt === today).length,
      todayMetaLeads: salamLeads.filter((record) => record.createdAt === today && record.source === "Meta Ads").length,
      recent: salamLeads.slice(0, 25)
    },
    connections: connections.map((connection) => ({
      companyId: connection.companyId,
      metaEnabled: connection.metaEnabled,
      pageId: connection.metaPageId,
      formIds: parseDelimitedIds(connection.metaFormIds),
      hasLeadToken: Boolean(connection.metaAccessToken),
      hasSpendToken: Boolean(connection.metaSpendAccessToken),
      defaultStaff: connection.metaDefaultStaff,
      leadStatus: connection.metaLeadStatus
    })),
    forms: [],
    missingFromCrm: [],
    inbound: (runtime.integrations.inboundEvents || []).slice(0, 20).map((event) => ({
      at: event.at,
      source: event.source,
      status: event.status,
      summary: event.summary,
      payload: event.payload
    }))
  };

  for (const connection of connections.filter((connection) => connection.metaEnabled && connection.metaAccessToken)) {
    for (const formId of parseDelimitedIds(connection.metaFormIds)) {
      const result = await fetchFormLeads(connection, formId);
      const formSummary = {
        formId,
        ok: result.ok,
        error: result.error || "",
        fetched: result.leads.length,
        todayMalaysia: result.leads.filter((lead) => localDate(lead.created_time) === today).length,
        recent: result.leads.slice(0, 12).map((lead) => {
          const map = fieldMap(lead);
          return {
            id: lead.id,
            createdTime: lead.created_time,
            localDate: localDate(lead.created_time),
            inCrm: crmExternalIds.has(String(lead.id || "")),
            name: pickField(map, ["full_name", "name", "customer_name"]),
            phone: pickField(map, ["phone_number", "phone", "mobile_number"]),
            formId: lead.form_id || formId,
            adId: lead.ad_id || "",
            adName: lead.ad_name || "",
            campaignName: lead.campaign_name || ""
          };
        })
      };
      output.forms.push(formSummary);
      output.missingFromCrm.push(...formSummary.recent.filter((lead) => !lead.inCrm));
    }
  }

  console.log(JSON.stringify(output, null, 2));
})();

import { execFileSync } from "node:child_process";

const baseUrl = process.env.CRM_BASE_URL || "https://salamland.my";
const apiVersion = process.env.CRM_META_API_VERSION || "v25.0";
const pageId = process.env.CRM_META_PAGE_ID || "330336670172572";
const sinceIso = process.env.CRM_BACKFILL_SINCE || new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString();
const leadLimitPerForm = Number(process.env.CRM_BACKFILL_LIMIT || 100);

function clipboardText() {
  try {
    return execFileSync("pbpaste", { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

const sourceToken = (process.env.CRM_META_TOKEN || clipboardText()).trim();
if (!sourceToken) {
  throw new Error("No Meta token found. Copy a Graph API token first or set CRM_META_TOKEN.");
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${JSON.stringify(payload).slice(0, 260)}`);
  }
  return payload;
}

async function readGraph(path, token, params = {}) {
  const url = new URL(`https://graph.facebook.com/${apiVersion}/${path}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  url.searchParams.set("access_token", token);
  return fetchJson(url);
}

async function resolvePageToken(token) {
  try {
    await readGraph(`${pageId}/leadgen_forms`, token, { fields: "id", limit: "1" });
    return token;
  } catch (error) {
    if (!String(error?.message || "").includes("Page Access Token")) {
      throw error;
    }
  }

  const accounts = await readGraph("me/accounts", token, {
    fields: "id,name,access_token",
    limit: "100"
  });
  const page = (accounts.data || []).find((account) => String(account.id) === String(pageId));
  if (!page?.access_token) {
    throw new Error(`Could not derive Page Access Token for page ${pageId}.`);
  }
  return page.access_token;
}

async function listAllForms(pageToken) {
  const forms = await readGraph(`${pageId}/leadgen_forms`, pageToken, {
    fields: "id,name,status,leads_count",
    limit: "100"
  });
  return forms.data || [];
}

async function listRecentLeads(pageToken, formId) {
  const leads = await readGraph(`${formId}/leads`, pageToken, {
    fields: "id,created_time,ad_id,form_id,platform,field_data",
    limit: String(leadLimitPerForm)
  });
  const since = new Date(sinceIso).getTime();
  return (leads.data || []).filter((lead) => {
    const created = new Date(lead.created_time || 0).getTime();
    return Number.isFinite(created) && created >= since;
  });
}

async function replayLead(form, lead) {
  const payload = {
    object: "page",
    entry: [
      {
        id: pageId,
        time: Math.floor(Date.now() / 1000),
        changes: [
          {
            field: "leadgen",
            value: {
              leadgen_id: lead.id,
              page_id: pageId,
              form_id: lead.form_id || form.id,
              ad_id: lead.ad_id || "",
              created_time: lead.created_time || ""
            }
          }
        ]
      }
    ]
  };

  return fetchJson(`${baseUrl}/api/webhooks/meta`, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

const pageToken = await resolvePageToken(sourceToken);
const forms = await listAllForms(pageToken);

const replayed = [];
for (const form of forms) {
  const leads = await listRecentLeads(pageToken, form.id);
  for (const lead of leads) {
    const result = await replayLead(form, lead);
    replayed.push({
      formId: form.id,
      formName: form.name,
      leadId: lead.id,
      createdTime: lead.created_time,
      result: result.results?.[0]?.status || "unknown"
    });
  }
}

console.log(JSON.stringify({
  ok: true,
  since: sinceIso,
  formsChecked: forms.length,
  leadsReplayed: replayed.length,
  results: replayed
}, null, 2));

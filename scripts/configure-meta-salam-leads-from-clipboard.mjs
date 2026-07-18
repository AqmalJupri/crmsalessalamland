import { execFileSync } from "node:child_process";

const baseUrl = process.env.CRM_BASE_URL || "https://salamland.my";
const username = process.env.CRM_USERNAME;
const password = process.env.CRM_PASSWORD;
const pageId = process.env.CRM_META_PAGE_ID || "330336670172572";
const formIds = process.env.CRM_META_FORM_IDS || "3226859620830130";
const verifyToken = process.env.CRM_META_VERIFY_TOKEN || "crm-salam-fortress-meta";
const apiVersion = process.env.CRM_META_API_VERSION || "v25.0";

if (!username || !password) {
  throw new Error("Set CRM_USERNAME and CRM_PASSWORD before running this script.");
}

function clipboardText() {
  try {
    return execFileSync("pbpaste", { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

const rawMetaToken = (process.env.CRM_META_TOKEN || clipboardText()).trim();

if (!rawMetaToken) {
  throw new Error("No Meta token found. Copy the User access token first or set CRM_META_TOKEN.");
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
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
    throw new Error(`${response.status} ${response.statusText}: ${JSON.stringify(payload).slice(0, 220)}`);
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

async function resolveLeadToken(token) {
  try {
    const accounts = await readGraph("me/accounts", token, {
      fields: "id,name,access_token",
      limit: "100"
    });
    const page = (accounts.data || []).find((account) => account.id === pageId);
    if (page?.access_token) {
      await readGraph(`${pageId}/leadgen_forms`, page.access_token, {
        fields: "id,name,status,leads_count",
        limit: "5"
      });
      return { token: page.access_token, source: "page_token" };
    }
  } catch {
    // Some Business Login tokens can read form leads directly even when the Page
    // does not appear in /me/accounts. The form probe below validates that path.
  }

  const firstFormId = String(formIds).split(/[,\s]+/).map((item) => item.trim()).filter(Boolean)[0];
  if (!firstFormId) {
    throw new Error("No Meta form ID available to verify lead token.");
  }

  await readGraph(`${firstFormId}/leads`, token, {
    fields: "id,created_time,ad_id,form_id",
    limit: "1"
  });

  return { token, source: "user_token_with_leads_retrieval" };
}

const resolvedLeadToken = await resolveLeadToken(rawMetaToken);

const login = await fetchJson(`${baseUrl}/api/auth/login`, {
  method: "POST",
  body: JSON.stringify({ username, password })
});

const current = await fetchJson(`${baseUrl}/api/integrations`, { token: login.token });
const nextConnections = (current.connections || []).map((connection) => {
  if (connection.companyId !== "salam-land") return connection;
  return {
    ...connection,
    metaEnabled: true,
    metaPageId: pageId,
    metaFormIds: formIds,
    metaAccessToken: resolvedLeadToken.token,
    metaDefaultStaff: connection.metaDefaultStaff || "Nureen",
    metaLeadStatus: connection.metaLeadStatus || "New Lead",
    notes: "Salam Land Meta Page lead forms mapped direct to CRM. Blank form IDs allow all Salam Page lead forms."
  };
});

const saved = await fetchJson(`${baseUrl}/api/integrations`, {
  method: "PUT",
  token: login.token,
  body: JSON.stringify({
    ...current,
    publicBaseUrl: baseUrl,
    meta: {
      ...(current.meta || {}),
      verifyToken,
      apiVersion
    },
    connections: nextConnections
  })
});

const salam = (saved.connections || []).find((connection) => connection.companyId === "salam-land") || {};

console.log(JSON.stringify({
  ok: true,
  publicBaseUrl: saved.publicBaseUrl,
  metaApiVersion: saved.meta?.apiVersion,
  salamLand: {
    metaEnabled: Boolean(salam.metaEnabled),
    metaPageId: salam.metaPageId,
    metaFormIds: salam.metaFormIds || "",
    tokenSource: resolvedLeadToken.source,
    hasMetaToken: Boolean(salam.metaAccessToken),
    metaSpendSyncEnabled: Boolean(salam.metaSpendSyncEnabled),
    hasMetaSpendToken: Boolean(salam.metaSpendAccessToken)
  }
}, null, 2));

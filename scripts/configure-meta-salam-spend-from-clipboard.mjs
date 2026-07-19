import { execFileSync } from "node:child_process";

const baseUrl = process.env.CRM_BASE_URL || "https://salamland.my";
const username = process.env.CRM_USERNAME;
const password = process.env.CRM_PASSWORD;
const apiVersion = process.env.CRM_META_API_VERSION || "v25.0";
const adAccountId = process.env.CRM_META_AD_ACCOUNT_ID || "398314092818758";
const testAdId = process.env.CRM_META_TEST_AD_ID || "120246835800760343";

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

const spendToken = (process.env.CRM_META_SPEND_TOKEN || clipboardText()).trim().replace(/\s+/g, "");

if (!spendToken) {
  throw new Error("No Meta spend token found. Copy the Marketing API token first or set CRM_META_SPEND_TOKEN.");
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

async function verifySpendToken() {
  const adAccounts = await readGraph("me/adaccounts", spendToken, {
    fields: "id,name,account_id,account_status",
    limit: "200"
  });
  const account = (adAccounts.data || []).find((item) => String(item.account_id) === String(adAccountId));
  if (!account) {
    throw new Error(`Token cannot see ad account ${adAccountId}. Confirm FN1 access and ads_read/read_insights permission.`);
  }

  const adMeta = await readGraph(testAdId, spendToken, {
    fields: "id,name,campaign_id,campaign{name},adset_id,account_id"
  });
  if (String(adMeta.account_id || "") !== String(adAccountId)) {
    throw new Error(`Test ad belongs to ${adMeta.account_id || "unknown"}, not ${adAccountId}.`);
  }

  const insights = await readGraph(`${testAdId}/insights`, spendToken, {
    fields: "spend,impressions,clicks,campaign_id,campaign_name",
    date_preset: "today"
  });
  const row = Array.isArray(insights.data) ? insights.data[0] || {} : {};

  return {
    account: {
      id: account.id,
      name: account.name,
      accountId: account.account_id
    },
    testAd: {
      id: adMeta.id,
      name: adMeta.name,
      campaignId: adMeta.campaign_id || row.campaign_id || "",
      campaignName: adMeta.campaign?.name || row.campaign_name || "",
      spendToday: Number(row.spend || 0)
    }
  };
}

const verification = await verifySpendToken();

const login = await fetchJson(`${baseUrl}/api/auth/login`, {
  method: "POST",
  body: JSON.stringify({ username, password })
});

const current = await fetchJson(`${baseUrl}/api/integrations`, { token: login.token });
const nextConnections = (current.connections || []).map((connection) => {
  if (connection.companyId !== "salam-land") return connection;
  return {
    ...connection,
    metaSpendSyncEnabled: true,
    metaSpendAccessToken: spendToken
  };
});

const saved = await fetchJson(`${baseUrl}/api/integrations`, {
  method: "PUT",
  token: login.token,
  body: JSON.stringify({
    ...current,
    connections: nextConnections
  })
});

const salam = (saved.connections || []).find((connection) => connection.companyId === "salam-land") || {};

console.log(JSON.stringify({
  ok: true,
  verified: verification,
  salamLand: {
    metaSpendSyncEnabled: Boolean(salam.metaSpendSyncEnabled),
    hasMetaSpendToken: Boolean(salam.metaSpendAccessToken),
    hasMetaLeadToken: Boolean(salam.metaAccessToken)
  }
}, null, 2));

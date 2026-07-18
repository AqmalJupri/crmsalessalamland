const baseUrl = process.env.CRM_BASE_URL || "https://salamland.my";
const username = process.env.CRM_USERNAME;
const password = process.env.CRM_PASSWORD;
const apiVersion = process.env.CRM_META_API_VERSION || "v25.0";
const companyId = process.env.CRM_COMPANY_ID || "salam-land";
const datePreset = process.env.CRM_META_SPEND_DATE_PRESET || "this_month";
const maxAds = Number(process.env.CRM_META_SYNC_MAX_ADS || 80);

if (!username || !password) {
  throw new Error("Set CRM_USERNAME and CRM_PASSWORD before running this script.");
}

function safeNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function firstNonEmpty(...values) {
  return values.find((value) => String(value || "").trim()) || "";
}

function campaignKey(campaign) {
  return [
    campaign.externalPlatform || "",
    campaign.externalCampaignId || "",
    campaign.externalAdId || ""
  ].join(":");
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

async function fetchAdSnapshot(adId, token) {
  const [adMeta, insights] = await Promise.all([
    readGraph(adId, token, {
      fields: "id,name,campaign_id,campaign{name},adset_id,account_id"
    }),
    readGraph(`${adId}/insights`, token, {
      fields: "spend,impressions,clicks,actions,campaign_id,campaign_name",
      date_preset: datePreset
    })
  ]);
  const row = Array.isArray(insights.data) ? insights.data[0] || {} : {};
  const campaignId = firstNonEmpty(adMeta.campaign?.id, adMeta.campaign_id, row.campaign_id);
  const campaignName = firstNonEmpty(adMeta.campaign?.name, row.campaign_name, adMeta.name, `Meta ${adId}`);
  return {
    adId: String(adId),
    campaignId: String(campaignId || ""),
    campaignName: String(campaignName || ""),
    spend: safeNumber(row.spend),
    impressions: safeNumber(row.impressions),
    clicks: safeNumber(row.clicks),
    updatedAt: new Date().toISOString()
  };
}

function upsertCampaign(campaigns, snapshot) {
  const externalKey = ["meta", snapshot.campaignId, snapshot.adId].join(":");
  const existing = campaigns.find((campaign) => (
    campaign.companyId === companyId
    && campaignKey(campaign) === externalKey
  ));

  const nextCampaign = {
    ...(existing || {}),
    id: existing?.id || `camp_meta_${snapshot.adId}`,
    companyId,
    platform: "Meta Ads",
    name: snapshot.campaignName || `Meta ${snapshot.adId}`,
    spend: snapshot.spend,
    createdAt: existing?.createdAt || new Date().toISOString().slice(0, 10),
    externalPlatform: "meta",
    externalCampaignId: snapshot.campaignId,
    externalAdId: snapshot.adId,
    spendUpdatedAt: snapshot.updatedAt
  };

  if (existing) {
    return {
      campaigns: campaigns.map((campaign) => (campaign.id === existing.id ? nextCampaign : campaign)),
      campaign: nextCampaign,
      created: false
    };
  }

  return {
    campaigns: [nextCampaign, ...campaigns],
    campaign: nextCampaign,
    created: true
  };
}

const login = await fetchJson(`${baseUrl}/api/auth/login`, {
  method: "POST",
  body: JSON.stringify({ username, password })
});

const state = await fetchJson(`${baseUrl}/api/state`, { token: login.token });
const connection = (state.integrations?.connections || []).find((item) => item.companyId === companyId);
const spendToken = String(connection?.metaSpendAccessToken || "").trim();

if (!connection?.metaSpendSyncEnabled || !spendToken) {
  throw new Error("Salam Land Meta spend sync is not enabled or token is missing.");
}

const metaRecords = (state.records || []).filter((record) => (
  record.companyId === companyId
  && record.source === "Meta Ads"
  && record.details?.metaAdId
));

const adIds = [...new Set(metaRecords.map((record) => String(record.details.metaAdId)).filter(Boolean))].slice(0, maxAds);
const snapshots = new Map();
const errors = [];

for (const adId of adIds) {
  try {
    snapshots.set(adId, await fetchAdSnapshot(adId, spendToken));
  } catch (error) {
    errors.push({ adId, message: String(error?.message || error).slice(0, 180) });
  }
}

let campaigns = Array.isArray(state.campaigns) ? state.campaigns : [];
const campaignByAd = new Map();
let campaignsCreated = 0;

for (const snapshot of snapshots.values()) {
  const result = upsertCampaign(campaigns, snapshot);
  campaigns = result.campaigns;
  campaignByAd.set(snapshot.adId, result.campaign);
  if (result.created) campaignsCreated += 1;
}

let recordsUpdated = 0;
const records = (state.records || []).map((record) => {
  const adId = String(record.details?.metaAdId || "");
  const snapshot = snapshots.get(adId);
  const campaign = campaignByAd.get(adId);
  if (!snapshot || !campaign) return record;

  const nextRecord = {
    ...record,
    campaignId: campaign.id,
    details: {
      ...(record.details || {}),
      metaCampaignId: snapshot.campaignId,
      metaCampaignName: snapshot.campaignName,
      metaSpendSnapshot: snapshot.spend,
      metaSpendUpdatedAt: snapshot.updatedAt,
      metaImpressionsSnapshot: snapshot.impressions,
      metaClicksSnapshot: snapshot.clicks
    }
  };
  if (JSON.stringify(nextRecord) !== JSON.stringify(record)) recordsUpdated += 1;
  return nextRecord;
});

await fetchJson(`${baseUrl}/api/state`, {
  method: "PUT",
  token: login.token,
  body: JSON.stringify({
    ...state,
    records,
    campaigns
  })
});

console.log(JSON.stringify({
  ok: true,
  datePreset,
  adIdsSynced: snapshots.size,
  recordsUpdated,
  campaignsCreated,
  errors,
  examples: [...snapshots.values()].slice(0, 5).map((snapshot) => ({
    adId: snapshot.adId,
    campaignName: snapshot.campaignName,
    spend: snapshot.spend,
    impressions: snapshot.impressions,
    clicks: snapshot.clicks
  }))
}, null, 2));

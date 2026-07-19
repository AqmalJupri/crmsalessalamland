const baseUrl = process.env.CRM_BASE_URL || "https://salamland.my";
const username = process.env.CRM_USERNAME;
const password = process.env.CRM_PASSWORD;
const apiVersion = process.env.CRM_META_API_VERSION || "v25.0";
const companyId = "salam-land";
const pageId = process.env.CRM_META_PAGE_ID || "330336670172572";
const sinceIso = process.env.CRM_META_REPAIR_SINCE || "2026-05-08T00:00:00+08:00";
const untilIso = process.env.CRM_META_REPAIR_UNTIL || new Date().toISOString();
const leadLimitPerPage = Number(process.env.CRM_META_REPAIR_LIMIT || 100);
const datePreset = process.env.CRM_META_SPEND_DATE_PRESET || "this_month";

if (!username || !password) {
  throw new Error("Set CRM_USERNAME and CRM_PASSWORD before running this script.");
}

const staffRules = [
  { staff: "Nureen", patterns: [/\bnurin\b/, /\bnureen\b/, /\bnureen\b/] },
  { staff: "Wafi", patterns: [/\bwafi\b/] },
  { staff: "Tasha", patterns: [/\btasha\b/, /\bnatasha\b/] },
  { staff: "Sabrina", patterns: [/\bsabrina\b/, /\bsabrin\b/] },
  { staff: "Ain", patterns: [/\bain\b/] }
];

function safeNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function firstNonEmpty(...values) {
  return values.find((value) => String(value || "").trim()) || "";
}

function normalizePhone(value = "") {
  const digits = String(value || "").replace(/\D+/g, "");
  if (!digits) return "";
  if (digits.startsWith("60")) return digits;
  if (digits.startsWith("0")) return `6${digits}`;
  return digits;
}

function localIsoDate(value) {
  const date = new Date(value);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kuala_Lumpur",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${lookup.year}-${lookup.month}-${lookup.day}`;
}

function isoOffsetDate(baseDate, days) {
  const date = new Date(baseDate);
  date.setDate(date.getDate() + days);
  return localIsoDate(date);
}

function fieldMapFromArray(fields = []) {
  const map = {};
  (Array.isArray(fields) ? fields : []).forEach((field) => {
    const key = String(field.name || field.key || "").trim();
    const value = Array.isArray(field.values) ? field.values.join(", ") : field.value;
    if (key) map[key] = String(value || "").trim();
  });
  return map;
}

function pickField(map, candidates) {
  const entries = Object.entries(map || {});
  for (const candidate of candidates) {
    const normalized = candidate.toLowerCase().replace(/[^a-z0-9]+/g, "");
    const found = entries.find(([key]) => key.toLowerCase().replace(/[^a-z0-9]+/g, "") === normalized);
    if (found && String(found[1] || "").trim()) return String(found[1]).trim();
  }
  return "";
}

function inferStaff(...values) {
  const text = values
    .map((value) => String(value || "").toLowerCase())
    .join(" ")
    .replace(/[^a-z0-9]+/g, " ");
  const match = staffRules.find((rule) => rule.patterns.some((pattern) => pattern.test(text)));
  return match ? match.staff : "Nureen";
}

function isExampleRecord(record) {
  if (record.companyId !== companyId) return false;
  const name = String(record.customerName || "").toLowerCase().trim();
  const phone = String(record.phone || "").replace(/\D+/g, "");
  const source = String(record.source || "").toLowerCase();
  const demoPhones = new Set(["60123450001", "60123450002", "60123450003", "60120000000", "60120000001"]);
  const demoNames = ["azman rahim", "farah zaini", "mizi hafiz", "tiktok test lead", "tiktok form test lead"];

  return (
    !name
    || name === "lead"
    || name === "meta lead"
    || name.includes("dummy")
    || name.includes("<test lead")
    || demoNames.includes(name)
    || demoPhones.has(phone)
    || (source === "tiktok ads" && name.includes("test"))
  );
}

function campaignKey(campaign) {
  return [
    campaign.externalPlatform || "",
    campaign.externalCampaignId || "",
    campaign.externalAdId || ""
  ].join(":");
}

function parseDelimitedIds(value = "") {
  return String(value || "")
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
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

async function readGraphPages(path, token, params = {}, maxPages = 20) {
  const rows = [];
  let url = new URL(`https://graph.facebook.com/${apiVersion}/${path}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  url.searchParams.set("access_token", token);

  for (let page = 0; page < maxPages && url; page += 1) {
    const payload = await fetchJson(url.toString());
    rows.push(...(Array.isArray(payload.data) ? payload.data : []));
    url = payload.paging?.next ? new URL(payload.paging.next) : null;
  }
  return rows;
}

async function fetchAdSnapshot(adId, spendToken) {
  if (!adId || !spendToken) return null;
  const [adMeta, insights] = await Promise.all([
    readGraph(adId, spendToken, {
      fields: "id,name,campaign_id,campaign{name},adset_id,adset{name},account_id"
    }),
    readGraph(`${adId}/insights`, spendToken, {
      fields: "spend,impressions,clicks,actions,campaign_id,campaign_name",
      date_preset: datePreset
    })
  ]);
  const row = Array.isArray(insights.data) ? insights.data[0] || {} : {};
  return {
    adId: String(adId),
    adName: String(adMeta.name || ""),
    adsetName: String(adMeta.adset?.name || ""),
    campaignId: String(firstNonEmpty(adMeta.campaign?.id, adMeta.campaign_id, row.campaign_id)),
    campaignName: String(firstNonEmpty(adMeta.campaign?.name, row.campaign_name, adMeta.name, `Meta ${adId}`)),
    spend: safeNumber(row.spend),
    impressions: safeNumber(row.impressions),
    clicks: safeNumber(row.clicks),
    updatedAt: new Date().toISOString()
  };
}

function upsertCampaign(campaigns, snapshot, createdAt) {
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
    createdAt: existing?.createdAt || createdAt,
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

function buildRecord(existing, lead, snapshot, campaign) {
  const map = fieldMapFromArray(lead.field_data);
  const createdAt = lead.created_time ? localIsoDate(lead.created_time) : localIsoDate(new Date());
  const fullName = firstNonEmpty(
    pickField(map, ["full_name", "name"]),
    [pickField(map, ["first_name"]), pickField(map, ["last_name"])].filter(Boolean).join(" "),
    existing?.customerName,
    "Meta Lead"
  );
  const phone = normalizePhone(firstNonEmpty(pickField(map, ["phone_number", "phone", "mobile_number"]), existing?.phone));
  const staff = inferStaff(snapshot?.campaignName, snapshot?.adsetName, snapshot?.adName, existing?.staff);

  return {
    ...(existing || {}),
    id: existing?.id || `rec_meta_${lead.id}`,
    kind: existing?.kind || "lead",
    companyId,
    customerName: fullName,
    phone,
    source: "Meta Ads",
    campaignId: campaign?.id || existing?.campaignId || "",
    staff,
    product: firstNonEmpty(pickField(map, ["product", "produk", "jenis_tanah", "kategori", "category"]), existing?.product, "Tanah lot"),
    status: existing?.status && existing.status !== "Meta Lead" ? existing.status : "New Lead",
    createdAt,
    nextFollowUp: existing?.nextFollowUp || isoOffsetDate(lead.created_time || new Date(), 14),
    value: safeNumber(existing?.value),
    units: safeNumber(existing?.units),
    actionFlags: existing?.actionFlags || {},
    details: {
      ...(existing?.details || {}),
      ...map,
      externalPlatform: "meta",
      externalLeadId: String(lead.id || ""),
      metaPageId: String(pageId),
      metaFormId: String(lead.form_id || ""),
      metaAdId: String(lead.ad_id || ""),
      metaPlatform: String(lead.platform || ""),
      metaCampaignId: String(snapshot?.campaignId || ""),
      metaCampaignName: String(snapshot?.campaignName || ""),
      metaSpendSnapshot: safeNumber(snapshot?.spend),
      metaSpendUpdatedAt: String(snapshot?.updatedAt || ""),
      metaImpressionsSnapshot: safeNumber(snapshot?.impressions),
      metaClicksSnapshot: safeNumber(snapshot?.clicks)
    },
    notes: "Auto captured from Meta Lead Ads webhook."
  };
}

const login = await fetchJson(`${baseUrl}/api/auth/login`, {
  method: "POST",
  body: JSON.stringify({ username, password })
});

const state = await fetchJson(`${baseUrl}/api/state`, { token: login.token });
const connection = (state.integrations?.connections || []).find((item) => item.companyId === companyId);
if (!connection?.metaAccessToken) throw new Error("Salam Land Meta lead token missing.");

const leadToken = connection.metaAccessToken;
const spendToken = connection.metaSpendAccessToken || connection.metaAccessToken;
const sinceMs = new Date(sinceIso).getTime();
const untilMs = new Date(untilIso).getTime();

let forms = parseDelimitedIds(connection.metaFormIds).map((id) => ({ id, name: "Mapped Meta lead form" }));

if (!forms.length) {
  forms = await readGraphPages(`${pageId}/leadgen_forms`, leadToken, {
    fields: "id,name,status,leads_count",
    limit: "100"
  });
}

const leadsById = new Map();
for (const form of forms) {
  const leads = await readGraphPages(`${form.id}/leads`, leadToken, {
    fields: "id,created_time,ad_id,form_id,platform,field_data",
    limit: String(leadLimitPerPage)
  });
  for (const lead of leads) {
    const createdMs = new Date(lead.created_time || 0).getTime();
    if (Number.isFinite(createdMs) && createdMs >= sinceMs && createdMs <= untilMs) {
      leadsById.set(String(lead.id), { ...lead, form_id: lead.form_id || form.id });
    }
  }
}

const cleanRecords = (state.records || []).filter((record) => !isExampleRecord(record));
const removedExamples = (state.records || []).length - cleanRecords.length;
const recordByExternalLead = new Map();
cleanRecords.forEach((record) => {
  if (record.details?.externalPlatform === "meta" && record.details?.externalLeadId) {
    recordByExternalLead.set(String(record.details.externalLeadId), record);
  }
});

let campaigns = (state.campaigns || []).filter((campaign) => (
  campaign.companyId !== companyId
  || !["Tanah Lot Hulu Langat", "Site Visit Semenyih"].includes(String(campaign.name || ""))
));
let created = 0;
let updated = 0;
let campaignsCreated = 0;
const errors = [];

for (const lead of leadsById.values()) {
  let snapshot = null;
  try {
    snapshot = await fetchAdSnapshot(String(lead.ad_id || ""), spendToken);
  } catch (error) {
    errors.push({ leadId: lead.id, adId: lead.ad_id || "", message: String(error?.message || error).slice(0, 180) });
  }

  let campaign = null;
  if (snapshot) {
    const result = upsertCampaign(campaigns, snapshot, lead.created_time ? localIsoDate(lead.created_time) : localIsoDate(new Date()));
    campaigns = result.campaigns;
    campaign = result.campaign;
    if (result.created) campaignsCreated += 1;
  }

  const existing = recordByExternalLead.get(String(lead.id));
  const nextRecord = buildRecord(existing, lead, snapshot, campaign);
  if (existing) {
    const index = cleanRecords.findIndex((record) => record.id === existing.id);
    cleanRecords[index] = nextRecord;
    updated += 1;
  } else {
    cleanRecords.unshift(nextRecord);
    created += 1;
  }
}

const usedCampaignIds = new Set(cleanRecords.map((record) => record.campaignId).filter(Boolean));
campaigns = campaigns.filter((campaign) => (
  campaign.companyId !== companyId
  || campaign.externalPlatform === "meta"
  || usedCampaignIds.has(campaign.id)
));

await fetchJson(`${baseUrl}/api/state`, {
  method: "PUT",
  token: login.token,
  body: JSON.stringify({
    ...state,
    records: cleanRecords,
    campaigns
  })
});

console.log(JSON.stringify({
  ok: true,
  window: { since: sinceIso, until: untilIso },
  formsChecked: forms.length,
  metaLeadsFound: leadsById.size,
  created,
  updated,
  removedExamples,
  campaignsCreated,
  errors,
  staffBreakdown: [...leadsById.values()].reduce((acc, lead) => {
    const record = cleanRecords.find((item) => item.details?.externalLeadId === String(lead.id));
    const staff = record?.staff || "Unknown";
    acc[staff] = (acc[staff] || 0) + 1;
    return acc;
  }, {})
}, null, 2));

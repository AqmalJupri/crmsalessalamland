const fs = require("node:fs");

const RUNTIME_PATH = process.argv[2] || "data/runtime.json";
const AD_ACCOUNT_ID = String(process.argv[3] || "398314092818758").replace(/^act_/, "");
const runtime = JSON.parse(fs.readFileSync(RUNTIME_PATH, "utf8"));
const connection = runtime.integrations?.connections?.find((item) => item.companyId === "salam-land");
const token = String(connection?.metaSpendAccessToken || connection?.metaAccessToken || "").trim();
const apiVersion = runtime.integrations?.meta?.apiVersion || "v22.0";
const mappedFormIds = new Set(String(connection?.metaFormIds || "").split(/[,\n]+/).map((item) => item.trim()).filter(Boolean));

if (!connection?.metaEnabled || !token) {
  throw new Error("Salam Land Meta connection/token is not ready.");
}

async function readGraph(pathname, params = {}) {
  const url = new URL(`https://graph.facebook.com/${apiVersion}/${pathname}`);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  url.searchParams.set("access_token", token);
  const response = await fetch(url);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error?.message || `Meta API failed with HTTP ${response.status}`);
  }
  return payload;
}

function collectFormIds(value, output = new Set()) {
  if (!value || typeof value !== "object") return output;
  if (Array.isArray(value)) {
    value.forEach((item) => collectFormIds(item, output));
    return output;
  }
  for (const [key, item] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase();
    if (
      ["lead_gen_form_id", "leadgen_form_id", "lead_form_id", "form_id"].includes(normalizedKey)
      && item
      && /^\d{8,}$/.test(String(item))
    ) {
      output.add(String(item));
    }
    collectFormIds(item, output);
  }
  return output;
}

(async () => {
  const payload = await readGraph(`act_${AD_ACCOUNT_ID}/ads`, {
    fields: [
      "id",
      "name",
      "effective_status",
      "campaign_id",
      "campaign{name}",
      "creative{id,name,object_story_spec,asset_feed_spec}"
    ].join(","),
    filtering: JSON.stringify([{ field: "ad.effective_status", operator: "IN", value: ["ACTIVE"] }]),
    limit: "500"
  });

  const ads = Array.isArray(payload.data) ? payload.data : [];
  const rows = ads.map((ad) => {
    const formIds = Array.from(collectFormIds(ad.creative || {}));
    return {
      adId: ad.id || "",
      adName: ad.name || "",
      campaignId: ad.campaign_id || "",
      campaignName: ad.campaign?.name || "",
      status: ad.effective_status || "",
      formIds,
      unmappedFormIds: formIds.filter((id) => !mappedFormIds.has(id))
    };
  });

  const discoveredFormIds = Array.from(new Set(rows.flatMap((row) => row.formIds)));
  const unmappedFormIds = discoveredFormIds.filter((id) => !mappedFormIds.has(id));

  console.log(JSON.stringify({
    adAccountId: AD_ACCOUNT_ID,
    adsScanned: rows.length,
    mappedFormIds: Array.from(mappedFormIds),
    discoveredFormIds,
    unmappedFormIds,
    adsWithForms: rows.filter((row) => row.formIds.length)
  }, null, 2));
})();

const fs = require("node:fs");

const RUNTIME_PATH = process.argv[2] || "data/runtime.json";
const AD_ACCOUNT_ID = String(process.argv[3] || "398314092818758").replace(/^act_/, "");
const runtime = JSON.parse(fs.readFileSync(RUNTIME_PATH, "utf8"));
const connection = runtime.integrations?.connections?.find((item) => item.companyId === "salam-land");
const token = String(connection?.metaSpendAccessToken || connection?.metaAccessToken || "").trim();
const apiVersion = runtime.integrations?.meta?.apiVersion || "v22.0";

if (!connection?.metaEnabled || !token) {
  throw new Error("Salam Land Meta connection/token is not ready.");
}

const today = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Kuala_Lumpur",
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
}).format(new Date());

function safeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function leadActions(actions = []) {
  return (Array.isArray(actions) ? actions : [])
    .filter((action) => String(action.action_type || "").toLowerCase().includes("lead"))
    .map((action) => ({
      actionType: action.action_type,
      value: safeNumber(action.value)
    }));
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

(async () => {
  const payload = await readGraph(`act_${AD_ACCOUNT_ID}/insights`, {
    fields: "campaign_id,campaign_name,spend,actions,cost_per_action_type",
    level: "campaign",
    time_range: JSON.stringify({ since: today, until: today }),
    action_report_time: "conversion",
    action_attribution_windows: JSON.stringify(["7d_click", "1d_view"]),
    limit: "200"
  });

  const rows = Array.isArray(payload.data) ? payload.data : [];
  const campaigns = rows
    .map((row) => ({
      campaignId: row.campaign_id || "",
      campaignName: row.campaign_name || "",
      spend: safeNumber(row.spend),
      leadActions: leadActions(row.actions)
    }))
    .filter((row) => row.leadActions.some((action) => action.value > 0) || row.spend > 0);
  const totalLeadActions = campaigns.reduce((sum, row) => (
    sum + row.leadActions.reduce((leadSum, action) => leadSum + action.value, 0)
  ), 0);

  console.log(JSON.stringify({
    todayMalaysia: today,
    adAccountId: AD_ACCOUNT_ID,
    attribution: "7d_click + 1d_view, conversion report time",
    totalLeadActions,
    campaigns
  }, null, 2));
})();

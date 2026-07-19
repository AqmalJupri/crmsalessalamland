const fs = require("node:fs");
const path = require("node:path");

const runtimePath = path.join(process.cwd(), "data", "runtime.json");
const backupDir = path.join(process.cwd(), "data", "backups");

const SALAM_TIKTOK = {
  advertiserId: "7627145984715374610",
  formIds: "7636799561561800967",
  callbackToken: "crm-salam-fortress-tiktok"
};

function createId(prefix = "id") {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function main() {
  const runtime = JSON.parse(fs.readFileSync(runtimePath, "utf8"));
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  fs.writeFileSync(path.join(backupDir, `runtime-before-tiktok-salam-ready-${stamp}.json`), JSON.stringify(runtime, null, 2));

  runtime.integrations = runtime.integrations || {};
  runtime.integrations.publicBaseUrl = "https://salamland.my";
  runtime.integrations.tiktok = {
    ...(runtime.integrations.tiktok || {}),
    callbackToken: SALAM_TIKTOK.callbackToken,
    leadRetentionDays: 90
  };
  runtime.integrations.connections = (runtime.integrations.connections || []).map((connection) => {
    if (connection.companyId !== "salam-land") {
      return {
        ...connection,
        tiktokEnabled: false
      };
    }
    return {
      ...connection,
      tiktokEnabled: true,
      tiktokAdvertiserId: SALAM_TIKTOK.advertiserId,
      tiktokFormIds: SALAM_TIKTOK.formIds,
      tiktokLeadMode: "instant-form",
      tiktokSpendSyncEnabled: true,
      tiktokCallbackToken: SALAM_TIKTOK.callbackToken,
      tiktokDefaultStaff: connection.tiktokDefaultStaff || "Nureen",
      tiktokLeadStatus: connection.tiktokLeadStatus || "New Lead",
      notes: "Salam Land TikTok instant form mapped. Platform-side TikTok lead delivery still needs TikTok custom API/lead webhook approval."
    };
  });
  runtime.control = runtime.control || {};
  runtime.control.activity = [
    {
      id: createId("act"),
      at: new Date().toISOString(),
      actor: "System",
      role: "system",
      companyId: "salam-land",
      action: "TikTok Salam ready",
      detail: "Salam TikTok advertiser/form mapped to CRM webhook. Bumi Hayat and Barakah remain off by request.",
      severity: "info"
    },
    ...(runtime.control.activity || [])
  ].slice(0, 80);
  runtime.updatedAt = new Date().toISOString();

  fs.writeFileSync(runtimePath, JSON.stringify(runtime, null, 2));
  console.log(JSON.stringify({
    ok: true,
    salamTikTokEnabled: true,
    advertiserId: SALAM_TIKTOK.advertiserId,
    formIds: SALAM_TIKTOK.formIds
  }, null, 2));
}

main();

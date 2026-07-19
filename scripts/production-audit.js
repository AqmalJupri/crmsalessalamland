const fs = require("node:fs");
const path = require("node:path");

const root = process.cwd();
const runtimePath = process.argv[2] || path.join(root, "data", "runtime.json");
const authPath = process.argv[3] || path.join(root, "data", "auth.json");
const backupDir = path.join(path.dirname(runtimePath), "backups");
const pushPath = path.join(path.dirname(runtimePath), "push-subscriptions.json");

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function normalizePhone(value) {
  return String(value || "").replace(/[^\d]/g, "");
}

function walkObject(value, visitor, trail = []) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkObject(item, visitor, [...trail, index]));
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    visitor(key, item, [...trail, key]);
    walkObject(item, visitor, [...trail, key]);
  }
}

function countBackups() {
  try {
    return fs.readdirSync(backupDir).filter((name) => /\.(json|tgz)$/i.test(name)).length;
  } catch {
    return 0;
  }
}

function audit() {
  const runtime = readJson(runtimePath, {});
  const auth = readJson(authPath, {});
  const push = readJson(pushPath, { subscriptions: [] });
  const records = Array.isArray(runtime.records) ? runtime.records : [];
  const connections = runtime.integrations?.connections || [];
  const issues = [];
  const warnings = [];

  const salamTikTok = connections.find((item) => item.companyId === "salam-land");
  if (!runtime.integrations?.publicBaseUrl) warnings.push("Public base URL belum diset dalam runtime.");
  if (!salamTikTok?.tiktokEnabled) issues.push("TikTok Salam belum enabled dalam CRM runtime.");
  if (!String(salamTikTok?.tiktokAdvertiserId || "").trim()) issues.push("TikTok Salam advertiser ID kosong.");
  if (!String(salamTikTok?.tiktokFormIds || "").trim()) warnings.push("TikTok Salam form ID kosong atau belum approved.");
  if (!String(runtime.integrations?.tiktok?.callbackToken || "").trim()) issues.push("TikTok callback token kosong.");

  const oldStaff = records.filter((record) => String(record.staff || "").toLowerCase() === "nurin").length;
  if (oldStaff) issues.push(`${oldStaff} record masih guna nama lama Nurin.`);

  let nextPaymentFieldCount = 0;
  walkObject(runtime, (key) => {
    if (key === "nextPaymentDate") nextPaymentFieldCount += 1;
  });
  if (nextPaymentFieldCount) issues.push(`${nextPaymentFieldCount} field nextPaymentDate lama masih wujud.`);

  const visibleOrders = records.filter((record) => record.kind === "order" && !record.archived);
  const duplicateKeys = new Map();
  for (const record of visibleOrders) {
    const details = record.details || {};
    const key = [
      record.companyId,
      String(record.customerName || "").trim().toLowerCase(),
      normalizePhone(record.phone),
      String(details.landLotNo || details.landLot || details.lotNo || "").trim().toLowerCase(),
      String(record.product || "").trim().toLowerCase()
    ].join("|");
    duplicateKeys.set(key, (duplicateKeys.get(key) || 0) + 1);
  }
  const duplicateOrders = [...duplicateKeys.values()].filter((count) => count > 1).length;
  if (duplicateOrders) issues.push(`${duplicateOrders} visible duplicate order key dikesan.`);

  const phaseProblems = [];
  for (const record of visibleOrders) {
    const schedule = Array.isArray(record.details?.paymentSchedule) ? record.details.paymentSchedule : [];
    for (const phase of schedule) {
      if (!String(phase.paymentDate || "").trim()) {
        phaseProblems.push(record.id);
        break;
      }
    }
  }
  if (phaseProblems.length) issues.push(`${phaseProblems.length} order ada payment phase tanpa paymentDate.`);

  const metaConnections = connections.filter((item) => item.metaEnabled);
  const metaWithoutToken = metaConnections.filter((item) => !String(item.metaAccessToken || "").trim()).length;
  if (metaWithoutToken) warnings.push(`${metaWithoutToken} Meta connection enabled tetapi token kosong.`);

  return {
    ok: issues.length === 0,
    generatedAt: new Date().toISOString(),
    counts: {
      records: records.length,
      visibleOrders: visibleOrders.length,
      campaigns: Array.isArray(runtime.campaigns) ? runtime.campaigns.length : 0,
      inboundEvents: runtime.integrations?.inboundEvents?.length || 0,
      backupFiles: countBackups(),
      pushSubscriptions: Array.isArray(push.subscriptions) ? push.subscriptions.length : 0,
      authUsers: Array.isArray(auth.users) ? auth.users.length : 0,
      metaConnections: metaConnections.length,
      tiktokConnections: connections.filter((item) => item.tiktokEnabled).length
    },
    tiktokSalam: {
      enabled: Boolean(salamTikTok?.tiktokEnabled),
      advertiserId: String(salamTikTok?.tiktokAdvertiserId || ""),
      formIds: String(salamTikTok?.tiktokFormIds || ""),
      defaultStaff: String(salamTikTok?.tiktokDefaultStaff || ""),
      leadStatus: String(salamTikTok?.tiktokLeadStatus || ""),
      connectorEndpoint: `${runtime.integrations?.publicBaseUrl || "https://salamland.my"}/api/webhooks/tiktok/connector`
    },
    issues,
    warnings
  };
}

const result = audit();
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);

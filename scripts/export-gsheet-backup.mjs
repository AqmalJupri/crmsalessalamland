import fs from "node:fs";
import path from "node:path";

const [runtimePath, authPath, outputDir] = process.argv.slice(2);

if (!runtimePath || !authPath || !outputDir) {
  console.error("Usage: node scripts/export-gsheet-backup.mjs <runtime.json> <auth.json> <output-dir>");
  process.exit(1);
}

const runtime = JSON.parse(fs.readFileSync(runtimePath, "utf8"));
const auth = JSON.parse(fs.readFileSync(authPath, "utf8"));

fs.mkdirSync(outputDir, { recursive: true });

function csvEscape(value) {
  if (value === null || value === undefined) return "";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function writeCsv(fileName, headers, rows) {
  const lines = [
    headers.map(csvEscape).join(","),
    ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(","))
  ];
  fs.writeFileSync(path.join(outputDir, fileName), `${lines.join("\n")}\n`);
}

const records = Array.isArray(runtime.records) ? runtime.records : [];
writeCsv("records.csv", [
  "id",
  "kind",
  "companyId",
  "customerName",
  "phone",
  "source",
  "campaignId",
  "staff",
  "product",
  "status",
  "createdAt",
  "nextFollowUp",
  "value",
  "units",
  "notes",
  "details"
], records.map((record) => ({
  ...record,
  details: record.details || {}
})));

const campaigns = Array.isArray(runtime.campaigns) ? runtime.campaigns : [];
writeCsv("campaigns.csv", [
  "id",
  "companyId",
  "platform",
  "name",
  "spend",
  "createdAt",
  "externalPlatform",
  "externalCampaignId",
  "externalAdId",
  "spendUpdatedAt"
], campaigns);

const users = Array.isArray(auth.users) ? auth.users : [];
writeCsv("users.csv", [
  "profileId",
  "username",
  "name",
  "role",
  "companyId",
  "companyIds",
  "staffName",
  "title",
  "mustChangePassword"
], users.map((user) => ({
  ...user,
  companyIds: Array.isArray(user.companyIds) ? user.companyIds.join("|") : ""
})));

const connections = runtime.integrations?.connections || [];
writeCsv("integrations_connections.csv", [
  "companyId",
  "metaEnabled",
  "metaPageId",
  "metaFormIds",
  "metaCampaignId",
  "metaSpendSyncEnabled",
  "metaDefaultStaff",
  "metaLeadStatus",
  "tiktokEnabled",
  "tiktokAdvertiserId",
  "tiktokFormIds",
  "tiktokCampaignId",
  "tiktokSpendSyncEnabled",
  "tiktokLeadMode",
  "tiktokDefaultStaff",
  "tiktokLeadStatus",
  "notes"
], connections);

const inboundEvents = runtime.integrations?.inboundEvents || [];
writeCsv("inbound_events.csv", [
  "id",
  "source",
  "status",
  "summary",
  "createdAt",
  "payload"
], inboundEvents.map((event) => ({
  ...event,
  payload: event.payload || {}
})));

const goldRates = runtime.goldRates || {};
writeCsv("gold_rates.csv", [
  "status",
  "sourceMode",
  "fetchedAt",
  "updatedAt",
  "fxDate",
  "ounceUsd",
  "usdMyr",
  "gram999",
  "gram916",
  "error"
], [goldRates]);

const manifest = {
  exportedAt: new Date().toISOString(),
  runtimePath,
  authPath,
  records: records.length,
  campaigns: campaigns.length,
  users: users.length,
  publicBaseUrl: runtime.integrations?.publicBaseUrl || "",
  files: [
    "records.csv",
    "campaigns.csv",
    "users.csv",
    "integrations_connections.csv",
    "inbound_events.csv",
    "gold_rates.csv"
  ]
};

fs.writeFileSync(path.join(outputDir, "manifest.json"), JSON.stringify(manifest, null, 2));

console.log(JSON.stringify(manifest, null, 2));

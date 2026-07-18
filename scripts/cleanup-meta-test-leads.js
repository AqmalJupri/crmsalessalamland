const fs = require("node:fs");

const RUNTIME_PATH = process.argv[2] || "data/runtime.json";
const runtime = JSON.parse(fs.readFileSync(RUNTIME_PATH, "utf8"));

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim()) {
      return String(value).trim();
    }
  }
  return "";
}

function sortTimestamp(record) {
  const exactTime = firstNonEmptyString(record.details?.metaCreatedTime, record.details?.tiktokCreatedTime);
  if (exactTime) {
    const exact = new Date(exactTime).getTime();
    if (Number.isFinite(exact)) return exact;
  }
  const dateOnly = String(record.createdAt || "").slice(0, 10);
  const date = new Date(`${dateOnly || "1970-01-01"}T00:00:00+08:00`).getTime();
  return Number.isFinite(date) ? date : 0;
}

function isMetaTestRecord(record) {
  const name = String(record.customerName || "").toLowerCase();
  const details = record.details || {};
  return details.externalPlatform === "meta" && (name.includes("<test lead:") || name.includes("dummy data for"));
}

const before = runtime.records.length;
runtime.records = runtime.records
  .filter((record) => !isMetaTestRecord(record))
  .sort((a, b) => sortTimestamp(b) - sortTimestamp(a));
runtime.updatedAt = new Date().toISOString();

fs.writeFileSync(RUNTIME_PATH, `${JSON.stringify(runtime, null, 2)}\n`);

console.log(JSON.stringify({
  removed: before - runtime.records.length,
  records: runtime.records.length,
  updatedAt: runtime.updatedAt
}, null, 2));

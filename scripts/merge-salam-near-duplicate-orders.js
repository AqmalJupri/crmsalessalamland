const fs = require("node:fs");
const path = require("node:path");

const runtimePath = path.join(process.cwd(), "data", "runtime.json");
const backupDir = path.join(process.cwd(), "data", "backups");

function createId(prefix = "id") {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizePhone(phone = "") {
  const digits = String(phone || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("60")) return digits;
  if (digits.startsWith("0")) return `6${digits}`;
  return digits;
}

function normalizeText(value = "") {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function numeric(value) {
  return Number(value || 0);
}

function scheduleScore(record) {
  const schedule = record.details?.paymentSchedule;
  return Array.isArray(schedule) ? schedule.length : 0;
}

function recordScore(record) {
  const details = record.details || {};
  const lotScore = String(details.lotNo || "").trim().length * 1000000;
  const noteScore = String(record.notes || "").trim().length * 1000;
  const schedule = scheduleScore(record) * 100000000;
  const attachmentScore = Array.isArray(record.attachments) ? record.attachments.length * 10000000 : 0;
  const updated = Date.parse(record.updatedAt || record.createdAt || "") || 0;
  return schedule + attachmentScore + lotScore + noteScore + (updated / 1000000000000);
}

function isActiveSalamOrder(record) {
  if (record.companyId !== "salam-land") return false;
  if (record.kind !== "order") return false;
  if (record.details?.archivedDuplicate) return false;
  if (String(record.status || "").toLowerCase() === "lost") return false;
  return Boolean(normalizePhone(record.phone) || normalizeText(record.customerName));
}

function duplicateKey(record) {
  const phone = normalizePhone(record.phone);
  const customer = normalizeText(record.customerName);
  const staff = normalizeText(record.staff);
  const value = String(numeric(record.value || record.details?.landPrice || 0));
  return [phone || customer, staff, value].join("|");
}

function main() {
  const runtime = JSON.parse(fs.readFileSync(runtimePath, "utf8"));
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  fs.writeFileSync(path.join(backupDir, `runtime-before-salam-near-duplicate-${stamp}.json`), JSON.stringify(runtime, null, 2));

  const groups = new Map();
  (runtime.records || []).filter(isActiveSalamOrder).forEach((record) => {
    const key = duplicateKey(record);
    if (!key || key.startsWith("|")) return;
    groups.set(key, [...(groups.get(key) || []), record]);
  });

  let archived = 0;
  groups.forEach((records) => {
    if (records.length < 2) return;
    const sorted = records.slice().sort((a, b) => recordScore(b) - recordScore(a));
    const keeper = sorted[0];
    keeper.details = keeper.details || {};
    delete keeper.details.archivedDuplicate;
    delete keeper.details.duplicateOf;
    delete keeper.details.duplicateArchivedAt;
    delete keeper.details.duplicateReason;

    sorted.slice(1).forEach((duplicate) => {
      duplicate.details = duplicate.details || {};
      duplicate.details.archivedDuplicate = true;
      duplicate.details.duplicateOf = keeper.id;
      duplicate.details.duplicateArchivedAt = new Date().toISOString();
      duplicate.details.duplicateReason = "Near duplicate Salam Land order: same customer/phone, staff and value. Kept the most complete order record.";
      duplicate.updatedAt = new Date().toISOString();
      archived += 1;
    });
  });

  runtime.updatedAt = new Date().toISOString();
  runtime.control = runtime.control || {};
  runtime.control.activity = [
    {
      id: createId("act"),
      at: new Date().toISOString(),
      actor: "System",
      role: "system",
      companyId: "salam-land",
      action: "Salam duplicate merge",
      detail: `${archived} near duplicate order archived. Kept the most complete booking record.`,
      severity: archived ? "warning" : "info"
    },
    ...(runtime.control.activity || [])
  ].slice(0, 80);

  fs.writeFileSync(runtimePath, JSON.stringify(runtime, null, 2));
  console.log(JSON.stringify({ archived }, null, 2));
}

main();

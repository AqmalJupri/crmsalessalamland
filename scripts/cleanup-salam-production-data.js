const fs = require("node:fs");
const path = require("node:path");

const runtimePath = path.join(process.cwd(), "data", "runtime.json");
const backupDir = path.join(process.cwd(), "data", "backups");

const SALAM_PROJECT_HINTS = [
  { pattern: /\b(WT|WAKAF\s*TAPAI)\b/i, label: "Wakaf Tapai, Marang" },
  { pattern: /\b(SI|SUNGAI\s*IKAN|SETIU)\b/i, label: "Sungai Ikan, Setiu" },
  { pattern: /\bSMK\b/i, label: "SMK Wakaf Tapai, Marang" },
  { pattern: /\b(GM|GEMURUH)\b/i, label: "Lot Banglo Gemuruh" },
  { pattern: /\b(CC|CHERANG\s*CHINA)\b/i, label: "Cherang China" },
  { pattern: /\b(PG|PASIR\s*GAJAH|KEMAMAN)\b/i, label: "Pasir Gajah, Kemaman" },
  { pattern: /\b(HL|HULU\s*LANGAT)\b/i, label: "Hulu Langat" },
  { pattern: /\b(P-?08|SEMENYIH)\b/i, label: "Semenyih" }
];

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

function cleanProject(value = "") {
  const label = String(value || "").trim();
  if (!label) return "";
  if (/tanah\s*\/\s*daerah belum diisi/i.test(label)) return "";
  if (/^belum diisi$/i.test(label)) return "";
  if (/^project belum dipilih$/i.test(label)) return "";
  return label;
}

function inferProject(...values) {
  const text = values.filter(Boolean).join(" ");
  return SALAM_PROJECT_HINTS.find((item) => item.pattern.test(text))?.label || "";
}

function normalizeProduct(record) {
  const details = record.details || {};
  const text = [
    record.product,
    details.metaCampaignName,
    details.tiktokCampaignName,
    details.lotNo,
    record.notes
  ].filter(Boolean).join(" ").toLowerCase();
  if (/kedai|shop|commercial/.test(text)) return "Lot Kedai";
  if (/banglo|bungalow/.test(text)) return "Tanah Banglo";
  return "Tanah Lot Semi D";
}

function cleanNote(value = "") {
  return String(value || "")
    .replace(/^Quick\s+(booking|close)\s+dari\s+Lot\s+Status\s+Board\.\s*/i, "")
    .trim();
}

function activeSalamOrder(record) {
  return record.companyId === "salam-land"
    && record.kind === "order"
    && !record.details?.archivedDuplicate
    && String(record.status || "").toLowerCase() !== "lost";
}

function duplicateKey(record) {
  const details = record.details || {};
  const phone = normalizePhone(record.phone);
  const lot = String(details.lotNo || "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!phone || !lot) return "";
  return `${phone}|${lot}`;
}

function completenessScore(record) {
  const details = record.details || {};
  const scheduleScore = Array.isArray(details.paymentSchedule) ? details.paymentSchedule.length * 1000000 : 0;
  const attachmentScore = Array.isArray(record.attachments) ? record.attachments.length * 100000 : 0;
  const valueScore = Number(record.value || details.landPrice || 0);
  const noteScore = String(record.notes || "").length;
  const updatedScore = Date.parse(record.updatedAt || record.createdAt || "") || 0;
  return scheduleScore + attachmentScore + valueScore + noteScore + updatedScore / 1000000000000;
}

function main() {
  const runtime = JSON.parse(fs.readFileSync(runtimePath, "utf8"));
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  fs.writeFileSync(path.join(backupDir, `runtime-before-salam-production-cleanup-${stamp}.json`), JSON.stringify(runtime, null, 2));

  let normalized = 0;
  let archivedDuplicates = 0;
  const groups = new Map();

  runtime.records = (runtime.records || []).map((record) => {
    if (record.companyId !== "salam-land") return record;
    const before = JSON.stringify(record);
    record.details = record.details || {};
    record.product = normalizeProduct(record);
    record.notes = cleanNote(record.notes);

    const inferred = cleanProject(record.details.projectLocation)
      || cleanProject(record.details.location)
      || inferProject(record.details.lotNo, record.details.metaCampaignName, record.details.tiktokCampaignName, record.product, record.notes);

    if (inferred) {
      record.details.projectLocation = inferred;
      record.details.location = cleanProject(record.details.location) || inferred;
    } else {
      if (!cleanProject(record.details.projectLocation)) delete record.details.projectLocation;
      if (!cleanProject(record.details.location)) delete record.details.location;
    }

    if (/Quick\s+(booking|close)\s+dari\s+Lot\s+Status\s+Board/i.test(record.details.systemNote || "")) {
      record.details.systemNote = String(record.details.systemNote || "").replace(/dari\s+Lot\s+Status\s+Board/i, "shortcut").trim();
    }

    if (JSON.stringify(record) !== before) {
      record.updatedAt = new Date().toISOString();
      normalized += 1;
    }

    if (activeSalamOrder(record)) {
      const key = duplicateKey(record);
      if (key) groups.set(key, [...(groups.get(key) || []), record]);
    }
    return record;
  });

  groups.forEach((records) => {
    if (records.length < 2) return;
    const [keeper, ...duplicates] = records.slice().sort((a, b) => completenessScore(b) - completenessScore(a));
    keeper.details = keeper.details || {};
    delete keeper.details.archivedDuplicate;
    delete keeper.details.duplicateOf;
    duplicates.forEach((duplicate) => {
      duplicate.details = duplicate.details || {};
      duplicate.details.archivedDuplicate = true;
      duplicate.details.duplicateOf = keeper.id;
      duplicate.details.duplicateArchivedAt = new Date().toISOString();
      duplicate.details.duplicateReason = "Duplicate Salam order: same phone and same lot. Use the keeper record for payment phase updates.";
      duplicate.updatedAt = new Date().toISOString();
      archivedDuplicates += 1;
    });
  });

  runtime.control = runtime.control || {};
  runtime.control.activity = [
    {
      id: createId("act"),
      at: new Date().toISOString(),
      actor: "System",
      role: "system",
      companyId: "salam-land",
      action: "Salam production cleanup",
      detail: `${normalized} Salam records normalized, ${archivedDuplicates} duplicate same-lot orders archived.`,
      severity: archivedDuplicates ? "warning" : "info"
    },
    ...(runtime.control.activity || [])
  ].slice(0, 80);
  runtime.updatedAt = new Date().toISOString();

  fs.writeFileSync(runtimePath, JSON.stringify(runtime, null, 2));
  console.log(JSON.stringify({ normalized, archivedDuplicates }, null, 2));
}

main();

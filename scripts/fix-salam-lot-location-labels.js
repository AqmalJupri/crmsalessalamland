const fs = require("node:fs");
const path = require("node:path");

const runtimePath = path.join(process.cwd(), "data", "runtime.json");
const backupDir = path.join(process.cwd(), "data", "backups");

const LOT_LOCATION_HINTS = [
  { pattern: /^WT|WAKAF/i, label: "Wakaf Tapai, Marang" },
  { pattern: /^SI|SUNGAI\s*IKAN/i, label: "Sungai Ikan, Setiu" },
  { pattern: /^SMK/i, label: "SMK Wakaf Tapai, Marang" },
  { pattern: /^GM/i, label: "Gemuruh" },
  { pattern: /^CC/i, label: "Cherang China" },
  { pattern: /^PG/i, label: "Pasir Gajah, Kemaman" },
  { pattern: /^HL/i, label: "Hulu Langat" },
  { pattern: /^P-08/i, label: "Semenyih" }
];

function inferLocation(record) {
  const details = record.details || {};
  const known = String(details.projectLocation || details.location || "").trim();
  if (known && known !== "-" && known !== "Belum diisi") return known;
  const lot = String(details.lotNo || "").trim();
  const campaign = String(details.metaCampaignName || details.tiktokCampaignName || record.product || "").trim();
  const text = `${lot} ${campaign}`;
  const hint = LOT_LOCATION_HINTS.find((item) => item.pattern.test(text));
  if (hint) return hint.label;
  return "";
}

function main() {
  const runtime = JSON.parse(fs.readFileSync(runtimePath, "utf8"));
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  fs.writeFileSync(path.join(backupDir, `runtime-before-lot-location-labels-${stamp}.json`), JSON.stringify(runtime, null, 2));

  let updated = 0;
  runtime.records = (runtime.records || []).map((record) => {
    if (record.companyId !== "salam-land" || record.kind !== "order" || !record.details?.lotNo) return record;
    record.details = record.details || {};
    const nextLabel = inferLocation(record);
    if ((!record.details.projectLocation || record.details.projectLocation === "-" || record.details.projectLocation === "Belum diisi") && nextLabel) {
      record.details.projectLocation = nextLabel;
      record.details.location = record.details.location && record.details.location !== "-" ? record.details.location : nextLabel;
      record.updatedAt = new Date().toISOString();
      updated += 1;
    } else if (/tanah\s*\/\s*daerah belum diisi/i.test(record.details.projectLocation || record.details.location || "")) {
      delete record.details.projectLocation;
      delete record.details.location;
      record.updatedAt = new Date().toISOString();
      updated += 1;
    }
    return record;
  });

  runtime.updatedAt = new Date().toISOString();
  fs.writeFileSync(runtimePath, JSON.stringify(runtime, null, 2));
  console.log(JSON.stringify({ updated }, null, 2));
}

main();

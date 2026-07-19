const fs = require("node:fs");
const path = require("node:path");

const root = process.cwd();
const runtimePath = path.join(root, "data", "runtime.json");
const backupDir = path.join(root, "data", "backups");

function createId(prefix = "id") {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function todayIso() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kuala_Lumpur" }).format(new Date());
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

function normalizeSchedule(schedule = []) {
  return (Array.isArray(schedule) ? schedule : []).map((phase, index) => ({
    id: phase.id || createId("pay"),
    label: String(phase.label || (index === 0 ? "Deposit" : `Pay ${index}`)).trim(),
    amount: numeric(phase.amount),
    dueDate: String(phase.dueDate || "").slice(0, 10),
    status: ["Paid", "Unpaid", "Partial"].includes(phase.status) ? phase.status : "Unpaid",
    paidDate: String(phase.paidDate || "").slice(0, 10),
    reference: String(phase.reference || "").trim(),
    remark: String(phase.remark || "").trim()
  })).filter((phase) => phase.label || phase.amount || phase.dueDate || phase.reference || phase.remark);
}

function summarizeSchedule(schedule = [], totalValue = 0) {
  const normalized = normalizeSchedule(schedule);
  const totalPaid = normalized.reduce((sum, phase) => sum + (phase.status === "Paid" || phase.status === "Partial" ? numeric(phase.amount) : 0), 0);
  const balance = Math.max(0, numeric(totalValue) - totalPaid);
  const nextPhase = normalized
    .filter((phase) => phase.status !== "Paid" && phase.dueDate)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0]
    || normalized.find((phase) => phase.status !== "Paid")
    || null;
  return {
    schedule: normalized,
    totalPaid,
    balance,
    nextPaymentDate: nextPhase?.dueDate || "",
    nextPaymentAmount: nextPhase ? numeric(nextPhase.amount) : 0,
    nextPaymentLabel: nextPhase?.label || "",
    overdueCount: normalized.filter((phase) => phase.status !== "Paid" && phase.dueDate && phase.dueDate < todayIso()).length,
    paymentStatus: balance <= 0 && numeric(totalValue) > 0 ? "Paid" : totalPaid > 0 ? "Partial" : "Unpaid"
  };
}

function cleanupSystemRemark(notes = "") {
  return String(notes || "")
    .replace(/^Quick booking dari Lot Status Board\.\s*/i, "")
    .replace(/^Quick close dari Lot Status Board\.\s*/i, "")
    .trim();
}

function orderKey(record) {
  const details = record.details || {};
  const phone = normalizePhone(record.phone);
  const product = normalizeText(record.product);
  const staff = normalizeText(record.staff);
  const lot = normalizeText(details.lotNo || details.itemName || details.designName || "");
  if (!phone) return "";
  return [record.companyId, phone, product, staff, lot].join("|");
}

function orderScore(record, valueFrequency = 1) {
  const details = record.details || {};
  const scheduleLength = Array.isArray(details.paymentSchedule) ? details.paymentSchedule.length : 0;
  const noteLength = String(record.notes || "").length;
  const updatedTime = Date.parse(record.updatedAt || record.createdAt || "") || 0;
  const attachmentScore = Array.isArray(record.attachments) ? record.attachments.length : 0;
  return (valueFrequency * 1000000000000)
    + (scheduleLength * 1000000000)
    + (attachmentScore * 1000000)
    + noteLength
    + updatedTime / 1000000000000;
}

function migratePayment(record) {
  if (record.kind !== "order") return false;
  record.details = record.details || {};
  const details = record.details;
  const totalValue = numeric(record.value || details.landPrice || details.quoteAmount || 0)
    || (numeric(details.pricePerGram || 0) * numeric(details.grams || 0));
  let schedule = normalizeSchedule(details.paymentSchedule);

  if (!schedule.length) {
    const paid = numeric(details.paidAmount)
      || numeric(details.bookingAmount) + numeric(details.depositAmount) + numeric(details.installmentAmount);
    const safeNextPaymentDate = String(details.nextPaymentDate || "").slice(0, 10);
    const legacyNextPaymentDate = safeNextPaymentDate && safeNextPaymentDate >= String(record.createdAt || "").slice(0, 10)
      ? safeNextPaymentDate
      : "";
    if (paid) {
      schedule = normalizeSchedule([
        {
          id: createId("pay"),
          label: details.bookingAmount ? "Booking" : details.depositAmount ? "Deposit" : "Paid amount",
          amount: paid,
          dueDate: String(record.createdAt || todayIso()).slice(0, 10),
          status: "Paid",
          paidDate: String(record.createdAt || todayIso()).slice(0, 10),
          reference: details.paymentReference || "",
          remark: "Auto migrated from legacy payment fields"
        },
        totalValue > paid ? {
          id: createId("pay"),
          label: "Balance",
          amount: Math.max(0, totalValue - paid),
          dueDate: legacyNextPaymentDate,
          status: "Unpaid",
          paidDate: "",
          reference: "",
          remark: "Auto balance"
        } : null
      ].filter(Boolean));
    }
  }

  schedule = schedule.map((phase) => {
    const createdAt = String(record.createdAt || "").slice(0, 10);
    if (phase.status !== "Paid" && phase.dueDate && createdAt && phase.dueDate < createdAt) {
      return {
        ...phase,
        dueDate: "",
        remark: phase.remark || "Old next payment date cleared during cleanup"
      };
    }
    return phase;
  });

  const summary = summarizeSchedule(schedule, totalValue);
  const before = JSON.stringify({
    paymentSchedule: details.paymentSchedule,
    totalPaid: details.totalPaid,
    balanceDue: details.balanceDue,
    nextPaymentDate: details.nextPaymentDate,
    paymentStatus: details.paymentStatus,
    notes: record.notes
  });
  if (schedule.length) {
    details.paymentSchedule = summary.schedule;
    details.totalPaid = summary.totalPaid;
    details.balanceDue = summary.balance;
    details.nextPaymentDate = summary.nextPaymentDate;
    details.nextPaymentAmount = summary.nextPaymentAmount;
    details.nextPaymentLabel = summary.nextPaymentLabel;
    details.overdueCount = summary.overdueCount;
    details.paymentStatus = summary.paymentStatus;
  }
  record.notes = cleanupSystemRemark(record.notes);
  const after = JSON.stringify({
    paymentSchedule: details.paymentSchedule,
    totalPaid: details.totalPaid,
    balanceDue: details.balanceDue,
    nextPaymentDate: details.nextPaymentDate,
    paymentStatus: details.paymentStatus,
    notes: record.notes
  });
  return before !== after;
}

function main() {
  const runtime = JSON.parse(fs.readFileSync(runtimePath, "utf8"));
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  fs.writeFileSync(path.join(backupDir, `runtime-before-major-clean-${stamp}.json`), JSON.stringify(runtime, null, 2));

  let migratedPayments = 0;
  let archivedDuplicates = 0;
  const groups = new Map();

  runtime.records = (runtime.records || []).map((record) => {
    if (migratePayment(record)) migratedPayments += 1;
    return record;
  });

  runtime.records.forEach((record) => {
    if (record.kind !== "order") return;
    const key = orderKey(record);
    if (!key) return;
    groups.set(key, [...(groups.get(key) || []), record]);
  });

  groups.forEach((records) => {
    if (records.length < 2) return;
    const valueFrequency = records.reduce((map, record) => {
      const valueKey = String(numeric(record.value));
      map.set(valueKey, (map.get(valueKey) || 0) + 1);
      return map;
    }, new Map());
    const sorted = records.slice().sort((a, b) => {
      const scoreB = orderScore(b, valueFrequency.get(String(numeric(b.value))) || 1);
      const scoreA = orderScore(a, valueFrequency.get(String(numeric(a.value))) || 1);
      return scoreB - scoreA;
    });
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
      duplicate.details.duplicateReason = "Same company, phone, staff, product and lot detected during major update.";
      duplicate.updatedAt = new Date().toISOString();
      archivedDuplicates += 1;
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
      action: "Major order cleanup",
      detail: `${migratedPayments} payment record migrated, ${archivedDuplicates} duplicate order archived.`,
      severity: "info"
    },
    ...(runtime.control.activity || [])
  ].slice(0, 80);

  fs.writeFileSync(runtimePath, JSON.stringify(runtime, null, 2));
  console.log(JSON.stringify({ migratedPayments, archivedDuplicates }, null, 2));
}

main();

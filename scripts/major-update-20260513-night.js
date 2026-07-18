const fs = require("node:fs");

const RUNTIME_PATH = process.argv[2] || "data/runtime.json";
const runtime = JSON.parse(fs.readFileSync(RUNTIME_PATH, "utf8"));
const today = new Date().toISOString().slice(0, 10);

const SALAM_ORDER_PRODUCTS = ["Tanah Lot Semi D", "Tanah Banglo", "Lot Kedai"];
const SALAM_LOT_CATALOG = [
  { lotNo: "30A SECTION A", project: "Wakaf Tapai, Marang", location: "Wakaf Tapai, Marang", price: 40000, buyerSegment: "Bumi" },
  { lotNo: "WT-98", project: "Wakaf Tapai, Marang", location: "Marang", price: 49000, buyerSegment: "Bumi" },
  { lotNo: "SI-7143", project: "Sungai Ikan, Setiu", location: "Setiu", price: 39000, buyerSegment: "Bumi" },
  { lotNo: "SI-7144", project: "Sungai Ikan, Setiu", location: "Setiu", price: 45000, buyerSegment: "Bumi" },
  { lotNo: "SMK-7359", project: "SMK Wakaf Tapai, Marang", location: "Wakaf Tapai", price: 59000, buyerSegment: "Bumi" },
  { lotNo: "GM-167164", project: "Lot Banglo Gemuruh", location: "Gemuruh", price: 159000, buyerSegment: "Tidak pasti" },
  { lotNo: "GM-167165", project: "Lot Banglo Gemuruh", location: "Gemuruh", price: 169000, buyerSegment: "Tidak pasti" },
  { lotNo: "CC-02", project: "Cherang China", location: "Cherang China", price: 98000, buyerSegment: "Tidak pasti" },
  { lotNo: "PG-11", project: "Pasir Gajah, Kemaman", location: "Kemaman", price: 69000, buyerSegment: "Tidak pasti" },
  { lotNo: "HL-A12", project: "Hulu Langat", location: "Hulu Langat", price: 88000, buyerSegment: "Bumi" },
  { lotNo: "P-08", project: "Semenyih", location: "Semenyih", price: 168000, buyerSegment: "Non-Bumi" }
];

function numeric(value) {
  return Number(value || 0);
}

function normalizePhone(phone = "") {
  return String(phone || "").replace(/[^\d]/g, "");
}

function canonicalSalamLotNo(value = "") {
  const clean = String(value || "").trim().replace(/\s+/g, " ");
  if (!clean) return "";
  if (/^30A(?:\s+SECTION\s+A)?$/i.test(clean)) return "30A SECTION A";
  return clean.toUpperCase();
}

function normalizeSalamProductName(value = "", ...hints) {
  const text = [value, ...hints].filter(Boolean).join(" ").toLowerCase();
  if (/kedai|shop|commercial/.test(text)) return "Lot Kedai";
  if (/banglo|bungalow/.test(text)) return "Tanah Banglo";
  if (/semi\s*d|semi-d|tanah\s*lot|lot\s*tanah|land/.test(text)) return "Tanah Lot Semi D";
  return SALAM_ORDER_PRODUCTS.includes(value) ? value : "Tanah Lot Semi D";
}

function cleanOrderNoteText(value = "") {
  return String(value || "")
    .replace(/^Quick\s+(booking|close)\s+dari\s+Lot\s+Status\s+Board\.\s*/i, "")
    .trim();
}

function lotCatalogEntry(lotNo = "") {
  const canonical = canonicalSalamLotNo(lotNo);
  return SALAM_LOT_CATALOG.find((item) => canonicalSalamLotNo(item.lotNo) === canonical) || null;
}

function normalizePaymentSchedule(record) {
  const details = record.details || {};
  const source = Array.isArray(details.paymentSchedule) ? details.paymentSchedule : [];
  const schedule = [];

  source.forEach((phase, index) => {
    const label = String(phase.label || (index === 0 ? "Booking / Deposit" : `Pay ${index + 1}`)).trim();
    const amount = numeric(phase.amount);
    const status = String(phase.status || "").toLowerCase();
    const paymentDate = String(phase.paymentDate || phase.paidDate || "").slice(0, 10);
    const legacyDueDate = String(phase.dueDate || "").slice(0, 10);
    const isUnpaidFutureRow = status === "unpaid" && !paymentDate;
    const isBalanceRow = /^balance$/i.test(label);
    if (!amount || isBalanceRow || isUnpaidFutureRow) return;
    schedule.push({
      id: phase.id || `pay-${Date.now()}-${index}`,
      label,
      amount,
      paymentDate: paymentDate || legacyDueDate || record.createdAt || today,
      method: String(phase.method || phase.paymentMethod || details.paymentMethod || "Bank transfer").trim(),
      reference: String(phase.reference || "").trim(),
      remark: String(phase.remark || "").trim(),
      status: "Paid",
      paidDate: paymentDate || legacyDueDate || record.createdAt || today,
      dueDate: ""
    });
  });

  if (!schedule.length) {
    const booking = numeric(details.bookingAmount);
    const deposit = numeric(details.depositAmount);
    const paidAmount = numeric(details.paidAmount);
    const installment = numeric(details.installmentAmount);
    const method = String(details.paymentMethod || "Bank transfer").trim();
    if (booking) {
      schedule.push({ id: `pay-${record.id}-booking`, label: "Booking", amount: booking, paymentDate: record.createdAt || today, method, reference: details.paymentReference || "", remark: "Migrated booking payment", status: "Paid", paidDate: record.createdAt || today, dueDate: "" });
    }
    if (deposit && deposit !== booking) {
      schedule.push({ id: `pay-${record.id}-deposit`, label: "Deposit", amount: deposit, paymentDate: record.createdAt || today, method, reference: details.paymentReference || "", remark: "Migrated deposit payment", status: "Paid", paidDate: record.createdAt || today, dueDate: "" });
    }
    if (installment) {
      schedule.push({ id: `pay-${record.id}-installment`, label: `Pay ${schedule.length + 1}`, amount: installment, paymentDate: record.createdAt || today, method, reference: "", remark: "Migrated fasa payment", status: "Paid", paidDate: record.createdAt || today, dueDate: "" });
    }
    if (!schedule.length && paidAmount) {
      schedule.push({ id: `pay-${record.id}-paid`, label: "Paid amount", amount: paidAmount, paymentDate: record.createdAt || today, method, reference: details.paymentReference || "", remark: "Migrated paid amount", status: "Paid", paidDate: record.createdAt || today, dueDate: "" });
    }
  }

  return schedule;
}

function summarizePayment(record, schedule) {
  const details = record.details || {};
  const total = numeric(record.value || details.landPrice || details.quoteAmount || 0);
  const totalPaid = schedule.reduce((sum, phase) => sum + numeric(phase.amount), 0);
  const balance = Math.max(0, total - totalPaid);
  const lastPhase = schedule
    .filter((phase) => phase.paymentDate)
    .sort((a, b) => a.paymentDate.localeCompare(b.paymentDate))
    .at(-1) || schedule.at(-1) || null;
  return {
    totalPaid,
    balance,
    lastPaymentDate: lastPhase?.paymentDate || "",
    lastPaymentAmount: lastPhase ? numeric(lastPhase.amount) : 0,
    lastPaymentLabel: lastPhase?.label || "",
    paymentCount: schedule.length,
    paymentStatus: balance <= 0 && total > 0 ? "Paid" : totalPaid > 0 ? "Partial" : "Unpaid"
  };
}

let normalizedSalamOrders = 0;
let normalizedPayments = 0;
let cleanedNotes = 0;

runtime.records = (runtime.records || []).map((record) => {
  record.details = record.details || {};
  if (record.companyId === "salam-land") {
    record.product = normalizeSalamProductName(record.product, record.details.metaCampaignName, record.details.tiktokCampaignName, record.details.projectLocation, record.details.location);
    if (record.details.lotNo) {
      record.details.lotNo = canonicalSalamLotNo(record.details.lotNo);
      const entry = lotCatalogEntry(record.details.lotNo);
      if (entry) {
        record.details.projectLocation = record.details.projectLocation || entry.project;
        record.details.location = record.details.location || entry.location || entry.project;
        record.details.landPrice = record.details.landPrice || entry.price || "";
        record.details.buyerSegment = record.details.buyerSegment || entry.buyerSegment || "Tidak pasti";
      }
      normalizedSalamOrders += record.kind === "order" ? 1 : 0;
    }
  }
  const cleanedNotesValue = cleanOrderNoteText(record.notes || "");
  if (cleanedNotesValue !== (record.notes || "")) cleanedNotes += 1;
  record.notes = cleanedNotesValue;

  if (record.kind === "order") {
    const schedule = normalizePaymentSchedule(record);
    const summary = summarizePayment(record, schedule);
    record.details.paymentSchedule = schedule;
    record.details.totalPaid = summary.totalPaid;
    record.details.balanceDue = summary.balance;
    record.details.lastPaymentDate = summary.lastPaymentDate;
    record.details.lastPaymentAmount = summary.lastPaymentAmount;
    record.details.lastPaymentLabel = summary.lastPaymentLabel;
    record.details.paymentCount = summary.paymentCount;
    record.details.paymentStatus = summary.paymentStatus;
    delete record.details.nextPaymentDate;
    delete record.details.nextPaymentAmount;
    delete record.details.nextPaymentLabel;
    delete record.details.overdueCount;
    normalizedPayments += 1;
  }
  return record;
});

const salamOrderGroups = new Map();
runtime.records.forEach((record) => {
  if (record.kind !== "order" || record.companyId !== "salam-land") return;
  const phone = normalizePhone(record.phone);
  const lotNo = canonicalSalamLotNo(record.details?.lotNo || "");
  if (!phone || !lotNo) return;
  const key = `${phone}:${lotNo}`;
  const list = salamOrderGroups.get(key) || [];
  list.push(record);
  salamOrderGroups.set(key, list);
});

let archivedDuplicates = 0;
salamOrderGroups.forEach((records) => {
  if (records.length < 2) return;
  records.sort((a, b) => {
    const valueDiff = numeric(b.value) - numeric(a.value);
    if (valueDiff) return valueDiff;
    const paymentDiff = numeric(b.details?.totalPaid) - numeric(a.details?.totalPaid);
    if (paymentDiff) return paymentDiff;
    return String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || ""));
  });
  const keeper = records[0];
  keeper.details = keeper.details || {};
  delete keeper.details.archivedDuplicate;
  delete keeper.details.duplicateOf;
  const preferredPaymentMethod = records.find((record) => String(record.details?.paymentMethod || "").toLowerCase() === "cash")?.details?.paymentMethod
    || records.find((record) => record.details?.paymentMethod)?.details?.paymentMethod
    || keeper.details.paymentMethod;
  if (preferredPaymentMethod) {
    keeper.details.paymentMethod = preferredPaymentMethod;
    if (Array.isArray(keeper.details.paymentSchedule)) {
      keeper.details.paymentSchedule = keeper.details.paymentSchedule.map((phase) => ({
        ...phase,
        method: phase.method || preferredPaymentMethod
      }));
    }
  }
  records.slice(1).forEach((duplicate) => {
    duplicate.details = duplicate.details || {};
    duplicate.details.archivedDuplicate = true;
    duplicate.details.duplicateOf = keeper.id;
    duplicate.notes = cleanOrderNoteText([duplicate.notes, `Archived duplicate of ${keeper.customerName || keeper.id}`].filter(Boolean).join("\n"));
    archivedDuplicates += 1;
  });
});

runtime.updatedAt = new Date().toISOString();
fs.writeFileSync(RUNTIME_PATH, `${JSON.stringify(runtime, null, 2)}\n`);

console.log(JSON.stringify({
  runtimePath: RUNTIME_PATH,
  records: runtime.records.length,
  normalizedSalamOrders,
  normalizedPayments,
  cleanedNotes,
  archivedDuplicates,
  updatedAt: runtime.updatedAt
}, null, 2));

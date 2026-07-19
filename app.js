const STORAGE_KEY = "crm-salam-fortress-v3";
const AUTO_BACKUP_KEY = "crm-salam-fortress-autobackup";
const SESSION_KEY = "crm-salam-fortress-session-v1";
const SESSION_STORAGE = localStorage;
const MAX_ATTACHMENTS = 4;
const MAX_ATTACHMENT_BYTES = 1_500_000;
const GLOBAL_ACCESS_ROLES = new Set(["admin", "boss"]);

function createId(prefix = "id") {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }

  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function slugify(value = "") {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function profileUsername(role, companyId = "", staffName = "") {
  if (role === "admin") return "afiq.admin";
  if (role === "boss") return "boss.management";
  if (role === "company") return companyLoginUsername(companyId);
  return slugify(staffName);
}

function roleLabel(role = "") {
  if (role === "admin") return "Admin";
  if (role === "boss") return "Management Boss";
  if (role === "company") return "Company Access";
  return "Staff / Team Sales";
}

const COMPANY_TEAM_DIRECTORY = {
  "salam-land": {
    loginUsername: "staffsalam",
    accessName: "Salam Land Workspace",
    staff: ["Nureen", "Wafi", "Tasha", "Sabrina", "Ain"],
    legacyToStaff: {
      Nurin: "Nureen",
      Nureen: "Nureen",
      Wafi: "Wafi",
      Tasha: "Tasha",
      Natasha: "Tasha",
      Sabrina: "Sabrina",
      Ain: "Ain",
      staffsalam: "Nureen",
      "staffsalam-01": "Nureen",
      "staffsalam-02": "Wafi",
      "staffsalam-03": "Tasha",
      "staffsalam-04": "Sabrina",
      "staffsalam-05": "Ain"
    }
  },
  "bumi-hayat": {
    loginUsername: "staffbh",
    accessName: "Bumi Hayat Workspace",
    staff: ["Amy", "Aiman", "Ayu"],
    legacyToStaff: {
      Amy: "Amy",
      Aiman: "Aiman",
      Ayu: "Ayu",
      staffbh: "Amy",
      "staffbh-01": "Amy",
      "staffbh-02": "Aiman",
      "staffbh-03": "Ayu"
    }
  },
  "barakah-emas": {
    loginUsername: "staffbe",
    accessName: "Barakah Emas Workspace",
    staff: ["Nabilah"],
    legacyToStaff: {
      Nabilah: "Nabilah",
      staffbe: "Nabilah",
      "staffbe-01": "Nabilah"
    }
  }
};

function staffAliases(companyId) {
  return COMPANY_TEAM_DIRECTORY[companyId]?.staff.slice() || [];
}

function companyLoginUsername(companyId) {
  return COMPANY_TEAM_DIRECTORY[companyId]?.loginUsername || slugify(companyId);
}

const DEMO_RECORD_STAFF_HINTS = {
  "60123450001": "Nureen",
  "60123450002": "Wafi",
  "60123450003": "Tasha",
  "60123450011": "Amy",
  "60123450012": "Aiman",
  "60123450013": "Ayu",
  "60123450021": "Nabilah",
  "60123450022": "Nabilah",
  "60123450023": "Nabilah"
};

function isUnassignedStaffValue(value = "") {
  const text = String(value || "").trim().toLowerCase();
  return !text || text === "-" || text === "staff" || /belum\s*assign|unassigned|not\s*assigned|team\s*sales belum/i.test(text);
}

function normalizeStaffName(companyId, staffName = "", record = null) {
  const normalized = String(staffName || "").trim();
  if (isUnassignedStaffValue(normalized)) return "";
  const directory = COMPANY_TEAM_DIRECTORY[companyId];
  if (!directory) return normalized;
  if (directory.staff.includes(normalized)) return normalized;
  const mapped = directory.legacyToStaff[normalized];
  if (mapped) {
    if (record?.phone && DEMO_RECORD_STAFF_HINTS[record.phone] && directory.staff.includes(DEMO_RECORD_STAFF_HINTS[record.phone])) {
      return DEMO_RECORD_STAFF_HINTS[record.phone];
    }
    return mapped;
  }
  return normalized;
}

function replaceLegacyStaffText(text = "") {
  let next = String(text || "");
  Object.values(COMPANY_TEAM_DIRECTORY).forEach((directory) => {
    Object.entries(directory.legacyToStaff).forEach(([legacyName, staffName]) => {
      next = next.replaceAll(legacyName, staffName);
    });
  });
  return next;
}

function normalizeRecordList(records = []) {
  return (Array.isArray(records) ? records : []).map((record) => ({
    ...record,
    createdAt: String(record.createdAt || todayIso()).slice(0, 10),
    nextFollowUp: normalizeNextFollowUp(record),
    actionFlags: normalizeActionFlags(record.actionFlags, record),
    staff: normalizeStaffName(record.companyId, record.staff, record),
    notes: replaceLegacyStaffText(record.notes || "")
  }));
}

function normalizeActivityList(activity = []) {
  return (Array.isArray(activity) ? activity : []).map((item) => ({
    ...item,
    actor: replaceLegacyStaffText(item.actor || ""),
    detail: replaceLegacyStaffText(item.detail || "")
  }));
}

function localIsoDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function localDateTimeLabel(date = new Date()) {
  return new Intl.DateTimeFormat("ms-MY", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
}

function todayIso() {
  return localIsoDate(new Date());
}

function isoOffset(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return localIsoDate(date);
}

function toDate(value) {
  return new Date(`${String(value || todayIso()).slice(0, 10)}T00:00:00`);
}

function isoOffsetFromDate(value, days) {
  const date = toDate(value);
  date.setDate(date.getDate() + days);
  return localIsoDate(date);
}

function daysBetween(start, end = todayIso()) {
  if (!start) return 0;
  return Math.round((toDate(end) - toDate(start)) / 86400000);
}

function normalizeSourceIsoDate(value = "") {
  if (value === undefined || value === null || value === "") return "";
  const textValue = String(value).trim();
  const dmyMatch = textValue.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})/);
  if (dmyMatch) {
    const [, day, month, rawYear] = dmyMatch;
    const year = rawYear.length === 2 ? `20${rawYear}` : rawYear;
    return `${year.padStart(4, "0")}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }
  const ymdMatch = textValue.match(/^(\d{4})[\/.-](\d{1,2})[\/.-](\d{1,2})/);
  if (ymdMatch) {
    const [, year, month, day] = ymdMatch;
    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }
  const parsed = new Date(textValue);
  return Number.isFinite(parsed.getTime()) ? localIsoDate(parsed) : "";
}

function recordSourceDate(record = {}) {
  const details = record.details || {};
  const candidates = record.kind === "lead"
    ? [
      record.sourceCreatedAt,
      record.leadCreatedAt,
      record.leadDate,
      details.sourceLeadDate,
      details.tiktokCreatedTime,
      details.metaCreatedTime,
      details.created_at,
      details.createdAt,
      details.created_time,
      details.createdTime,
      details.submit_time,
      details.submitTime,
      details.submission_time,
      details.submissionTime,
      details.date,
      record.createdAt,
      record.date,
      record.updatedAt
    ]
    : [record.createdAt, record.date, record.updatedAt];
  for (const candidate of candidates) {
    const isoDate = normalizeSourceIsoDate(candidate);
    if (isoDate) return isoDate;
  }
  return todayIso();
}

const SOURCE_OPTIONS = [
  "Meta Ads",
  "TikTok Ads",
  "TikTok Live",
  "Google Ads",
  "Website Form",
  "WhatsApp Business",
  "Referral",
  "Walk-in"
];

const FOLLOW_UP_DAYS = 14;

const LEAD_ACTIONS = [
  { id: "wsSent", label: "WS sent" },
  { id: "bluetick", label: "Bluetick" },
  { id: "reply", label: "Reply" },
  { id: "callDone", label: "Call done" },
  { id: "noAnswer", label: "Tak jawab" },
  { id: "interested", label: "Interested" },
  { id: "followUpSet", label: "Follow-up set" },
  { id: "siteVisit", label: "Site visit" },
  { id: "booking", label: "Booking" },
  { id: "closed", label: "Closed" },
  { id: "rejected", label: "Rejected" }
];

const ACTION_STATUS_MAP = {
  wsSent: "WS Sent",
  bluetick: "Bluetick",
  reply: "Reply",
  callDone: "Dihubungi",
  noAnswer: "Tak Jawab",
  interested: "Qualified",
  siteVisit: "Site Visit",
  booking: "Booking",
  closed: "Closed",
  rejected: "Lost"
};

function normalizeActionFlags(flags = {}, record = {}) {
  const source = flags && typeof flags === "object" ? flags : {};
  const status = String(record.status || "");
  return Object.fromEntries(LEAD_ACTIONS.map(({ id }) => {
    let value = Boolean(source[id]);
    if (!value && id === "wsSent") value = ["WS Sent", "Reply", "Tak Jawab", "Dihubungi", "Qualified", "Site Visit", "Booking", "Closed"].includes(status);
    if (!value && id === "bluetick") value = status === "Bluetick";
    if (!value && id === "reply") value = ["Reply", "Qualified", "Site Visit", "Booking", "Closed"].includes(status);
    if (!value && id === "noAnswer") value = status === "Tak Jawab";
    if (!value && id === "interested") value = ["Qualified", "Site Visit", "Booking", "Closed"].includes(status);
    if (!value && id === "siteVisit") value = status === "Site Visit";
    if (!value && id === "booking") value = status === "Booking";
    if (!value && id === "closed") value = status === "Closed";
    if (!value && id === "rejected") value = ["Lost", "Duplicate Lead"].includes(status);
    return [id, value];
  }));
}

function normalizeNextFollowUp(record = {}) {
  const createdAt = recordSourceDate(record);
  const currentFollowUp = String(record.nextFollowUp || "").slice(0, 10);
  if (record.kind !== "lead" || ["Closed", "Lost", "Duplicate Lead"].includes(String(record.status || ""))) return currentFollowUp;
  const expectedFourteenDay = isoOffsetFromDate(createdAt, FOLLOW_UP_DAYS);
  const legacyOneDay = isoOffsetFromDate(createdAt, 1);
  if (!currentFollowUp) return expectedFourteenDay;
  if (record.companyId === "salam-land" && record.kind === "lead" && currentFollowUp === legacyOneDay) {
    return expectedFourteenDay;
  }
  return currentFollowUp;
}

const BH_PRODUCTS = [
  "Rumah Sukan",
  "Bowling",
  "Futsal",
  "Takraw",
  "Sport Club",
  "Joran",
  "Bikers",
  "Adventure",
  "Badminton",
  "Floral",
  "Memanah",
  "Baju Kelas",
  "Guru Malaysia",
  "Kelab Kereta",
  "Korporat",
  "Esport",
  "Barber",
  "NFL Edition 2025",
  "Jiwa Merdeka",
  "Windbreaker",
  "Guru Malaysia Edisi 2025",
  "Volleyball",
  "Hari Sukan Negara",
  "Visit Johor"
];

const GOLD_RATE_REFRESH_MS = 60 * 60 * 1000;
const GOLD_RATE_STALE_MS = 6 * 60 * 60 * 1000;
const TROY_OUNCE_IN_GRAMS = 31.1034768;
const GOLD_PURITY = {
  "999": 0.999,
  "916": 0.916
};

const SALAM_LOT_STATUSES = ["Available", "Lead Hold", "Reserved", "Booking", "Closed"];
const CANCELLED_REFUND_STATUS = "Cancelled / Refund";
const REFUNDED_PAYMENT_STATUS = "Refunded";

const WORKSPACE_SECTIONS = [
  { id: "overviewSection", code: "DB", label: "Dashboard", note: "KPI ringkas" },
  { id: "recordsSection", code: "LD", label: "Leads", note: "Daily work" },
  { id: "lotStatusSection", code: "LS", label: "Lot Status", note: "Land board", companyIds: ["salam-land"] },
  { id: "automationSection", code: "OR", label: "Orders", note: "Order centre" },
  { id: "paymentSection", code: "PY", label: "Payments", note: "Bayaran berfasa" },
  { id: "performanceSection", code: "CP", label: "Campaigns", note: "Spend & CPL" },
  { id: "teamSection", code: "TM", label: "Sales Team", note: "Staff score" },
  { id: "reportSection", code: "RP", label: "Reports", note: "PDF & summary" },
  { id: "publishSection", code: "IN", label: "Integrations", note: "API & webhook" },
  { id: "whatsappSection", code: "WA", label: "WhatsApp API", note: "Cloud API" },
  { id: "controlSection", code: "ST", label: "Settings", note: "Access & backup" }
];

function defaultGoldRates() {
  return {
    status: "idle",
    sourceMode: "pending",
    fetchedAt: "",
    updatedAt: "",
    fxDate: "",
    ounceUsd: 0,
    usdMyr: 0,
    gram999: 0,
    gram916: 0,
    error: ""
  };
}

function defaultControl() {
  return {
    profiles: [],
    activeProfileId: "admin-root",
    settings: {
      dedupeWindowDays: 45,
      defaultFollowUpDays: FOLLOW_UP_DAYS,
      reminderAheadDays: 7,
      autoBackupEnabled: true,
      backupRetentionDays: 14,
      themeMode: "light"
    },
    activity: [],
    errors: [],
    lastBackupAt: ""
  };
}

function defaultSession() {
  return {
    token: "",
    authenticated: false,
    user: null,
    required: false
  };
}

const SALAM_ORDER_PRODUCTS = ["Tanah Lot Semi D", "Tanah Banglo", "Lot Kedai"];
const SALAM_LOT_OPTIONS = [
  "30A SECTION A",
  "98",
  "1685",
  "1686",
  "7143",
  "7144",
  "7145",
  "7359",
  "11409",
  "167164-167168",
  "4135",
  "62632-62655",
  "88",
  "712",
  "2421",
  "5920",
  "80316"
];
const SALAM_PROJECT_OPTIONS = [
  "Lot 98 Wakaf Tapai",
  "Bukit Diman Ajil",
  "Kg Sungai Ikan Fasa 2",
  "Lot Banglo 500m SMK Wakaf Tapai",
  "Lot Banglo Sungai Ikan Fasa 1",
  "Lot Banglo Gemuruh",
  "Lot Banglo Cherang China",
  "Lot Banglo Jerung",
  "Medan Jaya Rusila",
  "Merang",
  "Lot Banglo Kijal",
  "Lot Banglo Binjai",
  "Cherang China Wakaf Tapai",
  "Lot Banglo Sura Tengah",
  "Lot Banglo Pasir Gajah",
  "Gong Badak"
];

const SALAM_PROJECT_HINTS = [
  { pattern: /\b(1685|1686|BUKIT\s*DIMAN|AJIL)\b/i, label: "Bukit Diman Ajil" },
  { pattern: /\b(7143|7144|7145|KG\s*SUNGAI\s*IKAN|SUNGAI\s*IKAN|SETIU)\b/i, label: "Kg Sungai Ikan Fasa 2" },
  { pattern: /\b(7359|SMK)\b/i, label: "Lot Banglo 500m SMK Wakaf Tapai" },
  { pattern: /\b(11409|SG\s*IKAN\s*FASA\s*1)\b/i, label: "Lot Banglo Sungai Ikan Fasa 1" },
  { pattern: /\b(GM|GEMURUH)\b/i, label: "Lot Banglo Gemuruh" },
  { pattern: /\b(CHERANG\s*CHINA\s*WAKAF\s*TAPAI)\b/i, label: "Cherang China Wakaf Tapai" },
  { pattern: /\b(4135|CC|CHERANG\s*CHINA)\b/i, label: "Lot Banglo Cherang China" },
  { pattern: /\b(JERUNG)\b/i, label: "Lot Banglo Jerung" },
  { pattern: /\b(6263|MEDAN\s*JAYA|RUSILA)\b/i, label: "Medan Jaya Rusila" },
  { pattern: /\b(712|MERANG)\b/i, label: "Merang" },
  { pattern: /\b(2421|KIJAL)\b/i, label: "Lot Banglo Kijal" },
  { pattern: /\b(BINJAI)\b/i, label: "Lot Banglo Binjai" },
  { pattern: /\b(5920|SURA\s*TENGAH)\b/i, label: "Lot Banglo Sura Tengah" },
  { pattern: /\b(PG|PASIR\s*GAJAH)\b/i, label: "Lot Banglo Pasir Gajah" },
  { pattern: /\b(80316|GONG\s*BADAK)\b/i, label: "Gong Badak" },
  { pattern: /\b(WT|LOT\s*98|WAKAF\s*TAPAI)\b/i, label: "Lot 98 Wakaf Tapai" }
];

function normalizeSalamProductName(value = "", ...hints) {
  const text = [value, ...hints].filter(Boolean).join(" ").toLowerCase();
  if (/kedai|shop|commercial/.test(text)) return "Lot Kedai";
  if (/banglo|bungalow/.test(text)) return "Tanah Banglo";
  if (/semi\s*d|semi-d|tanah\s*lot|lot\s*tanah|land/.test(text)) return "Tanah Lot Semi D";
  return SALAM_ORDER_PRODUCTS.includes(value) ? value : "Tanah Lot Semi D";
}

function cleanSalamProjectLabel(value = "") {
  const label = String(value || "").trim();
  if (!label) return "";
  if (/tanah\s*\/\s*daerah belum diisi/i.test(label)) return "";
  if (/^belum diisi$/i.test(label)) return "";
  if (/^project belum dipilih$/i.test(label)) return "";
  const normalized = label.replace(/\s+/g, " ").trim();
  const legacyProjectMap = [
    { pattern: /smk\s*wakaf\s*tapai/i, label: "Lot Banglo 500m SMK Wakaf Tapai" },
    { pattern: /cherang\s*china.*wakaf\s*tapai/i, label: "Cherang China Wakaf Tapai" },
    { pattern: /sungai\s*ikan|setiu/i, label: "Kg Sungai Ikan Fasa 2" },
    { pattern: /gemuruh/i, label: "Lot Banglo Gemuruh" },
    { pattern: /cherang\s*china/i, label: "Lot Banglo Cherang China" },
    { pattern: /bukit\s*diman|ajil/i, label: "Bukit Diman Ajil" },
    { pattern: /pasir\s*gajah/i, label: "Lot Banglo Pasir Gajah" },
    { pattern: /merang/i, label: "Merang" },
    { pattern: /kijal/i, label: "Lot Banglo Kijal" },
    { pattern: /binjai/i, label: "Lot Banglo Binjai" },
    { pattern: /sura\s*tengah/i, label: "Lot Banglo Sura Tengah" },
    { pattern: /gong\s*badak/i, label: "Gong Badak" },
    { pattern: /wakaf\s*tapai/i, label: "Lot 98 Wakaf Tapai" }
  ];
  return legacyProjectMap.find((item) => item.pattern.test(normalized))?.label || normalized;
}

function inferSalamProjectLabel(...values) {
  const text = values.filter(Boolean).join(" ");
  const hint = SALAM_PROJECT_HINTS.find((item) => item.pattern.test(text));
  return hint?.label || "";
}

function salamProjectLabel(record = {}, fallback = "Project belum dipilih") {
  const details = record.details || {};
  return cleanSalamProjectLabel(details.projectLocation)
    || cleanSalamProjectLabel(details.location)
    || inferSalamProjectLabel(
      details.lotNo,
      details.metaCampaignName,
      details.tiktokCampaignName,
      campaignName(record.campaignId),
      record.product,
      record.notes
    )
    || fallback;
}

function canonicalSalamLotNo(value = "") {
  const clean = String(value || "").trim().replace(/\s+/g, " ");
  if (!clean) return "";
  if (/^30A(?:\s+SECTION\s+A)?$/i.test(clean)) return "30A SECTION A";
  return clean.toUpperCase();
}

function salamLotCatalogEntry(lotNo = "") {
  const canonical = canonicalSalamLotNo(lotNo);
  if (!canonical) return null;
  const company = companyById("salam-land");
  return (company.lotInventory || []).find((item) => canonicalSalamLotNo(item.lotNo) === canonical) || null;
}

function salamLotOptions(selected = "") {
  const selectedLot = canonicalSalamLotNo(selected);
  const company = companyById("salam-land");
  const options = Array.from(new Set([
    ...SALAM_LOT_OPTIONS,
    ...(company.lotInventory || []).map((item) => canonicalSalamLotNo(item.lotNo)).filter(Boolean),
    selectedLot
  ].filter(Boolean)));
  return options;
}

function cleanOrderNoteText(value = "") {
  return String(value || "")
    .replace(/^Quick\s+(booking|close)\s+dari\s+Lot\s+Status\s+Board\.\s*/i, "")
    .trim();
}

const COMPANIES = [
  {
    id: "salam-land",
    name: "Salam Land Development",
    business: "Property sales CRM",
    tagline: "Pantau lead, follow-up, booking, lot status dan jualan tanah dalam satu sistem yang kemas untuk management dan team sales.",
    flowSummary: "Flow Salam Land dibina untuk tegas dari capture sampai booking supaya team sales hanya fokus pada lot, urgency buyer, site visit dan closed value.",
    logo: "./assets/salam-land-logo-2026.jpeg",
    logoClass: "",
    themeBadge: "Property sales",
    pills: ["Lead capture", "Lot status", "Sales pipeline"],
    operationsFlow: [
      { stage: "01", title: "Capture", note: "Meta, TikTok dan manual lead masuk terus dengan source stamp." },
      { stage: "02", title: "Qualify", note: "Buyer segment, lokasi tanah dan minat lot disaring cepat." },
      { stage: "03", title: "Visit", note: "Site visit, lot shortlist dan dokumen buyer diurus ikut urgency." },
      { stage: "04", title: "Book", note: "Booking amount, IC ref dan status bumi dipegang dalam satu lane." },
      { stage: "05", title: "Close", note: "Closed sales, campaign attribution dan staff conversion terus masuk report." }
    ],
    showcaseTitle: "Salam Land inventory from imported PDF",
    showcaseBadge: "PDF synced",
    showcase: [
      {
        title: "Lot 98 Wakaf Tapai",
        text: "Produk campuran Semi-D dan Banglo daripada fail katalog imported yang awak bagi.",
        meta: ["Semi-D RM39k", "Banglo RM75k-RM98k", "Tanah Dalam Proses"]
      },
      {
        title: "Kg Sungai Ikan Fasa 2",
        text: "Cluster Sungai Ikan untuk kempen entry-to-mid range buyer, disusun semula dari PDF dalam kotak yang lebih jelas.",
        meta: ["7143 / 7144 / 7145", "RM39k-RM49k", "Fasa 2"]
      },
      {
        title: "Lot Banglo 500m SMK Wakaf Tapai",
        text: "Project yang sesuai ditonjolkan untuk audience keluarga sebab positioning dekat node sekolah.",
        meta: ["No. 7359", "RM69k", "Tanah Dalam Proses"]
      },
      {
        title: "Lot Banglo Gemuruh",
        text: "Listing premium siap geran yang lebih serious untuk buyer high-intent dan retargeting.",
        meta: ["167164-167168", "RM139k", "Siap Geran"]
      },
      {
        title: "Lot Banglo Cherang China",
        text: "Project JV siap geran dengan range harga pertengahan untuk kempen banglo-ready.",
        meta: ["RM89k-RM125k", "JV Project", "Siap Geran"]
      },
      {
        title: "Lot Banglo Pasir Gajah",
        text: "Listing funder yang bagus untuk scarcity angle dan closed-driven follow-up.",
        meta: ["RM69k", "Funder", "Siap Geran"]
      }
    ],
    lotInventory: [
      { lotNo: "30A SECTION A", project: "Lot 98 Wakaf Tapai", location: "Lot 98 Wakaf Tapai", price: 40000, buyerSegment: "Bumi", baseStatus: "Available" },
      { lotNo: "98", project: "Lot 98 Wakaf Tapai", location: "Lot 98 Wakaf Tapai", price: 39000, buyerSegment: "Bumi", baseStatus: "Available" },
      { lotNo: "1685", project: "Bukit Diman Ajil", location: "Bukit Diman Ajil", price: 49000, buyerSegment: "Bumi", baseStatus: "Available" },
      { lotNo: "1686", project: "Bukit Diman Ajil", location: "Bukit Diman Ajil", price: 39000, buyerSegment: "Bumi", baseStatus: "Available" },
      { lotNo: "7143", project: "Kg Sungai Ikan Fasa 2", location: "Kg Sungai Ikan Fasa 2", price: 39000, buyerSegment: "Bumi", baseStatus: "Available" },
      { lotNo: "7144", project: "Kg Sungai Ikan Fasa 2", location: "Kg Sungai Ikan Fasa 2", price: 45000, buyerSegment: "Bumi", baseStatus: "Available" },
      { lotNo: "7145", project: "Kg Sungai Ikan Fasa 2", location: "Kg Sungai Ikan Fasa 2", price: 49000, buyerSegment: "Bumi", baseStatus: "Available" },
      { lotNo: "7359", project: "Lot Banglo 500m SMK Wakaf Tapai", location: "Lot Banglo 500m SMK Wakaf Tapai", price: 69000, buyerSegment: "Bumi", baseStatus: "Available" },
      { lotNo: "11409", project: "Lot Banglo Sungai Ikan Fasa 1", location: "Lot Banglo Sungai Ikan Fasa 1", price: 55000, buyerSegment: "Bumi", baseStatus: "Available" },
      { lotNo: "167164-167168", project: "Lot Banglo Gemuruh", location: "Lot Banglo Gemuruh", price: 139000, buyerSegment: "Mixed", baseStatus: "Available" },
      { lotNo: "4135", project: "Lot Banglo Cherang China", location: "Lot Banglo Cherang China", price: 89000, buyerSegment: "Mixed", baseStatus: "Available" },
      { lotNo: "62632-62655", project: "Bukit Diman Ajil", location: "Bukit Diman Ajil", price: 79000, buyerSegment: "Mixed", baseStatus: "Available" },
      { lotNo: "88", project: "Medan Jaya Rusila", location: "Medan Jaya Rusila", price: 68000, buyerSegment: "Mixed", baseStatus: "Available" },
      { lotNo: "712", project: "Merang", location: "Merang", price: 39000, buyerSegment: "Mixed", baseStatus: "Available" },
      { lotNo: "2421", project: "Lot Banglo Kijal", location: "Lot Banglo Kijal", price: 99000, buyerSegment: "Mixed", baseStatus: "Available" },
      { lotNo: "5920", project: "Lot Banglo Sura Tengah", location: "Lot Banglo Sura Tengah", price: 200000, buyerSegment: "Mixed", baseStatus: "Available" },
      { lotNo: "80316", project: "Gong Badak", location: "Gong Badak", price: 219000, buyerSegment: "Mixed", baseStatus: "Available" }
    ],
    document: {
      title: "Imported PDF catalog",
      text: "Fail PDF Salam Land dimasukkan terus ke dalam Fortress supaya management boleh buka katalog semasa semak harga, lokasi, status dan availability.",
      link: "./assets/salam-land-catalog.pdf",
      linkLabel: "Open full PDF catalog",
      embed: true
    },
    staff: staffAliases("salam-land"),
    products: SALAM_ORDER_PRODUCTS,
    statuses: ["New Lead", "Bluetick", "WS Sent", "Reply", "Tak Jawab", "Dihubungi", "Qualified", "Site Visit", "Booking", "Closed", CANCELLED_REFUND_STATUS, "Duplicate Lead", "Lost"],
    closedStatuses: ["Closed"],
    lostStatuses: ["Lost", "Duplicate Lead", CANCELLED_REFUND_STATUS],
    workflow: [
      {
        title: "Lead to site visit",
        text: "Lead baru masuk terus auto-stamp tarikh, source, campaign dan syor staff. Staff hanya update minat tanah dan remark call.",
        bullets: ["Status awal auto", "Company auto-tagged", "Next follow-up default"]
      },
      {
        title: "Booking layer",
        text: "Bila lead serius, sistem mula track lot, buyer segment, site visit, booking amount dan dokumen IC.",
        bullets: ["Lot tanah", "Bumi / Non-Bumi", "Booking amount"]
      },
      {
        title: "Management visibility",
        text: "Owner boleh nampak daily leads, open queue, site visit, booking dan closed ikut staff serta campaign.",
        bullets: ["Daily leads", "Site visit count", "Closed value"]
      },
      {
        title: "WhatsApp assist",
        text: "Blast bulanan, 14-hari follow-up dan skrip bot malam disusun ikut buyer tanah dan lokasi.",
        bullets: ["Monthly blast", "14-day follow-up", "Night auto-reply script"]
      }
    ],
    leadPlan: {
      auto: ["Tarikh lead masuk", "Masa lead masuk", "Source & campaign", "Company layer", "Status awal", "Next follow-up default"],
      staff: ["Nama + phone jika lead manual", "Produk / tanah minat", "Status semasa", "Remark ringkas"]
    },
    orderPlan: {
      auto: ["Tarikh order", "Staff yang handle", "Source dari lead", "Nama & phone kalau convert dari lead"],
      staff: ["Lot / lokasi", "Harga lot", "Booking amount", "Bayaran berfasa", "Bumi / Non-Bumi", "IC ref depan & belakang"]
    },
    sidebarRules: [
      "Lead: staff update status, minat tanah, remark.",
      "Order: staff update lot, harga, booking, IC ref.",
      "Management: sistem kira site visit, booking, closed."
    ],
    autoCapture: [
      "Auto stamp source, campaign, created date.",
      "Auto kira open leads, closed, sales.",
      "Auto queue monthly blast dan due follow-up."
    ],
    leadFields: [
      { name: "product", label: "Produk tanah minat", type: "select", options: SALAM_ORDER_PRODUCTS },
      { name: "location", label: "Nama projek", type: "select", options: SALAM_PROJECT_OPTIONS },
      { name: "buyerSegment", label: "Bumi / Non-Bumi", type: "select", options: ["Bumi", "Non-Bumi", "Tidak pasti"] }
    ],
    orderFields: [
      { name: "lotNo", label: "No lot tanah", type: "select", placeholder: "Pilih lot yang ada dalam sistem", options: SALAM_LOT_OPTIONS, required: true },
      { name: "projectLocation", label: "Nama projek", type: "select", placeholder: "Pilih nama projek", options: SALAM_PROJECT_OPTIONS, required: true },
      { name: "landPrice", label: "Harga lot (RM)", type: "number", required: true },
      { name: "discountAmount", label: "Diskaun (RM)", type: "number", placeholder: "Contoh: 5000" },
      { name: "bookingAmount", label: "Booking amount (RM)", type: "number" },
      { name: "installmentAmount", label: "Bayaran berfasa (RM)", type: "number" }
    ],
    defaultLeadProduct: "Tanah Lot Semi D",
    blastMessage: "Salam {name}, kami follow up semula untuk minat tanah anda. Kami ada lot strategik dengan harga jelas dan boleh bantu semak pilihan ikut bajet. Nak saya share senarai lot yang masih available?",
    followUpMessage: "Assalamualaikum {name}, saya {staff} dari Salam Land Development. Saya terima minat tuan/puan untuk {product}. Boleh saya bantu semak bajet, kawasan dan lot yang masih available?",
    staffFollowUpMessages: {
      Nureen: `Assalamualaikum tuan/puan
saya Nureen dari Salam Land Development

Terimakasih kerana berminat dengan tanah lot semi d / banglo / kedai kami 🤗
Boleh saya tahu cik tinggal di area mana ya?`
    },
    nightBotMessage: "Terima kasih hubungi Salam Land Development. Team kami offline 12am-6am. Sila reply lokasi, bajet dan jenis tanah yang dicari. Staff akan sambung follow up seawal pagi."
  },
  {
    id: "bumi-hayat",
    name: "Bumi Hayat Printing",
    business: "Printing operations CRM",
    tagline: "Pantau enquiry, quotation, deposit, production dan delivery untuk order printing sukan dari satu tempat.",
    flowSummary: "Flow Bumi Hayat disusun ikut real kilang: lead masuk, quotation, deposit, production dan delivery supaya owner cepat nampak mana order yang tersangkut.",
    logo: "./assets/bumi-hayat-logo.png",
    logoClass: "bumi",
    themeBadge: "Printing sales",
    pills: ["Quotation", "Production", "Delivery"],
    operationsFlow: [
      { stage: "01", title: "Capture", note: "Lead masuk ikut kategori katalog dan source campaign." },
      { stage: "02", title: "Scope", note: "Quantity, customer type dan design need direkod cepat." },
      { stage: "03", title: "Quote", note: "Quotation dan deposit 50% dijadikan checkpoint utama." },
      { stage: "04", title: "Produce", note: "Mockup, printing, QC dan deadline diurus dalam satu flow." },
      { stage: "05", title: "Deliver", note: "Delivered, closed dan kategori paling convert terus kelihatan." }
    ],
    showcaseTitle: "Bumihayat showroom & catalog pulse",
    showcaseBadge: "Web researched",
    showcase: [
      {
        title: "Catalog-first sales flow",
        text: "Semua kategori order ikut katalog sebenar Bumihayat, bukan kategori generic.",
        meta: ["Futsal", "Rumah Sukan", "Windbreaker"]
      },
      {
        title: "Factory sales flow",
        text: "Quotation, deposit 50%, mockup approval, production dan delivery semuanya diangkat sebagai flow utama sistem.",
        meta: ["Deposit 50%", "Mockup", "Production"]
      },
      {
        title: "Johor showroom positioning",
        text: "Reka bentuk modul ni disusun ikut flow sebenar premium sublimation factory daripada laman rasmi Bumihayat.",
        meta: ["Johor HQ", "Sublimation", "Showroom"]
      },
      {
        title: "Branch / agent / enduser",
        text: "Order center disusun supaya senang bezakan customer type dan conversion yang datang dari setiap saluran.",
        meta: ["Branch", "Ejen / reseller", "Enduser"]
      }
    ],
    document: {
      title: "Official catalog reference",
      text: "Katalog rasmi Bumihayat diletakkan sebagai reference centre supaya staff boleh semak kategori terus tanpa keluar dari aliran CRM.",
      link: "https://bumihayat.com/katalog/",
      linkLabel: "Open Bumihayat catalog",
      embed: false
    },
    staff: staffAliases("bumi-hayat"),
    products: BH_PRODUCTS,
    statuses: ["New Lead", "Bluetick", "WS Sent", "Reply", "Tak Jawab", "Dihubungi", "Quotation", "Deposit", "Production", "Delivered", "Closed", CANCELLED_REFUND_STATUS, "Lost"],
    closedStatuses: ["Closed", "Delivered"],
    lostStatuses: ["Lost", CANCELLED_REFUND_STATUS],
    workflow: [
      {
        title: "Catalog-first selling",
        text: "Lead Bumi Hayat masuk ikut kategori katalog sebenar seperti Futsal, Rumah Sukan, Windbreaker atau Korporat.",
        bullets: ["Catalog category", "Customer type", "Quantity interest"]
      },
      {
        title: "Mockup to production",
        text: "Sistem fokus pada workflow yang real untuk printing: quotation, deposit 50%, mockup approval, production, delivery.",
        bullets: ["Quotation", "Deposit", "Mockup", "Production"]
      },
      {
        title: "Fast staff input",
        text: "Staff cuma isi quantity, customer type, design status dan remark. Data spend, tarikh, source dan campaign auto berat ke sistem.",
        bullets: ["Lead ringkas", "Order ringkas", "Auto CPL"]
      },
      {
        title: "Growth visibility",
        text: "Owner boleh nampak kategori mana paling convert, staff mana paling banyak close, dan campaign mana bagi order berkualiti.",
        bullets: ["Category sales", "Staff conversion", "Campaign CPL"]
      }
    ],
    leadPlan: {
      auto: ["Tarikh lead", "Source", "Campaign", "Company tag", "Status awal", "Suggested follow-up date"],
      staff: ["Nama + phone jika manual", "Kategori katalog", "Customer type", "Quantity / remark", "Mockup need atau tidak"]
    },
    orderPlan: {
      auto: ["Tarikh order", "Staff handle", "Source dari lead", "Customer info dari lead kalau convert"],
      staff: ["Kategori order", "Quantity", "Quotation", "Design deposit RM100 untuk custom", "50% payment selepas submit", "Full payment sebelum pickup"]
    },
    sidebarRules: [
      "Lead: staff update kategori, quantity, remark.",
      "Order: staff update quote, deposit, deadline, production.",
      "Management: sistem kira CPL, order rate, delivery rate."
    ],
    autoCapture: [
      "Auto capture campaign dan spend connected source.",
      "Auto kira quotation to closed ratio.",
      "Auto senaraikan order due dan follow-up due."
    ],
    leadFields: [
      { name: "product", label: "Kategori katalog", type: "select", options: BH_PRODUCTS },
      { name: "customerType", label: "Customer type", type: "select", options: ["Branch", "Ejen / reseller", "Enduser"] },
      { name: "quantity", label: "Anggaran quantity", type: "number" },
      { name: "designNeed", label: "Design status", type: "select", options: ["Ada design sendiri", "Perlu designer", "Mockup sahaja", "Belum pasti"] }
    ],
    orderFields: [
      { name: "product", label: "Kategori order", type: "select", options: BH_PRODUCTS },
      { name: "orderType", label: "Jenis order", type: "select", options: ["Custom", "Readymade"] },
      { name: "quantity", label: "Quantity order", type: "number" },
      { name: "quoteAmount", label: "Quotation (RM)", type: "number" },
      { name: "designDeposit", label: "Design deposit (RM)", type: "number", placeholder: "Custom: RM100, Readymade: free" },
      { name: "depositAmount", label: "50% payment selepas submit (RM)", type: "number" },
      { name: "finalPaymentAmount", label: "Final/full payment before pickup (RM)", type: "number" },
      { name: "deadline", label: "Deadline", type: "date" },
      { name: "productionStatus", label: "Production status", type: "select", options: ["Artwork", "Mockup", "Printing", "QC", "Ready", "Delivered"] }
    ],
    defaultLeadProduct: "Futsal",
    blastMessage: "Hi {name}, Bumi Hayat Printing ada katalog sublimation untuk {product} dan kategori lain. Kami boleh bantu dari quotation sampai siap production. Nak saya bantu semak harga ikut quantity?",
    followUpMessage: "Hi {name}, saya follow up semula untuk {product}. Kalau quantity dan design dah ready, saya boleh bantu semak quotation, deposit dan slot production paling cepat.",
    nightBotMessage: "Terima kasih hubungi Bumi Hayat Printing. Team kami offline 12am-6am. Sila reply kategori baju, quantity, deadline dan design status. Staff akan sambung seawal pagi."
  },
  {
    id: "barakah-emas",
    name: "Barakah Emas",
    business: "Gold trading CRM",
    tagline: "Pantau lead, transaksi, gram, harga semasa dan conversion buyer emas dalam sistem jualan yang lebih tersusun.",
    flowSummary: "Flow Barakah Emas menitikberatkan trust, harga semasa dan transaction clarity supaya lead survey dapat ditukar jadi deal yang kemas dan boleh diaudit.",
    logo: "./assets/barakah-emas-logo.png",
    logoClass: "",
    themeBadge: "Gold sales",
    pills: ["Lead tracking", "Gold rate", "Transaction"],
    operationsFlow: [
      { stage: "01", title: "Capture", note: "Lead baru masuk dengan source, umur range dan niat transaksi." },
      { stage: "02", title: "Price", note: "Rate 916 dan 999 dijadikan rujukan semasa untuk perbualan jualan." },
      { stage: "03", title: "Advise", note: "Gram, trust note dan produk sesuai dipadankan ikut bajet buyer." },
      { stage: "04", title: "Transact", note: "Buy, sell atau trade-in direkod bersama payment dan total harga." },
      { stage: "05", title: "Nurture", note: "Follow-up survey, repeat buyer dan hot lead dijaga dalam loop tersusun." }
    ],
    showcaseTitle: "Barakah Emas daily conversion lens",
    showcaseBadge: "Sales-tailored",
    showcase: [
      {
        title: "Daily lead monitoring",
        text: "Workspace ni direka untuk nampak jumlah lead harian bersama data buyer yang paling penting.",
        meta: ["Lead count", "Age range", "Source view"]
      },
      {
        title: "Transaction clarity",
        text: "Order diasingkan ikut beli dengan kita, jual kepada kita, trade-in atau survey harga.",
        meta: ["Buy", "Sell", "Trade-in"]
      },
      {
        title: "Gram & price logic",
        text: "Semua nilai order fokus pada gram, harga per gram dan total harga supaya audit jualan lebih jelas.",
        meta: ["Gram sold", "Price/gram", "Revenue"]
      },
      {
        title: "Trust-led sales flow",
        text: "Visual dan messaging modul dibina untuk rasa lebih premium dan meyakinkan buyer emas.",
        meta: ["Buyer trust", "Trust note", "Premium follow-up"]
      }
    ],
    document: {
      title: "Gold rate center",
      text: "Harga emas 916 / 999 kini disambung terus ke dashboard Barakah Emas, termasuk snapshot rujukan semasa order.",
      link: "",
      linkLabel: "",
      embed: false
    },
    staff: staffAliases("barakah-emas"),
    products: ["Emas 916", "Emas 999", "Emas baru", "Emas terpakai", "Trade-in emas"],
    statuses: ["New Lead", "Bluetick", "WS Sent", "Reply", "Tak Jawab", "Dihubungi", "Product Suggested", "Appointment", "Payment", "Closed", CANCELLED_REFUND_STATUS, "Lost"],
    closedStatuses: ["Closed", "Payment"],
    lostStatuses: ["Lost", CANCELLED_REFUND_STATUS],
    workflow: [
      {
        title: "Daily lead watch",
        text: "Management boleh nampak berapa leads emas masuk setiap hari bersama nama, umur/range umur dan source.",
        bullets: ["Daily count", "Lead list", "Age range"]
      },
      {
        title: "Gold transaction clarity",
        text: "Order asing ikut beli dari kita, jual ke kita, trade-in atau survey harga sahaja.",
        bullets: ["Buy", "Sell", "Trade-in", "Survey"]
      },
      {
        title: "Gram and price logic",
        text: "Sistem simpan gram, harga per gram, total value, payment dan remark trust supaya senang audit conversion.",
        bullets: ["Gram", "Harga per gram", "Payment", "Trust note"]
      },
      {
        title: "Repeat buyer nurture",
        text: "Queue follow-up direka untuk survey buyer, hot lead dan buyer lama bila ada stok atau harga menarik.",
        bullets: ["Hot buyer", "Price follow-up", "Night bot"]
      }
    ],
    leadPlan: {
      auto: ["Tarikh lead", "Source", "Campaign", "Company layer", "Status awal", "Follow-up default"],
      staff: ["Nama + phone jika manual", "Range umur", "Jenis transaksi", "Jenis emas minat", "Remark ringkas"]
    },
    orderPlan: {
      auto: ["Tarikh order", "Staff handle", "Source dari lead", "Nama & phone dari lead jika convert"],
      staff: ["Jenis transaksi", "Jenis emas", "Gram", "Harga per gram", "Payment status", "Total harga"]
    },
    sidebarRules: [
      "Lead: staff update umur, transaksi, remark.",
      "Order: staff update gram, harga per gram, payment.",
      "Management: sistem kira daily leads, gram sold, conversion."
    ],
    autoCapture: [
      "Auto capture source, campaign dan created date.",
      "Auto kira daily leads, close rate dan revenue.",
      "Auto queue bluetick blast dan survey follow-up."
    ],
    leadFields: [
      { name: "product", label: "Jenis emas minat", type: "select", options: ["Emas 916", "Emas 999", "Emas baru", "Emas terpakai", "Trade-in emas"] },
      { name: "ageRange", label: "Umur / range umur", type: "select", options: ["18-24", "25-34", "35-44", "45+", "Tidak pasti"] },
      { name: "transactionType", label: "Jenis transaksi", type: "select", options: ["Beli dengan kita", "Jual kepada kita", "Trade-in", "Survey harga"] },
      { name: "grams", label: "Target gram", type: "number" }
    ],
    orderFields: [
      { name: "product", label: "Jenis emas", type: "select", options: ["Emas 916", "Emas 999", "Emas baru", "Emas terpakai", "Trade-in emas"] },
      { name: "transactionType", label: "Jenis transaksi", type: "select", options: ["Beli dengan kita", "Jual kepada kita", "Trade-in"] },
      { name: "grams", label: "Gram", type: "number" },
      { name: "pricePerGram", label: "Harga per gram (RM)", type: "number" },
      { name: "goldCondition", label: "Baru / terpakai", type: "select", options: ["Baru", "Terpakai", "Mixed"] }
    ],
    defaultLeadProduct: "Emas 916",
    blastMessage: "Hi {name}, Barakah Emas ada stok {product} dan pilihan gram yang sesuai bajet. Kalau masih survey emas berkualiti, saya boleh bantu semak harga semasa dan stok available.",
    followUpMessage: "Hi {name}, saya follow up semula minat {product}. Kalau masih nak beli atau survey emas, saya boleh bantu semak gram, harga per gram dan pilihan yang sesuai.",
    nightBotMessage: "Terima kasih hubungi Barakah Emas. Team kami offline 12am-6am. Sila reply nak beli/jual/trade-in, jenis emas dan anggaran gram. Nabilah akan sambung seawal pagi."
  }
];

function buildDefaultProfiles() {
  const profiles = [
    {
      id: "admin-root",
      name: "Afiq Admin",
      username: profileUsername("admin"),
      role: "admin",
      companyIds: COMPANIES.map((company) => company.id),
      companyId: "",
      staffName: "",
      title: "Super admin",
      note: "Akses semua company, publish layer dan settings."
    },
    {
      id: "boss-root",
      name: "Management Boss",
      username: profileUsername("boss"),
      role: "boss",
      companyIds: COMPANIES.map((company) => company.id),
      companyId: "",
      staffName: "",
      title: "Management access",
      note: "Akses semua company, tetapi setiap module kekal render ikut company aktif sahaja."
    }
  ];

  COMPANIES.forEach((company) => {
    profiles.push({
      id: `company-${company.id}`,
      name: COMPANY_TEAM_DIRECTORY[company.id]?.accessName || company.name,
      username: profileUsername("company", company.id),
      role: "company",
      companyIds: [company.id],
      companyId: company.id,
      staffName: "",
      title: "Company access",
      note: `Login terus ke modul ${company.name} sambil kekalkan semua nama team sales dan assignment dalam company ini.`
    });
  });

  return profiles;
}

function mergeProfilesWithDefaults(incomingProfiles = []) {
  const defaults = buildDefaultProfiles();
  const incomingMap = new Map(
    (Array.isArray(incomingProfiles) ? incomingProfiles : [])
      .map((profile) => [profile?.id || profile?.profileId, profile])
      .filter(([profileId]) => Boolean(profileId))
  );
  return defaults.map((profile) => ({
    ...profile,
    ...(incomingMap.get(profile.id) || {}),
    id: profile.id
  }));
}

function mergeControl(raw) {
  const defaults = defaultControl();
  const incoming = raw && typeof raw === "object" ? raw : {};
  const profiles = mergeProfilesWithDefaults(incoming.profiles);
  const nextActiveProfileId = profiles.some((profile) => profile.id === incoming.activeProfileId)
    ? incoming.activeProfileId
    : profiles[0]?.id || defaults.activeProfileId;

  return {
    ...defaults,
    ...incoming,
    profiles,
    activeProfileId: nextActiveProfileId,
    settings: {
      ...defaults.settings,
      ...((incoming.settings && typeof incoming.settings === "object") ? incoming.settings : {})
    },
    activity: normalizeActivityList(Array.isArray(incoming.activity) ? incoming.activity.slice(0, 80) : []),
    errors: Array.isArray(incoming.errors) ? incoming.errors.slice(0, 20) : [],
    lastBackupAt: typeof incoming.lastBackupAt === "string" ? incoming.lastBackupAt : ""
  };
}

const SEED_CAMPAIGNS = [
  { id: createId("camp"), companyId: "salam-land", platform: "Meta Ads", name: "Tanah Lot Hulu Langat", spend: 880, createdAt: isoOffset(-9) },
  { id: createId("camp"), companyId: "salam-land", platform: "TikTok Ads", name: "Site Visit Semenyih", spend: 420, createdAt: isoOffset(-5) },
  { id: createId("camp"), companyId: "bumi-hayat", platform: "Meta Ads", name: "Futsal Team Pack", spend: 560, createdAt: isoOffset(-3) },
  { id: createId("camp"), companyId: "bumi-hayat", platform: "TikTok Ads", name: "Windbreaker Club", spend: 300, createdAt: isoOffset(-1) },
  { id: createId("camp"), companyId: "barakah-emas", platform: "Meta Ads", name: "Emas 916 Launch", spend: 390, createdAt: isoOffset(-2) }
];

function buildSeedRecords() {
  return normalizeRecordList([
    {
      id: createId("rec"),
      kind: "lead",
      companyId: "salam-land",
      customerName: "Azman Rahim",
      phone: "60123450001",
      source: "Meta Ads",
      campaignId: SEED_CAMPAIGNS[0].id,
      staff: "Nureen",
      product: "Tanah banglo",
      status: "Site Visit",
      createdAt: isoOffset(0),
      nextFollowUp: isoOffset(1),
      value: 0,
      units: 0,
      details: { location: "Hulu Langat", buyerSegment: "Bumi" },
      notes: "Minat lot banglo dan mahu site visit hujung minggu."
    },
    {
      id: createId("rec"),
      kind: "order",
      companyId: "salam-land",
      customerName: "Farah Zaini",
      phone: "60123450002",
      source: "Meta Ads",
      campaignId: SEED_CAMPAIGNS[1].id,
      staff: "Wafi",
      product: "Tanah pelaburan",
      status: "Closed",
      createdAt: isoOffset(-5),
      nextFollowUp: "",
      value: 168000,
      units: 1,
      details: { lotNo: "P-08", landPrice: 168000, bookingAmount: 5000, buyerSegment: "Non-Bumi", icFrontRef: "farah-front.jpg", icBackRef: "farah-back.jpg" },
      notes: "Closed one lot. Legal follow-up ongoing."
    },
    {
      id: createId("rec"),
      kind: "lead",
      companyId: "salam-land",
      customerName: "Mizi Hafiz",
      phone: "60123450003",
      source: "TikTok Ads",
      campaignId: SEED_CAMPAIGNS[1].id,
      staff: "Tasha",
      product: "Tanah lot",
      status: "Bluetick",
      createdAt: isoOffset(-36),
      nextFollowUp: isoOffset(0),
      value: 0,
      units: 0,
      details: { location: "Semenyih", buyerSegment: "Tidak pasti" },
      notes: "Read message tetapi belum reply."
    },
    {
      id: createId("rec"),
      kind: "lead",
      companyId: "bumi-hayat",
      customerName: "Kelab FC Mutiara",
      phone: "60123450011",
      source: "Meta Ads",
      campaignId: SEED_CAMPAIGNS[2].id,
      staff: "Amy",
      product: "Futsal",
      status: "Quotation",
      createdAt: isoOffset(0),
      nextFollowUp: isoOffset(1),
      value: 3200,
      units: 40,
      details: { customerType: "Enduser", quantity: 40, designNeed: "Ada design sendiri" },
      notes: "Waiting final size breakdown."
    },
    {
      id: createId("rec"),
      kind: "order",
      companyId: "bumi-hayat",
      customerName: "Akademi MPL Selatan",
      phone: "60123450012",
      source: "Referral",
      campaignId: "",
      staff: "Aiman",
      product: "Esport",
      status: "Closed",
      createdAt: isoOffset(-7),
      nextFollowUp: "",
      value: 5900,
      units: 75,
      details: { quantity: 75, quoteAmount: 5900, depositAmount: 2950, deadline: isoOffset(2), productionStatus: "Delivered" },
      notes: "Delivered and strong repeat potential."
    },
    {
      id: createId("rec"),
      kind: "lead",
      companyId: "bumi-hayat",
      customerName: "SMK Taman Jaya",
      phone: "60123450013",
      source: "TikTok Ads",
      campaignId: SEED_CAMPAIGNS[3].id,
      staff: "Ayu",
      product: "Rumah Sukan",
      status: "Bluetick",
      createdAt: isoOffset(-33),
      nextFollowUp: isoOffset(0),
      value: 0,
      units: 120,
      details: { customerType: "Branch", quantity: 120, designNeed: "Perlu designer" },
      notes: "Belum balas semula selepas tanya range harga."
    },
    {
      id: createId("rec"),
      kind: "lead",
      companyId: "barakah-emas",
      customerName: "Hajar Amin",
      phone: "60123450021",
      source: "Meta Ads",
      campaignId: SEED_CAMPAIGNS[4].id,
      staff: "Nabilah",
      product: "Emas 916",
      status: "Product Suggested",
      createdAt: isoOffset(0),
      nextFollowUp: isoOffset(1),
      value: 0,
      units: 10,
      details: { ageRange: "25-34", transactionType: "Beli dengan kita", grams: 10 },
      notes: "Minta semakan stok gelang 916."
    },
    {
      id: createId("rec"),
      kind: "order",
      companyId: "barakah-emas",
      customerName: "Syafiqah Noor",
      phone: "60123450022",
      source: "Meta Ads",
      campaignId: SEED_CAMPAIGNS[4].id,
      staff: "Nabilah",
      product: "Emas baru",
      status: "Closed",
      createdAt: isoOffset(-2),
      nextFollowUp: "",
      value: 2890,
      units: 7,
      details: { transactionType: "Beli dengan kita", grams: 7, pricePerGram: 413, paymentStatus: "Paid", goldCondition: "Baru" },
      notes: "Closed purchase with COD."
    },
    {
      id: createId("rec"),
      kind: "lead",
      companyId: "barakah-emas",
      customerName: "Aina Salleh",
      phone: "60123450023",
      source: "WhatsApp Business",
      campaignId: "",
      staff: "Nabilah",
      product: "Trade-in emas",
      status: "Bluetick",
      createdAt: isoOffset(-35),
      nextFollowUp: isoOffset(0),
      value: 0,
      units: 5,
      details: { ageRange: "35-44", transactionType: "Trade-in", grams: 5 },
      notes: "Tanya trade-in tapi belum balas semula."
    }
  ]);
}

function defaultCompanyConnection(company) {
  return {
    companyId: company.id,
    metaEnabled: false,
    metaPageId: "",
    metaAdAccountId: "",
    metaFormIds: "",
    metaCampaignId: "",
    metaSpendSyncEnabled: false,
    metaAccessToken: "",
    metaSpendAccessToken: "",
    metaDefaultStaff: company.staff[0] || "",
    metaLeadStatus: "New Lead",
    tiktokEnabled: false,
    tiktokAdvertiserId: "",
    tiktokFormIds: "",
    tiktokCampaignId: "",
    tiktokSpendSyncEnabled: false,
    tiktokLeadMode: "instant-form",
    tiktokCallbackToken: "",
    tiktokAccessToken: "",
    tiktokDefaultStaff: company.staff[0] || "",
    tiktokLeadStatus: "New Lead",
    notes: ""
  };
}

function defaultIntegrations() {
  return {
    publicBaseUrl: "",
    meta: {
      verifyToken: "crm-salam-fortress-meta",
      apiVersion: "v22.0"
    },
    tiktok: {
      callbackToken: "crm-salam-fortress-tiktok",
      leadRetentionDays: 90
    },
    connections: COMPANIES.map(defaultCompanyConnection),
    assignmentCursor: {
      meta: {},
      tiktok: {}
    },
    inboundEvents: []
  };
}

function mergeIntegrations(raw) {
  const defaults = defaultIntegrations();
  const incoming = raw && typeof raw === "object" ? raw : {};
  const connectionMap = new Map((Array.isArray(incoming.connections) ? incoming.connections : []).map((item) => [item.companyId, item]));
  const assignmentCursor = incoming.assignmentCursor && typeof incoming.assignmentCursor === "object" ? incoming.assignmentCursor : {};

  return {
    publicBaseUrl: typeof incoming.publicBaseUrl === "string" ? incoming.publicBaseUrl : defaults.publicBaseUrl,
    meta: {
      ...defaults.meta,
      ...(incoming.meta || {})
    },
    tiktok: {
      ...defaults.tiktok,
      ...(incoming.tiktok || {})
    },
    connections: COMPANIES.map((company) => ({
      ...defaultCompanyConnection(company),
      ...(connectionMap.get(company.id) || {}),
      metaDefaultStaff: normalizeStaffName(company.id, connectionMap.get(company.id)?.metaDefaultStaff || company.staff[0] || ""),
      tiktokDefaultStaff: normalizeStaffName(company.id, connectionMap.get(company.id)?.tiktokDefaultStaff || company.staff[0] || ""),
      notes: replaceLegacyStaffText(connectionMap.get(company.id)?.notes || "")
    })),
    assignmentCursor: {
      meta: Object.fromEntries(Object.entries(assignmentCursor.meta || {}).map(([key, value]) => [key, Number(value) || 0])),
      tiktok: Object.fromEntries(Object.entries(assignmentCursor.tiktok || {}).map(([key, value]) => [key, Number(value) || 0]))
    },
    inboundEvents: Array.isArray(incoming.inboundEvents) ? incoming.inboundEvents.slice(0, 40) : []
  };
}

function defaultWhatsAppRuntime() {
  return {
    settings: {
      id: "whatsapp-salam-land",
      companyId: "salam-land",
      waba_id: "",
      phone_number_id: "",
      access_token_env_key: "WHATSAPP_ACCESS_TOKEN",
      webhook_verify_token: "",
      default_template_name: "",
      default_language_code: "ms",
      test_recipient_number: "",
      is_active: false,
      env_status: {
        status: "missing_config",
        missing: ["phone_number_id", "WHATSAPP_ACCESS_TOKEN", "webhook_verify_token", "default_template_name"],
        has_access_token: false,
        has_webhook_verify_token: false,
        allowed_staff: ["Nureen"],
        graph_api_version: "v22.0"
      }
    },
    messages: [],
    optOuts: [],
    inboundEvents: []
  };
}

function mergeWhatsApp(raw) {
  const defaults = defaultWhatsAppRuntime();
  const incoming = raw && typeof raw === "object" ? raw : {};
  return {
    settings: {
      ...defaults.settings,
      ...(incoming.settings || {}),
      access_token_env_key: String(incoming.settings?.access_token_env_key || defaults.settings.access_token_env_key),
      default_language_code: String(incoming.settings?.default_language_code || defaults.settings.default_language_code)
    },
    messages: Array.isArray(incoming.messages) ? incoming.messages : [],
    optOuts: Array.isArray(incoming.optOuts) ? incoming.optOuts : [],
    inboundEvents: Array.isArray(incoming.inboundEvents) ? incoming.inboundEvents : []
  };
}

const state = {
  activeCompanyId: "salam-land",
  activeSectionId: "overviewSection",
  period: "daily",
  kindFilter: "all",
  statusFilter: "all",
  staffFilter: "all",
  sourceFilter: "all",
  actionFilter: "all",
  dateFilter: "all",
  search: "",
  leadMonthFilter: currentMonthValue(),
  leadDateFilter: todayIso(),
  teamSpendReport: {
    scope: "month",
    month: currentMonthValue(),
    dateFrom: todayIso(),
    dateTo: todayIso(),
    staff: "all",
    showDetails: false
  },
  lotStatusFilter: "all",
  lotSearch: "",
  lotFocusLotNo: "",
  detailContext: null,
  records: [],
  campaigns: [],
  integrations: defaultIntegrations(),
  whatsapp: defaultWhatsAppRuntime(),
  goldRates: defaultGoldRates(),
  control: mergeControl(),
  session: defaultSession(),
  runtime: {
    backendReady: false,
    storageMode: "browser",
    lastSavedAt: "",
    statusMessage: "Preview berjalan dalam browser mode."
  }
};

const refs = {
  entryGate: document.querySelector("#entryGate"),
  fortressShell: document.querySelector("#fortressShell"),
  entryLoginButton: document.querySelector("#entryLoginButton"),
  companyRail: document.querySelector("#companyRail"),
  sectionNav: document.querySelector("#sectionNav"),
  staffRuleList: document.querySelector("#staffRuleList"),
  autoCaptureList: document.querySelector("#autoCaptureList"),
  systemLabel: document.querySelector("#systemLabel"),
  workspaceHeading: document.querySelector("#workspaceHeading"),
  topbarStatus: document.querySelector("#topbarStatus"),
  authButton: document.querySelector("#authButton"),
  notificationButton: document.querySelector("#notificationButton"),
  themeToggleButton: document.querySelector("#themeToggleButton"),
  systemModeBadge: document.querySelector("#systemModeBadge"),
  connectionBadge: document.querySelector("#connectionBadge"),
  showcaseEyebrow: document.querySelector("#showcaseEyebrow"),
  showcaseHeading: document.querySelector("#showcaseHeading"),
  showcaseBadge: document.querySelector("#showcaseBadge"),
  showcaseBoard: document.querySelector("#showcaseBoard"),
  flowEyebrow: document.querySelector("#flowEyebrow"),
  flowHeading: document.querySelector("#flowHeading"),
  flowSummary: document.querySelector("#flowSummary"),
  flowMeta: document.querySelector("#flowMeta"),
  flowRail: document.querySelector("#flowRail"),
  documentHeading: document.querySelector("#documentHeading"),
  documentBoard: document.querySelector("#documentBoard"),
  companyLogo: document.querySelector("#companyLogo"),
  companyLogoWrap: document.querySelector("#companyLogoWrap"),
  heroBrand: document.querySelector("#heroBrand"),
  companyBusiness: document.querySelector("#companyBusiness"),
  companyName: document.querySelector("#companyName"),
  companyTagline: document.querySelector("#companyTagline"),
  heroPills: document.querySelector("#heroPills"),
  todayLeadsCount: document.querySelector("#todayLeadsCount"),
  followUpDueCount: document.querySelector("#followUpDueCount"),
  monthClosedValue: document.querySelector("#monthClosedValue"),
  metricStrip: document.querySelector("#metricStrip"),
  dashboardAnalytics: document.querySelector("#dashboardAnalytics"),
  themeBadge: document.querySelector("#themeBadge"),
  workflowGrid: document.querySelector("#workflowGrid"),
  inputPlan: document.querySelector("#inputPlan"),
  systemBoard: document.querySelector("#systemBoard"),
  integrationBoard: document.querySelector("#integrationBoard"),
  whatsappApiBoard: document.querySelector("#whatsappApiBoard"),
  staffBoard: document.querySelector("#staffBoard"),
  marketingBoard: document.querySelector("#marketingBoard"),
  automationBoard: document.querySelector("#automationBoard"),
  orderBoard: document.querySelector("#orderBoard"),
  accessBoard: document.querySelector("#accessBoard"),
  controlBoard: document.querySelector("#controlBoard"),
  kindFilter: document.querySelector("#kindFilter"),
  statusFilter: document.querySelector("#statusFilter"),
  staffFilter: document.querySelector("#staffFilter"),
  sourceFilter: document.querySelector("#sourceFilter"),
  actionFilter: document.querySelector("#actionFilter"),
  dateFilter: document.querySelector("#dateFilter"),
  searchInput: document.querySelector("#searchInput"),
  leadMonthInput: document.querySelector("#leadMonthInput"),
  leadDateInput: document.querySelector("#leadDateInput"),
  leadDateSummary: document.querySelector("#leadDateSummary"),
  leadCalendarGrid: document.querySelector("#leadCalendarGrid"),
  leadDateBreakdown: document.querySelector("#leadDateBreakdown"),
  lotStatusShell: document.querySelector("#lotStatusShell"),
  lotStatusSummary: document.querySelector("#lotStatusSummary"),
  lotStatusFilter: document.querySelector("#lotStatusFilter"),
  lotSearchInput: document.querySelector("#lotSearchInput"),
  lotStatusMetrics: document.querySelector("#lotStatusMetrics"),
  lotStatusLegend: document.querySelector("#lotStatusLegend"),
  lotStatusDeck: document.querySelector("#lotStatusDeck"),
  lotStatusBoard: document.querySelector("#lotStatusBoard"),
  paymentSummary: document.querySelector("#paymentSummary"),
  paymentStaffGraph: document.querySelector("#paymentStaffGraph"),
  paymentBoard: document.querySelector("#paymentBoard"),
  reportCentreSummary: document.querySelector("#reportCentreSummary"),
  reportCentreBoard: document.querySelector("#reportCentreBoard"),
  reportInlineButton: document.querySelector("#reportInlineButton"),
  recordTable: document.querySelector("#recordTable"),
  detailDialog: document.querySelector("#detailDialog"),
  detailEyebrow: document.querySelector("#detailEyebrow"),
  detailTitle: document.querySelector("#detailTitle"),
  detailContent: document.querySelector("#detailContent"),
  leadDialog: document.querySelector("#leadDialog"),
  leadForm: document.querySelector("#leadForm"),
  leadCompanyInput: document.querySelector("#leadCompanyInput"),
  leadStaffInput: document.querySelector("#leadStaffInput"),
  leadPhoneInput: document.querySelector('#leadForm input[name="phone"]'),
  leadSourceInput: document.querySelector("#leadSourceInput"),
  leadCampaignInput: document.querySelector("#leadCampaignInput"),
  leadProductInput: document.querySelector("#leadProductInput"),
  leadStatusInput: document.querySelector("#leadStatusInput"),
  leadQuickTitle: document.querySelector("#leadQuickTitle"),
  leadQuickFields: document.querySelector("#leadQuickFields"),
  leadDuplicateState: document.querySelector("#leadDuplicateState"),
  leadAllowDuplicateInput: document.querySelector("#leadAllowDuplicateInput"),
  leadFilesInput: document.querySelector("#leadFilesInput"),
  orderDialog: document.querySelector("#orderDialog"),
  orderForm: document.querySelector("#orderForm"),
  orderDialogTitle: document.querySelector("#orderDialogTitle"),
  orderRecordIdInput: document.querySelector("#orderRecordIdInput"),
  orderCompanyInput: document.querySelector("#orderCompanyInput"),
  orderStaffInput: document.querySelector("#orderStaffInput"),
  orderProductInput: document.querySelector("#orderProductInput"),
  orderStatusInput: document.querySelector("#orderStatusInput"),
  orderQuickTitle: document.querySelector("#orderQuickTitle"),
  orderQuickFields: document.querySelector("#orderQuickFields"),
  orderDuplicateState: document.querySelector("#orderDuplicateState"),
  paymentScheduleRows: document.querySelector("#paymentScheduleRows"),
  paymentScheduleSummary: document.querySelector("#paymentScheduleSummary"),
  addPaymentPhaseButton: document.querySelector("#addPaymentPhaseButton"),
  importPaymentScheduleButton: document.querySelector("#importPaymentScheduleButton"),
  pastePaymentScheduleButton: document.querySelector("#pastePaymentScheduleButton"),
  paymentSchedulePasteInput: document.querySelector("#paymentSchedulePasteInput"),
  orderIcFrontInput: document.querySelector("#orderIcFrontInput"),
  orderIcBackInput: document.querySelector("#orderIcBackInput"),
  orderFilesInput: document.querySelector("#orderFilesInput"),
  campaignDialog: document.querySelector("#campaignDialog"),
  campaignForm: document.querySelector("#campaignForm"),
  campaignCompanyInput: document.querySelector("#campaignCompanyInput"),
  reportDialog: document.querySelector("#reportDialog"),
  reportForm: document.querySelector("#reportForm"),
  reportCompanyInput: document.querySelector("#reportCompanyInput"),
  reportStaffInput: document.querySelector("#reportStaffInput"),
  reportScopeInput: document.querySelector("#reportScopeInput"),
  reportMonthInput: document.querySelector("#reportMonthInput"),
  reportDateFromInput: document.querySelector("#reportDateFromInput"),
  reportDateToInput: document.querySelector("#reportDateToInput"),
  reportMonthWrap: document.querySelector("#reportMonthWrap"),
  reportDateFromWrap: document.querySelector("#reportDateFromWrap"),
  reportDateToWrap: document.querySelector("#reportDateToWrap"),
  reportQuickTitle: document.querySelector("#reportQuickTitle"),
  reportHint: document.querySelector("#reportHint"),
  integrationDialog: document.querySelector("#integrationDialog"),
  integrationForm: document.querySelector("#integrationForm"),
  integrationCompanyInput: document.querySelector("#integrationCompanyInput"),
  integrationBaseUrlInput: document.querySelector("#integrationBaseUrlInput"),
  integrationMetaVerifyTokenInput: document.querySelector("#integrationMetaVerifyTokenInput"),
  integrationMetaApiVersionInput: document.querySelector("#integrationMetaApiVersionInput"),
  integrationMetaEnabledInput: document.querySelector("#integrationMetaEnabledInput"),
  integrationMetaPageIdInput: document.querySelector("#integrationMetaPageIdInput"),
  integrationMetaAdAccountIdInput: document.querySelector("#integrationMetaAdAccountIdInput"),
  integrationMetaFormIdsInput: document.querySelector("#integrationMetaFormIdsInput"),
  integrationMetaCampaignInput: document.querySelector("#integrationMetaCampaignInput"),
  integrationMetaSpendSyncInput: document.querySelector("#integrationMetaSpendSyncInput"),
  integrationMetaAccessTokenInput: document.querySelector("#integrationMetaAccessTokenInput"),
  integrationMetaSpendAccessTokenInput: document.querySelector("#integrationMetaSpendAccessTokenInput"),
  integrationMetaStaffInput: document.querySelector("#integrationMetaStaffInput"),
  integrationMetaStatusInput: document.querySelector("#integrationMetaStatusInput"),
  integrationTikTokEnabledInput: document.querySelector("#integrationTikTokEnabledInput"),
  integrationTikTokAdvertiserIdInput: document.querySelector("#integrationTikTokAdvertiserIdInput"),
  integrationTikTokFormIdsInput: document.querySelector("#integrationTikTokFormIdsInput"),
  integrationTikTokCampaignInput: document.querySelector("#integrationTikTokCampaignInput"),
  integrationTikTokSpendSyncInput: document.querySelector("#integrationTikTokSpendSyncInput"),
  integrationTikTokLeadModeInput: document.querySelector("#integrationTikTokLeadModeInput"),
  integrationTikTokCallbackTokenInput: document.querySelector("#integrationTikTokCallbackTokenInput"),
  integrationTikTokAccessTokenInput: document.querySelector("#integrationTikTokAccessTokenInput"),
  integrationTikTokStaffInput: document.querySelector("#integrationTikTokStaffInput"),
  integrationTikTokStatusInput: document.querySelector("#integrationTikTokStatusInput"),
  integrationNotesInput: document.querySelector("#integrationNotesInput"),
  integrationQuickTitle: document.querySelector("#integrationQuickTitle"),
  metaWebhookPreview: document.querySelector("#metaWebhookPreview"),
  tiktokWebhookPreview: document.querySelector("#tiktokWebhookPreview"),
  storageModePreview: document.querySelector("#storageModePreview"),
  integrationHint: document.querySelector("#integrationHint"),
  whatsappDialog: document.querySelector("#whatsappDialog"),
  whatsappForm: document.querySelector("#whatsappForm"),
  whatsappStatusPreview: document.querySelector("#whatsappStatusPreview"),
  whatsappWebhookPreview: document.querySelector("#whatsappWebhookPreview"),
  whatsappWabaIdInput: document.querySelector("#whatsappWabaIdInput"),
  whatsappPhoneNumberIdInput: document.querySelector("#whatsappPhoneNumberIdInput"),
  whatsappAccessTokenEnvInput: document.querySelector("#whatsappAccessTokenEnvInput"),
  whatsappVerifyTokenInput: document.querySelector("#whatsappVerifyTokenInput"),
  whatsappTemplateInput: document.querySelector("#whatsappTemplateInput"),
  whatsappLanguageInput: document.querySelector("#whatsappLanguageInput"),
  whatsappTestRecipientInput: document.querySelector("#whatsappTestRecipientInput"),
  whatsappActiveInput: document.querySelector("#whatsappActiveInput"),
  whatsappRegisterPinInput: document.querySelector("#whatsappRegisterPinInput"),
  whatsappHint: document.querySelector("#whatsappHint"),
  controlDialog: document.querySelector("#controlDialog"),
  controlForm: document.querySelector("#controlForm"),
  controlProfileInput: document.querySelector("#controlProfileInput"),
  controlFollowUpDaysInput: document.querySelector("#controlFollowUpDaysInput"),
  controlDedupeDaysInput: document.querySelector("#controlDedupeDaysInput"),
  controlReminderDaysInput: document.querySelector("#controlReminderDaysInput"),
  controlAutoBackupInput: document.querySelector("#controlAutoBackupInput"),
  controlBackupRetentionInput: document.querySelector("#controlBackupRetentionInput"),
  controlQuickTitle: document.querySelector("#controlQuickTitle"),
  controlPreview: document.querySelector("#controlPreview"),
  controlHint: document.querySelector("#controlHint"),
  loginDialog: document.querySelector("#loginDialog"),
  loginForm: document.querySelector("#loginForm"),
  loginUsernameInput: document.querySelector("#loginUsernameInput"),
  loginPasswordInput: document.querySelector("#loginPasswordInput"),
  loginHint: document.querySelector("#loginHint"),
  loginError: document.querySelector("#loginError"),
  notificationStaffDialog: document.querySelector("#notificationStaffDialog"),
  notificationStaffOptions: document.querySelector("#notificationStaffOptions")
};

let searchRenderTimer = 0;
let goldRateRefreshTimer = 0;
let goldRateRequest = null;
let sectionScrollFrame = 0;
let statePollTimer = 0;
let knownLeadIds = new Set();
let notificationWorkerPromise = null;
let notificationStaffResolve = null;
const NOTIFICATION_STAFF_PREFIX = "crm-salam-fortress-push-staff";
const NOTIFICATION_ALL_STAFF = "__all__";

function notificationStaffLabel(staffName = "") {
  return staffName === NOTIFICATION_ALL_STAFF ? "All Salam team" : staffName;
}

function inferCampaignCreatedAt(campaignId, records) {
  const earliestRecord = records
    .filter((record) => record.campaignId === campaignId)
    .sort((a, b) => recordDateKey(a).localeCompare(recordDateKey(b)))[0];
  return earliestRecord ? recordDateKey(earliestRecord) : todayIso();
}

function loadState() {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (!stored) {
    state.records = buildSeedRecords();
    state.campaigns = clone(SEED_CAMPAIGNS);
    state.integrations = defaultIntegrations();
    state.whatsapp = defaultWhatsAppRuntime();
    state.goldRates = defaultGoldRates();
    state.control = mergeControl();
    saveState();
    return;
  }

  try {
    const parsed = JSON.parse(stored);
    state.records = normalizeRecordList(Array.isArray(parsed.records) ? parsed.records : buildSeedRecords());
    state.campaigns = Array.isArray(parsed.campaigns) ? parsed.campaigns : clone(SEED_CAMPAIGNS);
    state.integrations = mergeIntegrations(parsed.integrations);
    state.whatsapp = mergeWhatsApp(parsed.whatsapp);
    state.goldRates = {
      ...defaultGoldRates(),
      ...(parsed.goldRates || {})
    };
    state.control = mergeControl(parsed.control);
  } catch {
    state.records = buildSeedRecords();
    state.campaigns = clone(SEED_CAMPAIGNS);
    state.integrations = defaultIntegrations();
    state.whatsapp = defaultWhatsAppRuntime();
    state.goldRates = defaultGoldRates();
    state.control = mergeControl();
  }

  state.campaigns = state.campaigns.map((campaign) => ({
    createdAt: campaign.createdAt || inferCampaignCreatedAt(campaign.id, state.records),
    ...campaign
  }));
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    records: state.records,
    campaigns: state.campaigns,
    integrations: state.integrations,
    whatsapp: state.whatsapp,
    goldRates: state.goldRates,
    control: state.control
  }));
}

function loadSessionState() {
  try {
    const raw = SESSION_STORAGE.getItem(SESSION_KEY);
    if (!raw) {
      state.session = defaultSession();
      return;
    }
    const parsed = JSON.parse(raw);
    state.session = {
      ...defaultSession(),
      ...(parsed || {}),
      authenticated: Boolean(parsed?.token && parsed?.authenticated)
    };
  } catch {
    state.session = defaultSession();
  }
}

function hasGlobalAccess(profile) {
  return GLOBAL_ACCESS_ROLES.has((profile || activeProfile()).role);
}

function canUsePremiumTheme(profile = activeProfile()) {
  return hasGlobalAccess(profile) || profile.role === "management";
}

function currentThemeMode() {
  const profile = activeProfile();
  const savedMode = state.control.settings.themeMode === "dark" ? "dark" : "light";
  return canUsePremiumTheme(profile) ? savedMode : "light";
}

function accessLocked() {
  return state.runtime.backendReady && !state.session.authenticated;
}

function saveSessionState() {
  SESSION_STORAGE.setItem(SESSION_KEY, JSON.stringify(state.session));
}

function clearSessionState() {
  state.session = defaultSession();
  SESSION_STORAGE.removeItem(SESSION_KEY);
  sessionStorage.removeItem(SESSION_KEY);
}

function activeConnection(companyId = state.activeCompanyId) {
  return state.integrations.connections.find((connection) => connection.companyId === companyId) || defaultCompanyConnection(companyById(companyId));
}

function currentBaseUrl() {
  const configured = String(state.integrations.publicBaseUrl || "").trim();
  if (configured) return configured.replace(/\/+$/, "");
  if (window.location.protocol.startsWith("http")) return window.location.origin;
  return "https://your-domain.com";
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      ...(state.session.token ? { Authorization: `Bearer ${state.session.token}` } : {}),
      ...(options.headers || {})
    },
    ...options
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  if (response.status === 204) return null;
  return response.json();
}

function normalizeGoldRates(payload, sourceMode = "browser") {
  const ounceUsd = Number(payload?.ounceUsd ?? payload?.gold?.price ?? 0);
  const usdMyr = Number(payload?.usdMyr ?? payload?.fx?.rates?.MYR ?? 0);
  const baseMyrPerGram = ounceUsd && usdMyr ? (ounceUsd / TROY_OUNCE_IN_GRAMS) * usdMyr : 0;
  return {
    ...defaultGoldRates(),
    ...(payload || {}),
    sourceMode,
    ounceUsd,
    usdMyr,
    gram999: Number(payload?.gram999 ?? (baseMyrPerGram * GOLD_PURITY["999"])),
    gram916: Number(payload?.gram916 ?? (baseMyrPerGram * GOLD_PURITY["916"])),
    fetchedAt: payload?.fetchedAt || new Date().toISOString(),
    updatedAt: payload?.updatedAt || payload?.gold?.updatedAt || "",
    fxDate: payload?.fxDate || payload?.fx?.date || "",
    error: payload?.error || ""
  };
}

function goldRatesAreFresh() {
  if (!state.goldRates.fetchedAt) return false;
  return Date.now() - new Date(state.goldRates.fetchedAt).getTime() < GOLD_RATE_STALE_MS;
}

async function fetchGoldRatesDirect() {
  const [gold, fx] = await Promise.all([
    fetchJson("https://api.gold-api.com/price/XAU", { headers: {} }),
    fetchJson("https://api.frankfurter.dev/v1/latest?base=USD&symbols=MYR", { headers: {} })
  ]);
  return normalizeGoldRates({
    gold,
    fx,
    fetchedAt: new Date().toISOString(),
    updatedAt: gold.updatedAt || "",
    fxDate: fx.date || ""
  }, "browser");
}

async function fetchGoldRates(force = false) {
  if (goldRateRequest && !force) return goldRateRequest;
  if (!force && goldRatesAreFresh()) return state.goldRates;

  state.goldRates = {
    ...state.goldRates,
    status: state.goldRates.fetchedAt ? "refreshing" : "loading",
    error: ""
  };
  if (state.activeCompanyId === "barakah-emas") renderShowcase();

  goldRateRequest = (async () => {
    try {
      const payload = state.runtime.backendReady
        ? await fetchJson("./api/rates/gold")
        : await fetchGoldRatesDirect();
      state.goldRates = normalizeGoldRates(payload, state.runtime.backendReady ? "server" : "browser");
      saveState();
      renderShowcase();
      return state.goldRates;
    } catch (error) {
      state.goldRates = {
        ...state.goldRates,
        status: state.goldRates.fetchedAt ? "stale" : "error",
        error: error.message || "Gold rate fetch failed"
      };
      saveState();
      renderShowcase();
      return state.goldRates;
    } finally {
      goldRateRequest = null;
    }
  })();

  return goldRateRequest;
}

function scheduleGoldRatesRefresh() {
  window.clearInterval(goldRateRefreshTimer);
  goldRateRefreshTimer = window.setInterval(() => {
    fetchGoldRates();
  }, GOLD_RATE_REFRESH_MS);
}

async function hydrateFromApi() {
  try {
    const health = await fetchJson("./api/health");
    state.runtime.backendReady = true;
    state.runtime.storageMode = "server";
    state.runtime.statusMessage = "Server mode aktif. Login diperlukan untuk akses data live, backup dan integrations.";
    const validSession = await validateSession();
    if (validSession) {
      await hydrateProtectedState();
      state.runtime.statusMessage = "Server mode aktif. Data, webhook, upload fail dan publish layer berjalan dari backend.";
    } else {
      state.session.required = true;
    }

    state.runtime.lastSavedAt = health.updatedAt ? localDateTimeLabel(new Date(health.updatedAt)) : state.runtime.lastSavedAt;
    if (health.control?.lastBackupAt) {
      state.control.lastBackupAt = health.control.lastBackupAt;
    }
  } catch {
    state.runtime.backendReady = false;
    state.runtime.storageMode = "browser";
    state.runtime.statusMessage = "Preview berjalan dalam browser mode. Untuk webhook live dan publish production, run server mode.";
  }
}

async function persistState() {
  saveState();
  updateLocalBackupSnapshot();
  state.runtime.lastSavedAt = localDateTimeLabel(new Date());
  if (!state.runtime.backendReady) return;

  try {
    const serverState = await fetchJson("./api/state", {
      method: "PUT",
      body: JSON.stringify({
        records: state.records,
        campaigns: state.campaigns,
        integrations: state.integrations,
        goldRates: state.goldRates,
        control: state.control
      })
    });
    const serverRecords = normalizeRecordList(Array.isArray(serverState.records) ? serverState.records : []);
    if (serverRecords.length) state.records = serverRecords;
    state.campaigns = Array.isArray(serverState.campaigns) ? serverState.campaigns : state.campaigns;
    state.integrations = mergeIntegrations(serverState.integrations);
    state.whatsapp = mergeWhatsApp(serverState.whatsapp);
    state.goldRates = serverState.goldRates ? normalizeGoldRates(serverState.goldRates, "server") : state.goldRates;
    state.control = serverState.control ? mergeControl(serverState.control) : state.control;
    saveState();
  } catch {
    pushRuntimeError("Server mode terputus semasa simpan state. Sistem fallback ke browser mode.");
    saveState();
    state.runtime.backendReady = false;
    state.runtime.storageMode = "browser";
    state.runtime.statusMessage = "Server mode terputus. Sistem fallback ke browser mode supaya kerja tak hilang.";
  }
}

function mergeUpdatedRecord(updatedRecord) {
  if (!updatedRecord?.id) return null;
  const normalized = normalizeRecordList([updatedRecord])[0];
  const index = state.records.findIndex((record) => record.id === normalized.id);
  if (index >= 0) {
    state.records[index] = {
      ...state.records[index],
      ...normalized
    };
  } else {
    state.records.unshift(normalized);
  }
  saveState();
  return normalized;
}

async function persistRecordStatus(record) {
  saveState();
  updateLocalBackupSnapshot();
  state.runtime.lastSavedAt = localDateTimeLabel(new Date());
  if (!state.runtime.backendReady || !state.session.authenticated) {
    await persistState();
    return record;
  }

  const payload = await fetchJson("./api/records/status", {
    method: "PATCH",
    body: JSON.stringify({
      recordId: record.id,
      status: record.status,
      actionFlags: record.actionFlags,
      nextFollowUp: record.nextFollowUp || "",
      updatedAt: record.updatedAt || new Date().toISOString()
    })
  });
  if (payload?.record) return mergeUpdatedRecord(payload.record);
  return record;
}

async function persistIntegrations() {
  saveState();
  updateLocalBackupSnapshot();
  state.runtime.lastSavedAt = localDateTimeLabel(new Date());
  if (!state.runtime.backendReady) return;

  try {
    const payload = await fetchJson("./api/integrations", {
      method: "PUT",
      body: JSON.stringify(state.integrations)
    });
    state.integrations = mergeIntegrations(payload);
  } catch {
    pushRuntimeError("Integrations gagal disimpan ke server. Sistem simpan lokal dahulu.");
    saveState();
    state.runtime.backendReady = false;
    state.runtime.storageMode = "browser";
    state.runtime.statusMessage = "Integrations disimpan lokal. Run server mode untuk webhook hidup.";
  }
}

async function syncReportSpendData(companyId, staff, range) {
  if (!state.runtime.backendReady || !state.session.authenticated) return null;
  const payload = await fetchJson("./api/reports/spend-sync", {
    method: "POST",
    body: JSON.stringify({
      companyId,
      staff,
      dateFrom: range.dateFrom,
      dateTo: range.dateTo
    })
  });
  if (payload?.state) {
    const serverState = payload.state;
    state.records = normalizeRecordList(Array.isArray(serverState.records) ? serverState.records : state.records);
    state.campaigns = Array.isArray(serverState.campaigns) ? serverState.campaigns : state.campaigns;
    state.integrations = mergeIntegrations(serverState.integrations);
    state.whatsapp = mergeWhatsApp(serverState.whatsapp);
    state.goldRates = serverState.goldRates ? normalizeGoldRates(serverState.goldRates, "server") : state.goldRates;
    state.control = serverState.control ? mergeControl(serverState.control) : state.control;
    saveState();
  }
  if (payload?.errors?.length) {
    pushRuntimeError(`Ads spend sync partial: ${payload.errors.slice(0, 2).map((item) => item.message).join(" | ")}`);
  }
  return payload;
}

async function syncCurrentTeamSpendReport() {
  const company = activeCompany();
  const report = buildTeamSalesSpendReport(company.id);
  await syncReportSpendData(company.id, report.staffFilter, report.range);
  renderReportCenter();
}

function canManageWhatsAppSettings() {
  return state.session.authenticated && hasGlobalAccess(state.session.user);
}

function whatsappStatusLabel(status = "") {
  if (status === "connected") return "Connected";
  if (status === "configured_inactive") return "Configured / inactive";
  return "Missing config";
}

function fillWhatsAppSettingsForm() {
  if (!refs.whatsappForm) return;
  const settings = mergeWhatsApp(state.whatsapp).settings;
  refs.whatsappWabaIdInput.value = settings.waba_id || "";
  refs.whatsappPhoneNumberIdInput.value = settings.phone_number_id || "";
  refs.whatsappAccessTokenEnvInput.value = settings.access_token_env_key || "WHATSAPP_ACCESS_TOKEN";
  refs.whatsappVerifyTokenInput.value = settings.webhook_verify_token === "__env__" ? "" : settings.webhook_verify_token || "";
  refs.whatsappTemplateInput.value = settings.default_template_name || "";
  refs.whatsappLanguageInput.value = settings.default_language_code || "ms";
  refs.whatsappTestRecipientInput.value = settings.test_recipient_number || "";
  refs.whatsappActiveInput.value = String(Boolean(settings.is_active));
  updateWhatsAppSettingsPreview();
}

function updateWhatsAppSettingsPreview() {
  if (!refs.whatsappStatusPreview) return;
  const settings = mergeWhatsApp(state.whatsapp).settings;
  const envStatus = settings.env_status || {};
  const missing = Array.isArray(envStatus.missing) ? envStatus.missing : [];
  refs.whatsappWebhookPreview.textContent = `${currentBaseUrl()}/api/webhooks/whatsapp`;
  refs.whatsappStatusPreview.innerHTML = `
    <span class="meta-pill ${envStatus.status === "connected" ? "success" : ""}">${whatsappStatusLabel(envStatus.status)}</span>
    <span class="meta-pill">${settings.is_active ? "Auto send on" : "Auto send off"}</span>
    <span class="meta-pill">${envStatus.has_access_token ? "ENV token ready" : "ENV token missing"}</span>
    <span class="meta-pill">${settings.default_template_name || "No template"}</span>
    ${missing.length ? `<span class="meta-pill warning">Missing: ${missing.map(escapeHtml).join(", ")}</span>` : ""}
  `;
}

async function loadWhatsAppSettings() {
  if (!state.runtime.backendReady || !state.session.authenticated) return;
  try {
    state.whatsapp = mergeWhatsApp(await fetchJson("./api/whatsapp/settings"));
    saveState();
  } catch (error) {
    pushRuntimeError(error.message || "WhatsApp settings gagal dibaca.");
  }
}

async function openWhatsAppSettingsDialog() {
  if (!canManageWhatsAppSettings()) {
    window.alert("WhatsApp Cloud API settings hanya untuk Admin/Management.");
    return;
  }
  await loadWhatsAppSettings();
  fillWhatsAppSettingsForm();
  if (!refs.whatsappDialog.open) refs.whatsappDialog.showModal();
}

async function saveWhatsAppSettings(options = {}) {
  const silent = Boolean(options.silent);
  if (!refs.whatsappForm.reportValidity()) return false;
  const formData = new FormData(refs.whatsappForm);
  const payload = {
    waba_id: String(formData.get("waba_id") || "").trim(),
    phone_number_id: String(formData.get("phone_number_id") || "").trim(),
    access_token_env_key: String(formData.get("access_token_env_key") || "WHATSAPP_ACCESS_TOKEN").trim(),
    webhook_verify_token: String(formData.get("webhook_verify_token") || "").trim(),
    default_template_name: String(formData.get("default_template_name") || "").trim(),
    default_language_code: String(formData.get("default_language_code") || "ms").trim(),
    test_recipient_number: normalizePhone(formData.get("test_recipient_number") || ""),
    is_active: String(formData.get("is_active")) === "true"
  };
  try {
    state.whatsapp = mergeWhatsApp(await fetchJson("./api/whatsapp/settings", {
      method: "PUT",
      body: JSON.stringify(payload)
    }));
    saveState();
    updateWhatsAppSettingsPreview();
    logActivity({
      action: "WhatsApp settings updated",
      companyId: "salam-land",
      detail: `Cloud API ${payload.is_active ? "enabled" : "disabled"} / ${payload.default_template_name || "no template"}`
    });
    renderIntegrationBoard();
    if (!silent) window.alert("WhatsApp Cloud API settings saved.");
    return true;
  } catch (error) {
    if (!silent) window.alert(error.message || "WhatsApp settings gagal disimpan.");
    return false;
  }
}

async function sendWhatsAppTestMessage() {
  if (!refs.whatsappForm.reportValidity()) return;
  const payload = {
    phoneNumber: refs.whatsappTestRecipientInput.value,
    templateName: refs.whatsappTemplateInput.value,
    languageCode: refs.whatsappLanguageInput.value || "ms"
  };
  try {
    const response = await fetchJson("./api/whatsapp/test", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    await loadWhatsAppSettings();
    fillWhatsAppSettingsForm();
    window.alert(response.ok ? "Test WhatsApp dihantar." : `Test WhatsApp gagal: ${response.message?.error_message || response.status}`);
  } catch (error) {
    window.alert(error.message || "Test WhatsApp gagal.");
  }
}

async function registerWhatsAppCloudNumber() {
  if (!canManageWhatsAppSettings()) {
    window.alert("WhatsApp Cloud API registration hanya untuk Admin/Management.");
    return;
  }
  const phoneNumberId = String(refs.whatsappPhoneNumberIdInput?.value || "").trim();
  const pin = String(refs.whatsappRegisterPinInput?.value || "").trim();
  if (!phoneNumberId) {
    window.alert("Masukkan Phone Number ID dahulu.");
    refs.whatsappPhoneNumberIdInput?.focus();
    return;
  }
  if (pin && !/^\d{6}$/.test(pin)) {
    window.alert("PIN mesti 6 digit jika diisi. Jika nombor belum boleh ON two-step, kosongkan PIN dan cuba register dahulu.");
    refs.whatsappRegisterPinInput?.focus();
    return;
  }

  try {
    const saved = await saveWhatsAppSettings({ silent: true });
    if (!saved) throw new Error("WhatsApp settings gagal disimpan sebelum register.");
    const response = await fetchJson("./api/whatsapp/register-phone", {
      method: "POST",
      body: JSON.stringify({ phoneNumberId, pin })
    });
    refs.whatsappRegisterPinInput.value = "";
    await loadWhatsAppSettings();
    fillWhatsAppSettingsForm();
    renderIntegrationBoard();
    window.alert(response.ok ? "Nombor berjaya didaftarkan dengan WhatsApp Cloud API." : "Register Cloud API selesai dengan status tidak pasti.");
  } catch (error) {
    window.alert(error.message || "Register Cloud API gagal. Semak token ENV, Phone Number ID dan PIN.");
  }
}

function openLoginDialog(message = "") {
  refs.loginHint.textContent = state.runtime.backendReady
    ? "Server mode perlukan login untuk buka data live, integrations, backup dan upload fail."
    : "Browser mode tak perlukan login, tapi server mode perlukan authentication.";
  refs.loginError.innerHTML = message
    ? `<span>${message}</span>`
    : `
      <span class="login-access-label">Access prepared by group</span>
      <span class="login-chip">Admin</span>
      <span class="login-chip">Management</span>
      <span class="login-chip">Salam Land</span>
      <span class="login-chip">Bumi Hayat</span>
      <span class="login-chip">Barakah Emas</span>
    `;
  if (!refs.loginDialog.open) {
    refs.loginDialog.showModal();
  }
}

async function hydrateProtectedState() {
  const serverState = await fetchJson("./api/state");
  const serverRecords = normalizeRecordList(Array.isArray(serverState.records) ? serverState.records : []);
  const serverCampaigns = Array.isArray(serverState.campaigns) ? serverState.campaigns : [];
  const serverIntegrations = mergeIntegrations(serverState.integrations);
  const serverWhatsApp = mergeWhatsApp(serverState.whatsapp);
  const serverGoldRates = normalizeGoldRates(serverState.goldRates || {}, "server");
  const serverControl = mergeControl(serverState.control);

  state.records = serverRecords.length ? serverRecords : state.records;
  state.campaigns = serverCampaigns.length ? serverCampaigns : state.campaigns;
  state.integrations = serverIntegrations;
  state.whatsapp = serverWhatsApp;
  state.goldRates = serverGoldRates.fetchedAt ? serverGoldRates : state.goldRates;
  state.control = serverControl;
}

function leadNotificationTitle(record) {
  return record.companyId === "salam-land" ? "Salam Land Lead" : "CRM Salam Fortress";
}

function leadNotificationBody(record) {
  const campaign = campaignName(record.campaignId);
  return `${record.customerName || "Lead baru"} • ${record.source || "Source"} • ${record.staff || "Staff"}${campaign ? ` • ${campaign}` : ""}`;
}

function notificationSupported() {
  return "Notification" in window;
}

function canUseServiceWorkerNotifications() {
  return "serviceWorker" in navigator && (window.location.protocol === "https:" || window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1");
}

function base64UrlToUint8Array(value = "") {
  const padded = `${value}${"=".repeat((4 - (value.length % 4)) % 4)}`;
  const base64 = padded.replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}

function registerNotificationWorker() {
  if (!canUseServiceWorkerNotifications()) return Promise.resolve(null);
  if (!notificationWorkerPromise) {
    notificationWorkerPromise = navigator.serviceWorker.register("./sw.js").then(() => navigator.serviceWorker.ready).catch(() => null);
  }
  return notificationWorkerPromise;
}

function notificationStaffKey(companyId = state.activeCompanyId) {
  return `${NOTIFICATION_STAFF_PREFIX}:${companyId}`;
}

function notificationStaffForCompany(companyId = state.activeCompanyId) {
  const company = companyById(companyId);
  const profile = activeProfile();
  if (profile.role === "staff" && profile.companyId === companyId && company.staff.includes(profile.staffName)) {
    return profile.staffName;
  }
  const stored = localStorage.getItem(notificationStaffKey(companyId)) || "";
  if (stored === NOTIFICATION_ALL_STAFF && profile.role !== "staff") return stored;
  return company.staff.includes(stored) ? stored : "";
}

function chooseNotificationStaff(companyId = state.activeCompanyId) {
  const company = companyById(companyId);
  const current = notificationStaffForCompany(companyId);
  const selectedFromFilter = state.staffFilter !== "all" && company.staff.includes(state.staffFilter) ? state.staffFilter : "";
  if (selectedFromFilter) {
    localStorage.setItem(notificationStaffKey(companyId), selectedFromFilter);
    return selectedFromFilter;
  }
  if (current) return current;
  if (company.staff.length === 1) {
    localStorage.setItem(notificationStaffKey(companyId), company.staff[0]);
    return company.staff[0];
  }
  return "";
}

function renderNotificationStaffPicker(companyId = state.activeCompanyId) {
  if (!refs.notificationStaffOptions) return;
  const company = companyById(companyId);
  const profile = activeProfile();
  const current = notificationStaffForCompany(companyId);
  const options = [
    ...(profile.role !== "staff" ? [{
      staffName: NOTIFICATION_ALL_STAFF,
      title: company.id === "salam-land" ? "All Salam team" : `All ${company.name}`,
      note: "Terima semua lead company ini pada device ini"
    }] : []),
    ...company.staff.map((staffName) => ({
      staffName,
      title: staffName,
      note: "Terima noti lead assigned"
    }))
  ];
  refs.notificationStaffOptions.innerHTML = options.map((option) => `
    <button class="notification-staff-option ${current === option.staffName ? "active" : ""}" type="button" data-notification-staff="${escapeAttribute(option.staffName)}">
      <strong>${escapeHtml(option.title)}</strong>
      <span>${current === option.staffName ? "Aktif pada device ini" : escapeHtml(option.note)}</span>
    </button>
  `).join("");
}

function fallbackPromptNotificationStaff(companyId = state.activeCompanyId) {
  const company = companyById(companyId);
  const profile = activeProfile();
  const options = [
    ...(profile.role !== "staff" ? [NOTIFICATION_ALL_STAFF] : []),
    ...company.staff
  ];
  const label = options.map((item) => item === NOTIFICATION_ALL_STAFF ? "all" : item).join(", ");
  const answer = window.prompt(`Pilih noti untuk device ini. Taip salah satu: ${label}`, options[0] === NOTIFICATION_ALL_STAFF ? "all" : options[0]);
  if (!answer) return "";
  const normalized = String(answer).trim().toLowerCase();
  if (normalized === "all" && options.includes(NOTIFICATION_ALL_STAFF)) return NOTIFICATION_ALL_STAFF;
  return options.find((item) => item.toLowerCase() === normalized) || "";
}

function closeNotificationStaffDialog(staffName = "") {
  if (staffName) {
    localStorage.setItem(notificationStaffKey(), staffName);
  }
  const resolver = notificationStaffResolve;
  notificationStaffResolve = null;
  if (refs.notificationStaffDialog?.open) {
    refs.notificationStaffDialog.close(staffName);
  }
  if (resolver) resolver(staffName);
}

function pickNotificationStaff(companyId = state.activeCompanyId, { forcePicker = false } = {}) {
  const company = companyById(companyId);
  const profile = activeProfile();
  if (profile.role === "staff" && profile.companyId === companyId && company.staff.includes(profile.staffName)) {
    localStorage.setItem(notificationStaffKey(companyId), profile.staffName);
    return Promise.resolve(profile.staffName);
  }
  if (!forcePicker && company.staff.length === 1) {
    localStorage.setItem(notificationStaffKey(companyId), company.staff[0]);
    return Promise.resolve(company.staff[0]);
  }
  if (!forcePicker) {
    const current = notificationStaffForCompany(companyId);
    if (current) return Promise.resolve(current);
  }
  renderNotificationStaffPicker(companyId);
  return new Promise((resolve) => {
    notificationStaffResolve = (staffName) => {
      if (staffName) localStorage.setItem(notificationStaffKey(companyId), staffName);
      resolve(staffName);
    };
    if (refs.notificationStaffDialog?.showModal) {
      refs.notificationStaffDialog.showModal();
    } else {
      const fallback = fallbackPromptNotificationStaff(companyId);
      closeNotificationStaffDialog(fallback);
    }
  });
}

function syncNotificationButton() {
  if (!refs.notificationButton) return;
  if (!notificationSupported()) {
    refs.notificationButton.hidden = true;
    return;
  }
  refs.notificationButton.hidden = accessLocked();
  refs.notificationButton.disabled = accessLocked();
  if (Notification.permission === "granted") {
    const staffName = notificationStaffForCompany();
    refs.notificationButton.textContent = staffName ? `Noti: ${notificationStaffLabel(staffName)}` : "Pilih staff noti";
    refs.notificationButton.title = staffName
      ? staffName === NOTIFICATION_ALL_STAFF
        ? "Push notification aktif untuk semua lead Salam Land pada device ini."
        : `Push notification aktif untuk lead yang auto assign kepada ${staffName}.`
      : "Klik untuk pilih team sales bagi phone/laptop ini.";
  } else if (Notification.permission === "denied") {
    refs.notificationButton.textContent = "Noti blocked";
    refs.notificationButton.title = "Browser block notification. Buka site settings untuk allow notification.";
  } else {
    refs.notificationButton.textContent = "Enable noti";
    refs.notificationButton.title = "Klik untuk pilih nama team sales dan aktifkan push notification pada device ini.";
  }
}

async function subscribeDeviceToPush(registration, staffName) {
  if (!registration?.pushManager) {
    throw new Error("Browser ini belum support web push penuh.");
  }
  const payload = await fetchJson("./api/push/public-key");
  const existingSubscription = await registration.pushManager.getSubscription();
  const subscription = existingSubscription || await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: base64UrlToUint8Array(payload.publicKey)
  });
  await fetchJson("./api/push/subscribe", {
    method: "POST",
    body: JSON.stringify({
      subscription: subscription.toJSON ? subscription.toJSON() : subscription,
      companyId: state.activeCompanyId,
      staffName,
      device: {
        userAgent: navigator.userAgent,
        platform: navigator.platform || "",
        language: navigator.language || ""
      }
    })
  });
  return subscription;
}

async function requestLeadNotificationPermission() {
  if (!notificationSupported()) {
    window.alert("Browser/device ini belum support web notification untuk CRM.");
    return false;
  }
  const staffName = await pickNotificationStaff(state.activeCompanyId, { forcePicker: true });
  if (!staffName) {
    return false;
  }
  if (Notification.permission === "denied") {
    syncNotificationButton();
    window.alert("Notification sedang blocked. Buka browser Site Settings untuk salamland.my dan set Notifications kepada Allow.");
    return false;
  }
  if (Notification.permission === "default") {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      syncNotificationButton();
      return false;
    }
  }
  const registration = await registerNotificationWorker();
  if (!registration?.pushManager) {
    window.alert("Untuk iPhone, buka Safari > Share > Add to Home Screen, kemudian buka CRM dari icon Home Screen dan tekan Enable noti semula. Android/laptop biasanya boleh terus dari browser.");
    return false;
  }
  await subscribeDeviceToPush(registration, staffName);
  syncNotificationButton();
  window.alert(staffName === NOTIFICATION_ALL_STAFF
    ? "Noti aktif untuk semua lead Salam Land pada phone/laptop ini."
    : `Noti aktif untuk ${staffName}. Lead baru yang auto assign kepada ${staffName} akan masuk ke phone/laptop ini.`);
  return true;
}

function primeLeadNotifications() {
  knownLeadIds = new Set(state.records.filter((record) => record.kind === "lead").map((record) => record.id));
}

function notifyLead(record) {
  if (!record || record.kind !== "lead") return;
  if (!notificationSupported() || Notification.permission !== "granted") return;
  const selectedStaff = notificationStaffForCompany(record.companyId);
  if (selectedStaff !== NOTIFICATION_ALL_STAFF && selectedStaff !== record.staff) return;
  const notificationPayload = {
      body: leadNotificationBody(record),
      tag: `crm-lead-${record.id}`,
      icon: "./assets/salam-land-logo-2026.jpeg",
      badge: "./assets/salam-land-logo-2026.jpeg",
      data: { url: `${window.location.origin}/?preview=desktop` }
    };
  registerNotificationWorker().then((registration) => {
    if (registration?.showNotification) {
      registration.showNotification(leadNotificationTitle(record), notificationPayload);
      return;
    }
    new Notification(leadNotificationTitle(record), notificationPayload);
  }).catch(() => {
    new Notification(leadNotificationTitle(record), notificationPayload);
  });
}

async function refreshLiveState({ notify = false } = {}) {
  if (!state.runtime.backendReady || !state.session.authenticated) return;
  if (refs.orderDialog?.open || refs.leadDialog?.open) {
    return;
  }
  const previousIds = new Set(knownLeadIds);
  await hydrateProtectedState();
  if (notify) {
    state.records
      .filter((record) => record.kind === "lead" && !previousIds.has(record.id))
      .forEach((record) => notifyLead(record));
  }
  primeLeadNotifications();
  render();
}

function startLiveStatePolling() {
  window.clearInterval(statePollTimer);
  if (!state.runtime.backendReady || !state.session.authenticated) return;
  primeLeadNotifications();
  statePollTimer = window.setInterval(() => {
    refreshLiveState({ notify: true }).catch(() => {});
  }, 30000);
}

async function validateSession() {
  if (!state.session.token) return false;
  try {
    const payload = await fetchJson("./api/auth/session");
    state.session = {
      token: state.session.token,
      authenticated: true,
      user: payload.user,
      required: false
    };
    state.control.activeProfileId = payload.user.profileId;
    saveSessionState();
    return true;
  } catch {
    clearSessionState();
    return false;
  }
}

async function signIn() {
  if (!refs.loginForm.reportValidity()) return;
  try {
    const payload = await fetchJson("./api/auth/login", {
      method: "POST",
      body: JSON.stringify({
        username: refs.loginUsernameInput.value.trim(),
        password: refs.loginPasswordInput.value
      }),
      headers: {}
    });
    state.session = {
      token: payload.token,
      authenticated: true,
      user: payload.user,
      required: false
    };
    state.control.activeProfileId = payload.user.profileId;
    saveSessionState();
    await hydrateProtectedState();
    registerNotificationWorker();
    startLiveStatePolling();
    refs.loginDialog.close();
    refs.loginForm.reset();
    logActivity({
      action: "Signed in",
      detail: `${payload.user.name} / ${payload.user.role}`
    });
    render();
  } catch (error) {
    openLoginDialog("Login gagal. Semak username atau password.");
  }
}

async function signOut() {
  try {
    if (state.session.token) {
      await fetchJson("./api/auth/logout", { method: "POST", body: JSON.stringify({}) });
    }
  } catch {
    // Ignore logout transport issue and clear local session anyway.
  }
  clearSessionState();
  window.clearInterval(statePollTimer);
  state.control.activeProfileId = "admin-root";
  render();
  if (state.runtime.backendReady) {
    openLoginDialog("Sesi dah ditutup. Login semula untuk akses data live.");
  }
}

function activeProfile() {
  return state.control.profiles.find((profile) => profile.id === state.control.activeProfileId) || state.control.profiles[0] || {
    id: "admin-root",
    name: "Afiq Admin",
    role: "admin",
    companyIds: COMPANIES.map((company) => company.id),
    companyId: "",
    staffName: ""
  };
}

function visibleCompanies() {
  const profile = activeProfile();
  if (hasGlobalAccess(profile)) return COMPANIES;
  return COMPANIES.filter((company) => profile.companyIds.includes(company.id));
}

function canAccessCompany(companyId) {
  return visibleCompanies().some((company) => company.id === companyId);
}

function ensureAccessibleActiveCompany() {
  if (canAccessCompany(state.activeCompanyId)) return;
  state.activeCompanyId = visibleCompanies()[0]?.id || COMPANIES[0].id;
}

function visibleRecords(records = state.records) {
  if (accessLocked()) return [];
  const profile = activeProfile();
  return records.filter((record) => {
    if (record.details?.archivedDuplicate) return false;
    if (!profile.companyIds.includes(record.companyId) && !hasGlobalAccess(profile)) return false;
    if (profile.role === "staff") return record.staff === profile.staffName;
    return true;
  });
}

function canEditRecord(record) {
  if (!record || accessLocked()) return false;
  const profile = activeProfile();
  if (hasGlobalAccess(profile)) return true;
  if (!profile.companyIds.includes(record.companyId)) return false;
  if (profile.role === "staff") return record.staff === profile.staffName;
  return true;
}

function normalizePhone(phone = "") {
  const digits = String(phone || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("60")) return digits;
  if (digits.startsWith("0")) return `6${digits}`;
  return digits;
}

function escapeHtml(value = "") {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttribute(value = "") {
  return escapeHtml(value);
}

function recentDuplicates(companyId, phone, excludeId = "") {
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) return [];
  return state.records
    .filter((record) => record.kind === "lead")
    .filter((record) => !record.details?.archivedDuplicate)
    .filter((record) => record.companyId === companyId)
    .filter((record) => normalizePhone(record.phone) === normalizedPhone)
    .filter((record) => !excludeId || record.id !== excludeId)
    .filter((record) => daysBetween(recordDateKey(record)) <= Number(state.control.settings.dedupeWindowDays || 45))
    .sort((a, b) => recordDateKey(b).localeCompare(recordDateKey(a)));
}

function normalizeOrderKeyValue(value = "") {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function findDuplicateOrder({ companyId, phone, product, staff, details = {}, excludeId = "" }) {
  const normalizedPhone = normalizePhone(phone);
  const lotNo = companyId === "salam-land"
    ? normalizeOrderKeyValue(canonicalSalamLotNo(details.lotNo || ""))
    : normalizeOrderKeyValue(details.lotNo || details.itemName || details.designName || "");
  const normalizedProduct = normalizeOrderKeyValue(product);
  const normalizedStaff = normalizeOrderKeyValue(staff);
  if (!normalizedPhone) return null;

  return state.records
    .filter((record) => record.kind === "order")
    .filter((record) => !isCancelledRefund(record))
    .filter((record) => !record.details?.archivedDuplicate)
    .filter((record) => record.companyId === companyId)
    .filter((record) => !excludeId || record.id !== excludeId)
    .find((record) => {
      const recordDetails = record.details || {};
      const samePhone = normalizePhone(record.phone) === normalizedPhone;
      if (companyId === "salam-land") {
        const recordLot = normalizeOrderKeyValue(canonicalSalamLotNo(recordDetails.lotNo || ""));
        const sameLot = lotNo && recordLot && recordLot === lotNo;
        return samePhone && sameLot;
      }
      const sameProduct = companyId === "salam-land" || !normalizedProduct || normalizeOrderKeyValue(record.product) === normalizedProduct;
      const sameStaff = !normalizedStaff || normalizeOrderKeyValue(record.staff) === normalizedStaff;
      const recordLot = normalizeOrderKeyValue(recordDetails.lotNo || recordDetails.itemName || recordDetails.designName || "");
      const sameLot = lotNo ? recordLot === lotNo : true;
      return samePhone && sameProduct && sameStaff && sameLot;
    }) || null;
}

function renderOrderDuplicateState(duplicate = null) {
  if (!refs.orderDuplicateState) return;
  if (!duplicate) {
    refs.orderDuplicateState.innerHTML = `<div class="ok-state">Duplicate guard clear. Order ini selamat untuk disimpan.</div>`;
    return;
  }
  refs.orderDuplicateState.innerHTML = `
    <div class="warning-state">Order sama sudah wujud. Edit order existing, jangan create order baru.</div>
    <div class="activity-list">
      <div class="activity-item warning">
        <strong>${escapeHtml(duplicate.customerName || "Customer")}</strong>
        <span>${escapeHtml(duplicate.staff || "-")} • ${escapeHtml(duplicate.status || "-")} • ${prettyDate(duplicate.createdAt)}</span>
        <p>${escapeHtml(recordSummary(duplicate))} • ${formatCurrency(duplicate.value || 0)}</p>
        <button class="ghost-button" type="button" data-edit-order-id="${duplicate.id}">Edit order ini</button>
      </div>
    </div>
  `;
}

function checkCurrentOrderDuplicate() {
  if (!refs.orderForm) return null;
  const formData = new FormData(refs.orderForm);
  const details = collectDetails(formData);
  const duplicate = findDuplicateOrder({
    companyId: String(formData.get("companyId") || ""),
    phone: String(formData.get("phone") || ""),
    product: String(formData.get("product") || ""),
    staff: String(formData.get("staff") || ""),
    details,
    excludeId: String(formData.get("recordId") || "")
  });
  renderOrderDuplicateState(duplicate);
  return duplicate;
}

function createBackupPayload() {
  return {
    exportedAt: new Date().toISOString(),
    companies: COMPANIES,
    campaigns: state.campaigns,
    records: state.records,
    integrations: state.integrations,
    goldRates: state.goldRates,
    control: state.control
  };
}

function updateLocalBackupSnapshot() {
  if (!state.control.settings.autoBackupEnabled) return;
  localStorage.setItem(AUTO_BACKUP_KEY, JSON.stringify(createBackupPayload()));
  state.control.lastBackupAt = new Date().toISOString();
}

function pushRuntimeError(message) {
  state.control.errors = [
    {
      id: createId("err"),
      at: new Date().toISOString(),
      message
    },
    ...state.control.errors
  ].slice(0, 20);
}

function logActivity({ action, detail = "", companyId = state.activeCompanyId, severity = "info" }) {
  const profile = activeProfile();
  state.control.activity = [
    {
      id: createId("act"),
      at: new Date().toISOString(),
      actor: profile.name,
      role: profile.role,
      companyId,
      action,
      detail,
      severity
    },
    ...state.control.activity
  ].slice(0, 80);
}

async function readAttachments(fileList) {
  const files = Array.from(fileList || []).slice(0, MAX_ATTACHMENTS);
  const attachments = [];

  for (const file of files) {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      throw new Error(`${file.name} melebihi had ${Math.round(MAX_ATTACHMENT_BYTES / 1000000)}MB.`);
    }

    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error(`Gagal baca fail ${file.name}.`));
      reader.readAsDataURL(file);
    });

    attachments.push({
      id: createId("file"),
      name: file.name,
      size: file.size,
      type: file.type || "application/octet-stream",
      dataUrl,
      uploadedAt: new Date().toISOString()
    });
  }

  return attachments;
}

async function uploadAttachments(fileList, companyId, recordKind) {
  const prepared = await readAttachments(fileList);
  if (!prepared.length) return [];
  const response = await fetchJson("./api/uploads", {
    method: "POST",
    body: JSON.stringify({
      companyId,
      recordKind,
      files: prepared.map((file) => ({
        name: file.name,
        size: file.size,
        type: file.type,
        dataUrl: file.dataUrl
      }))
    })
  });
  return Array.isArray(response.attachments) ? response.attachments : [];
}

function activeCompany() {
  return COMPANIES.find((company) => company.id === state.activeCompanyId);
}

function companyById(id) {
  return COMPANIES.find((company) => company.id === id);
}

function companyRecords(companyId = state.activeCompanyId) {
  return visibleRecords(state.records).filter((record) => record.companyId === companyId);
}

function companyCampaigns(companyId = state.activeCompanyId) {
  if (accessLocked()) return [];
  if (!canAccessCompany(companyId)) return [];
  const campaigns = state.campaigns.filter((campaign) => campaign.companyId === companyId);
  if (activeProfile().role !== "staff") return campaigns;
  const visibleCampaignIds = new Set(companyRecords(companyId).map((record) => record.campaignId).filter(Boolean));
  return campaigns.filter((campaign) => visibleCampaignIds.has(campaign.id));
}

function campaignName(campaignId) {
  if (!campaignId) return "Organic / no campaign";
  const campaign = state.campaigns.find((item) => item.id === campaignId);
  return campaign ? campaign.name : "Organic / no campaign";
}

function campaignOptionsForCompany(companyId) {
  return [
    { value: "", label: "No mapped campaign" },
    ...companyCampaigns(companyId).map((item) => ({
      value: item.id,
      label: `${item.platform}: ${item.name}`
    }))
  ];
}

function isClosed(record) {
  return companyById(record.companyId).closedStatuses.includes(record.status);
}

function isLost(record) {
  return companyById(record.companyId).lostStatuses.includes(record.status);
}

function isCancelledRefund(record) {
  return String(record?.status || "") === CANCELLED_REFUND_STATUS
    || String(record?.details?.refundStatus || "") === REFUNDED_PAYMENT_STATUS
    || Boolean(record?.details?.cancelledAt);
}

function activeOrders(records = []) {
  return records.filter((record) => record.kind === "order" && !isCancelledRefund(record));
}

function isOpen(record) {
  return !isClosed(record) && !isLost(record);
}

function formatCurrency(value) {
  return new Intl.NumberFormat("ms-MY", {
    style: "currency",
    currency: "MYR",
    maximumFractionDigits: 0
  }).format(Number(value || 0));
}

function formatRatePerGram(value) {
  return new Intl.NumberFormat("ms-MY", {
    style: "currency",
    currency: "MYR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(Number(value || 0));
}

function formatNumber(value) {
  return new Intl.NumberFormat("ms-MY").format(Number(value || 0));
}

function currentMonthValue() {
  return todayIso().slice(0, 7);
}

function monthRange(monthValue) {
  const [year, month] = String(monthValue || currentMonthValue()).split("-").map(Number);
  const start = `${year}-${String(month).padStart(2, "0")}-01`;
  const endDate = new Date(year, month, 0);
  const end = `${year}-${String(month).padStart(2, "0")}-${String(endDate.getDate()).padStart(2, "0")}`;
  return { start, end };
}

function prettyDate(isoDate) {
  if (!isoDate) return "-";
  return new Intl.DateTimeFormat("ms-MY", {
    day: "numeric",
    month: "short",
    year: "numeric"
  }).format(new Date(`${isoDate}T00:00:00`));
}

function prettyMonth(monthValue) {
  if (!monthValue) return currentMonthValue();
  return new Intl.DateTimeFormat("ms-MY", {
    month: "long",
    year: "numeric"
  }).format(new Date(`${monthValue}-01T00:00:00`));
}

function companyUnitLabel(companyId) {
  if (companyId === "salam-land") return "lot";
  if (companyId === "barakah-emas") return "g";
  return "pcs";
}

function recordsInRange(records, dateFrom, dateTo) {
  return records.filter((record) => {
    const date = recordDateKey(record);
    return (!dateFrom || date >= dateFrom) && (!dateTo || date <= dateTo);
  });
}

function campaignsInRange(campaigns, dateFrom, dateTo) {
  return campaigns.filter((campaign) => campaignTouchedInRange(campaign, dateFrom, dateTo));
}

function campaignReportDate(campaign = {}) {
  const candidates = [
    campaign.spendDate,
    campaign.reportDate,
    campaign.date,
    campaign.spendUpdatedAt,
    campaign.updatedAt,
    campaign.createdAt
  ];
  const value = candidates.find((item) => /^\d{4}-\d{2}-\d{2}/.test(String(item || "")));
  return value ? String(value).slice(0, 10) : "";
}

function campaignTouchedInRange(campaign, dateFrom, dateTo) {
  const dates = [
    campaignReportDate(campaign),
    String(campaign.createdAt || "").slice(0, 10),
    String(campaign.spendUpdatedAt || "").slice(0, 10),
    ...(Array.isArray(campaign.dailyInsights) ? campaign.dailyInsights.map((row) => String(row.date || row.date_start || row.dateStart || "").slice(0, 10)) : [])
  ];
  return dates.some((date) => date && (!dateFrom || date >= dateFrom) && (!dateTo || date <= dateTo));
}

function dateRangeList(dateFrom, dateTo) {
  const dates = [];
  const cursor = toDate(dateFrom);
  const end = toDate(dateTo || dateFrom);
  while (cursor <= end && dates.length < 370) {
    dates.push(localIsoDate(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return dates;
}

function resolveReportRange(scope, monthValue, dateFrom, dateTo) {
  if (scope === "day") {
    const selectedDate = dateFrom || todayIso();
    return {
      scope,
      month: "",
      dateFrom: selectedDate,
      dateTo: selectedDate,
      label: `Harian ${prettyDate(selectedDate)}`
    };
  }

  if (scope === "week") {
    const start = dateFrom || isoOffset(-6);
    const end = isoOffsetFromDate(start, 6);
    return {
      scope,
      month: "",
      dateFrom: start,
      dateTo: end,
      label: `Mingguan ${prettyDate(start)} hingga ${prettyDate(end)}`
    };
  }

  if (scope === "month") {
    const month = monthValue || currentMonthValue();
    const range = monthRange(month);
    return {
      scope,
      month,
      dateFrom: range.start,
      dateTo: range.end,
      label: `Bulan ${prettyMonth(month)}`
    };
  }

  const start = dateFrom || todayIso();
  const end = dateTo || start;
  const orderedStart = start <= end ? start : end;
  const orderedEnd = start <= end ? end : start;
  return {
    scope,
    month: "",
    dateFrom: orderedStart,
    dateTo: orderedEnd,
    label: `${prettyDate(orderedStart)} hingga ${prettyDate(orderedEnd)}`
  };
}

function sanitizePdfText(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapePdfText(value) {
  return sanitizePdfText(value)
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

function wrapPdfText(text, maxChars) {
  const words = sanitizePdfText(text).split(" ").filter(Boolean);
  if (!words.length) return [""];
  const lines = [];
  let current = "";

  for (const word of words) {
    const attempt = current ? `${current} ${word}` : word;
    if (attempt.length <= maxChars) {
      current = attempt;
      continue;
    }

    if (current) lines.push(current);

    if (word.length <= maxChars) {
      current = word;
      continue;
    }

    for (let index = 0; index < word.length; index += maxChars) {
      const chunk = word.slice(index, index + maxChars);
      if (chunk.length === maxChars) {
        lines.push(chunk);
      } else {
        current = chunk;
      }
    }
  }

  if (current) lines.push(current);
  return lines;
}

function buildPdfDocument(lineSpecs) {
  const pageHeight = 842;
  const marginX = 46;
  const topY = 792;
  const bottomY = 46;
  const pages = [[]];
  let currentPage = 0;
  let cursorY = topY;

  for (const spec of lineSpecs) {
    const size = spec.size || 11;
    const bold = Boolean(spec.bold);
    const gapBefore = spec.gapBefore || 0;
    const lineHeight = spec.lineHeight || Math.round(size * 1.45);
    const maxChars = spec.maxChars || Math.max(28, Math.floor(90 * (11 / size)));
    const wrapped = wrapPdfText(spec.text, maxChars);

    cursorY -= gapBefore;

    for (const line of wrapped) {
      if (cursorY - lineHeight < bottomY) {
        currentPage += 1;
        pages[currentPage] = [];
        cursorY = topY;
      }

      pages[currentPage].push({ text: line, size, bold, y: cursorY });
      cursorY -= lineHeight;
    }
  }

  const encoder = new TextEncoder();
  const byteLength = (text) => encoder.encode(text).length;
  const objects = [];
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  objects[4] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>";

  let nextObjectId = 5;
  const pageObjectIds = [];
  const contentObjectIds = [];

  for (let index = 0; index < pages.length; index += 1) {
    contentObjectIds.push(nextObjectId++);
    pageObjectIds.push(nextObjectId++);
  }

  objects[2] = `<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`;

  pages.forEach((page, index) => {
    const stream = page.map((line) => (
      `BT /${line.bold ? "F2" : "F1"} ${line.size} Tf 1 0 0 1 ${marginX} ${line.y} Tm (${escapePdfText(line.text)}) Tj ET`
    )).join("\n");

    objects[contentObjectIds[index]] = `<< /Length ${byteLength(stream)} >>\nstream\n${stream}\nendstream`;
    objects[pageObjectIds[index]] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 ${pageHeight}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentObjectIds[index]} 0 R >>`;
  });

  let pdf = "%PDF-1.4\n";
  const offsets = [0];

  for (let objectId = 1; objectId < objects.length; objectId += 1) {
    offsets[objectId] = byteLength(pdf);
    pdf += `${objectId} 0 obj\n${objects[objectId]}\nendobj\n`;
  }

  const xrefOffset = byteLength(pdf);
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;

  for (let objectId = 1; objectId < objects.length; objectId += 1) {
    pdf += `${String(offsets[objectId]).padStart(10, "0")} 00000 n \n`;
  }

  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return new Blob([pdf], { type: "application/pdf" });
}

function isDesktopPreview() {
  return new URLSearchParams(window.location.search).get("preview") === "desktop";
}

function desktopPreviewTier() {
  if (!isDesktopPreview()) return "";
  const width = window.innerWidth;
  if (width <= 1120) return "narrow";
  if (width <= 1480) return "compact";
  return "wide";
}

function updateDesktopPreviewScale() {
  if (!isDesktopPreview()) {
    document.documentElement.style.setProperty("--desktop-preview-outer-width", "1400px");
    document.documentElement.style.setProperty("--desktop-preview-scale", "1");
    delete document.body.dataset.previewTier;
    return;
  }

  const tier = desktopPreviewTier();
  const previewWidth = tier === "narrow" ? 1040 : tier === "compact" ? 1240 : 1400;
  const availableWidth = Math.max(420, window.innerWidth - 24);
  const scale = Math.min(1, availableWidth / previewWidth);
  const outerWidth = scale < 1 ? previewWidth : availableWidth;
  document.body.dataset.previewTier = tier;
  document.documentElement.style.setProperty("--desktop-preview-outer-width", `${outerWidth}px`);
  document.documentElement.style.setProperty("--desktop-preview-scale", scale.toFixed(3));
}

function syncPreviewMode() {
  if (isDesktopPreview()) {
    document.body.dataset.preview = "desktop";
  } else {
    delete document.body.dataset.preview;
    delete document.body.dataset.previewTier;
  }

  updateDesktopPreviewScale();
}

function applyTheme() {
  const company = activeCompany();
  document.body.dataset.company = company.id;
  document.body.dataset.themeMode = currentThemeMode();
  if (refs.themeToggleButton) {
    const allowToggle = canUsePremiumTheme() && !accessLocked();
    refs.themeToggleButton.hidden = !allowToggle;
    refs.themeToggleButton.textContent = currentThemeMode() === "dark" ? "Light mode" : "Dark mode";
    refs.themeToggleButton.title = allowToggle
      ? "Tukar admin/management premium theme"
      : "Dark mode hanya untuk admin/management.";
  }
}

function syncAuthLayer() {
  const locked = accessLocked();
  if (refs.entryGate) refs.entryGate.hidden = !locked;
  if (refs.fortressShell) refs.fortressShell.hidden = locked;
  document.body.dataset.authLayer = locked ? "gate" : "workspace";
}

function sectionIdsForActiveView() {
  const map = {
    overviewSection: ["overviewSection", "dashboardAnalytics"],
    recordsSection: ["recordsSection"],
    lotStatusSection: ["recordsSection"],
    paymentSection: ["paymentSection"],
    performanceSection: ["performanceSection"],
    teamSection: ["performanceSection"],
    automationSection: ["automationSection"],
    reportSection: ["reportSection"],
    publishSection: ["publishSection"],
    whatsappSection: ["whatsappSection"],
    controlSection: ["controlSection"]
  };
  return new Set(map[state.activeSectionId] || ["overviewSection"]);
}

function applyActiveSectionVisibility() {
  const visibleIds = sectionIdsForActiveView();
  document.querySelectorAll("[data-workspace-section]").forEach((section) => {
    section.hidden = !visibleIds.has(section.id);
  });
  const recordsSection = document.querySelector("#recordsSection");
  if (recordsSection) {
    recordsSection.dataset.recordsMode = state.activeSectionId === "lotStatusSection" ? "lot" : "records";
  }
  const performanceSection = document.querySelector("#performanceSection");
  if (performanceSection) {
    performanceSection.dataset.performanceMode = state.activeSectionId === "teamSection" ? "team" : "campaign";
  }
  if (refs.metricStrip) {
    refs.metricStrip.hidden = state.activeSectionId !== "overviewSection";
  }
}

function currentMonthRecords(records) {
  const current = todayIso().slice(0, 7);
  return records.filter((record) => recordDateKey(record).slice(0, 7) === current);
}

function todayRecords(records) {
  return records.filter((record) => recordDateKey(record) === todayIso());
}

function dueFollowUps(records) {
  return records.filter((record) => isOpen(record) && record.nextFollowUp && record.nextFollowUp <= todayIso());
}

function summary(records, campaigns) {
  const closed = records.filter(isClosed);
  const open = records.filter(isOpen);
  const orders = activeOrders(records);
  const spend = campaigns.reduce((sum, item) => sum + Number(item.spend || 0), 0);
  const sales = closed.reduce((sum, item) => sum + Number(item.value || 0), 0);
  const leadCount = records.filter((record) => record.kind === "lead").length;
  const todayLeads = todayRecords(records).filter((record) => record.kind === "lead").length;
  const todayOrders = todayRecords(orders).length;
  const due = dueFollowUps(records).length;
  return {
    todayLeads,
    todayOrders,
    totalLeads: leadCount,
    totalOrders: orders.length,
    open: open.length,
    due,
    closedCount: closed.length,
    sales,
    spend,
    cpl: leadCount ? spend / leadCount : 0
  };
}

function recordSummary(record) {
  const details = record.details || {};
  if (record.companyId === "salam-land") {
    const product = normalizeSalamProductName(
      record.product,
      details.metaCampaignName,
      details.tiktokCampaignName,
      campaignName(record.campaignId)
    );
    const project = salamProjectLabel(record);
    const lotNo = String(details.lotNo || "").trim();
    const segment = details.buyerSegment || "-";
    return `${product} | ${project}${lotNo ? ` | ${lotNo}` : ""} | ${segment}${details.paymentStatus ? ` | ${details.paymentStatus}` : ""}`;
  }
  if (record.companyId === "bumi-hayat") {
    return `${record.product} | ${formatNumber(details.quantity || record.units || 0)} pcs | ${details.customerType || details.productionStatus || "-"}${details.paymentStatus ? ` | ${details.paymentStatus}` : ""}`;
  }
  return `${details.transactionType || "-"} | ${record.product} | ${formatNumber(details.grams || record.units || 0)}g${details.paymentStatus ? ` | ${details.paymentStatus}` : ""}`;
}

function salamLotLifecycleStatus(record) {
  if (isClosed(record)) return "Closed";
  if (record.status === "Booking") return "Booking";
  if (record.status === "Site Visit" || record.status === "Qualified") return "Reserved";
  if (record.status === "Dihubungi" || record.status === "Bluetick" || record.status === "New Lead") return "Lead Hold";
  return "Available";
}

function salamLotStatusRank(status = "") {
  if (status === "Closed") return 5;
  if (status === "Booking") return 4;
  if (status === "Reserved") return 3;
  if (status === "Lead Hold") return 2;
  return 1;
}

function latestLotRecord(existing, candidate) {
  if (!existing) return candidate;
  const existingRank = salamLotStatusRank(salamLotLifecycleStatus(existing));
  const candidateRank = salamLotStatusRank(salamLotLifecycleStatus(candidate));
  if (candidateRank !== existingRank) return candidateRank > existingRank ? candidate : existing;
  return candidate.createdAt > existing.createdAt ? candidate : existing;
}

function buildSalamLotBoardEntries() {
  const company = activeCompany();
  if (company.id !== "salam-land" || accessLocked()) return [];

  const inventoryMap = new Map((company.lotInventory || []).map((item) => {
    const lotNo = canonicalSalamLotNo(item.lotNo);
    return [lotNo, { ...item, lotNo }];
  }));
  const matchedRecords = new Map();
  const relevantRecords = visibleRecords(state.records)
    .filter((record) => record.companyId === "salam-land")
    .filter((record) => record.details?.lotNo)
    .filter((record) => !isLost(record));

  relevantRecords.forEach((record) => {
    const lotNo = canonicalSalamLotNo(record.details?.lotNo || "");
    if (!lotNo) return;
    matchedRecords.set(lotNo, latestLotRecord(matchedRecords.get(lotNo), record));
    if (!inventoryMap.has(lotNo)) {
      const projectLabel = salamProjectLabel(record);
      inventoryMap.set(lotNo, {
        lotNo,
        project: projectLabel,
        location: cleanSalamProjectLabel(record.details?.location) || projectLabel,
        price: Number(record.details?.landPrice || record.value || 0),
        buyerSegment: record.details?.buyerSegment || "Tidak pasti",
        baseStatus: "Available"
      });
    }
  });

  return Array.from(inventoryMap.values()).map((item) => {
    const record = matchedRecords.get(item.lotNo);
    const details = record?.details || {};
    const status = record ? salamLotLifecycleStatus(record) : (item.baseStatus || "Available");
    const landLabel = record
      ? salamProjectLabel(record)
      : cleanSalamProjectLabel(item.project) || inferSalamProjectLabel(item.lotNo, item.project, item.location) || "Project belum dipilih";
    const locationLabel = cleanSalamProjectLabel(details.location)
      || cleanSalamProjectLabel(item.location)
      || landLabel;
    return {
      lotNo: item.lotNo,
      project: landLabel,
      location: locationLabel,
      price: Number(details.landPrice || item.price || record?.value || 0),
      buyerSegment: details.buyerSegment || item.buyerSegment || "Tidak pasti",
      status,
      customerName: record?.customerName || "",
      phone: record?.phone || "",
      staff: record?.staff || "",
      product: record ? normalizeSalamProductName(record.product, details.metaCampaignName, details.tiktokCampaignName, campaignName(record.campaignId)) : company.defaultLeadProduct,
      bookingAmount: Number(details.bookingAmount || 0),
      closedValue: Number(record?.value || 0),
      source: record?.source || "",
      nextFollowUp: record?.nextFollowUp || "",
      notes: record?.notes || "",
      createdAt: record?.createdAt || "",
      recordId: record?.id || ""
    };
  }).sort((a, b) => {
    const rankDiff = salamLotStatusRank(b.status) - salamLotStatusRank(a.status);
    if (rankDiff) return rankDiff;
    return a.lotNo.localeCompare(b.lotNo);
  });
}

function salamLotActionLabels(entry) {
  if (entry.status === "Closed") {
    return { booking: "Reuse booking", close: "Closed template" };
  }
  if (entry.status === "Booking" || entry.status === "Reserved") {
    return { booking: "Update booking", close: "Mark closed" };
  }
  return { booking: "Quick booking", close: "Quick close" };
}

function salamLotStatusDescription(status = "") {
  if (status === "Available") return "Masih kosong dan boleh terus offer";
  if (status === "Lead Hold") return "Masih panas dalam follow-up awal";
  if (status === "Reserved") return "Sudah qualify atau site visit";
  if (status === "Booking") return "Sudah pegang booking sementara";
  if (status === "Closed") return "Dah sold dan tak boleh offer lagi";
  return "Status semasa lot";
}

function lotProjectCode(project = "") {
  const words = String(project || "")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .slice(0, 3);
  if (!words.length) return "LOT";
  return words.map((word) => word[0]).join("").toUpperCase();
}

function focusSalamLot(lotNo = "") {
  const normalizedLotNo = String(lotNo || "").trim();
  if (!normalizedLotNo) return;
  if (state.lotFocusLotNo === normalizedLotNo) {
    state.lotFocusLotNo = "";
    state.lotSearch = "";
    if (refs.lotSearchInput) refs.lotSearchInput.value = "";
    renderSalamLotBoard();
    return;
  }
  state.lotFocusLotNo = normalizedLotNo;
  state.lotSearch = normalizedLotNo;
  if (refs.lotSearchInput) refs.lotSearchInput.value = normalizedLotNo;
  renderSalamLotBoard();
}

function openSalamLotTemplate(lotNo = "", actionType = "booking") {
  const entry = buildSalamLotBoardEntries().find((item) => item.lotNo === lotNo);
  if (!entry) return;
  state.lotFocusLotNo = entry.lotNo;
  openOrderDialog(lotOrderDraft(entry, actionType));
}

function bindSalamLotBoardButtons() {
  refs.lotStatusDeck?.querySelectorAll("[data-lot-tile]").forEach((button) => {
    button.onclick = () => focusSalamLot(button.dataset.lotTile || "");
  });
}

function statusClass(record) {
  const status = String(record.status || "");
  if (isClosed(record)) return "won";
  if (isLost(record)) return "lost";
  if (["Bluetick", "Tak Jawab"].includes(status)) return "warning";
  if (["WS Sent", "Dihubungi"].includes(status)) return "contacted";
  if (["Reply", "Qualified", "Product Suggested", "Quotation", "Appointment", "Payment", "Deposit", "Production", "Delivered"].includes(status)) return "active";
  return "";
}

function renderStatusControl(record) {
  const company = companyById(record.companyId);
  const disabled = canEditRecord(record) ? "" : "disabled";
  return `
    <label class="status-control ${disabled ? "locked" : ""}">
      <select class="status-select ${statusClass(record)}" data-status-record-id="${record.id}" aria-label="Update status for ${record.customerName || "record"}" ${disabled}>
        ${company.statuses.map((status) => `<option value="${status}" ${status === record.status ? "selected" : ""}>${status}</option>`).join("")}
      </select>
    </label>
  `;
}

function replaceTokens(template, record) {
  return template
    .replaceAll("{name}", record.customerName || "tuan/puan")
    .replaceAll("{product}", record.product || "produk")
    .replaceAll("{staff}", record.staff || "team Salam Land")
    .replaceAll("{campaign}", campaignName(record.campaignId) || record.source || "lead");
}

function whatsappUrl(record, message) {
  const phone = String(record.phone || "").replace(/[^\d]/g, "");
  return `https://wa.me/${phone}?text=${encodeURIComponent(message)}`;
}

function resolveStatusForAction(record, actionId) {
  const desired = ACTION_STATUS_MAP[actionId];
  if (!desired) return "";
  const company = companyById(record.companyId);
  return company.statuses.includes(desired) ? desired : "";
}

function actionDateMeta(record) {
  const leadDate = recordDateKey(record) || String(record.createdAt || "-").slice(0, 10);
  const nextDate = record.nextFollowUp || "";
  const fourteenDayDate = record.kind === "lead" ? isoOffsetFromDate(leadDate, FOLLOW_UP_DAYS) : "";
  return { leadDate, nextDate, fourteenDayDate };
}

function renderLeadActionTicks(record) {
  const disabled = accessLocked() ? "disabled" : "";
  if (record.kind === "order") {
    const cancelled = isCancelledRefund(record);
    return `
      <div class="record-actions">
        <div class="record-action-head">
          <button class="ghost-button record-detail-button" type="button" data-view-record-id="${record.id}" ${disabled}>View</button>
          <button class="ghost-button record-edit-button" type="button" data-edit-order-id="${record.id}" ${disabled}>Edit order</button>
          ${cancelled
            ? `<span class="status-pill lost">Refund archived</span>`
            : `<button class="ghost-button danger-button record-cancel-button" type="button" data-cancel-order-id="${record.id}" ${disabled}>Cancel / Refund</button>`}
          <span>${record.staff || "-"}</span>
        </div>
      </div>
    `;
  }
  return `
    <div class="record-actions">
      <div class="record-action-head">
        <button class="ghost-button record-detail-button" type="button" data-view-record-id="${record.id}" ${disabled}>View</button>
        <button class="ws-button" type="button" data-wa-id="${record.id}" data-wa-type="followup" ${disabled}>Open WS</button>
        <span>${record.staff || "-"}</span>
      </div>
    </div>
  `;
}

function detailRows(rows = []) {
  return rows.map(([label, value]) => `
    <div class="detail-row">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value || "-")}</strong>
    </div>
  `).join("");
}

function whatsappMessagesForRecord(record) {
  const phone = normalizePhone(record.phone || "");
  return mergeWhatsApp(state.whatsapp).messages
    .filter((message) => (
      (message.lead_id && message.lead_id === record.id)
        || (phone && normalizePhone(message.phone_number || "") === phone)
    ))
    .sort((left, right) => String(right.created_at || "").localeCompare(String(left.created_at || "")));
}

function whatsappOptOutForRecord(record) {
  const phone = normalizePhone(record.phone || "");
  return Boolean(record.details?.whatsapp_opt_out)
    || mergeWhatsApp(state.whatsapp).optOuts.some((item) => normalizePhone(item.phone_number || "") === phone);
}

function renderWhatsAppHistory(record) {
  const messages = whatsappMessagesForRecord(record);
  const optOut = whatsappOptOutForRecord(record);
  const hasDebugAccess = hasGlobalAccess(state.session.user || activeProfile());
  const rows = messages.slice(0, 12).map((message) => `
    <article class="wa-history-row ${message.direction}">
      <div>
        <strong>${escapeHtml(message.direction === "outbound" ? "CRM -> Customer" : message.direction === "inbound" ? "Customer -> CRM" : "System")}</strong>
        <p>${escapeHtml(message.message_body || message.template_name || message.message_type || "-")}</p>
        ${message.template_name ? `<small>Template: ${escapeHtml(message.template_name)}</small>` : ""}
        ${message.error_message ? `<small class="wa-error">${escapeHtml(message.error_message)}</small>` : ""}
      </div>
      <div class="wa-history-meta">
        <span class="status-pill ${message.status === "failed" ? "lost" : message.status === "read" || message.status === "delivered" ? "active" : ""}">${escapeHtml(message.status || "-")}</span>
        <small>${message.created_at ? localDateTimeLabel(new Date(message.created_at)) : "-"}</small>
      </div>
      ${hasDebugAccess && message.raw_payload_json ? `
        <details class="wa-raw-payload">
          <summary>Raw payload</summary>
          <pre>${escapeHtml(JSON.stringify(message.raw_payload_json, null, 2)).slice(0, 2000)}</pre>
        </details>
      ` : ""}
    </article>
  `).join("");

  return `
    <section class="detail-card">
      <div class="detail-card-head">
        <div>
          <strong>WhatsApp History</strong>
          <p>Official WhatsApp Cloud API message log untuk lead ini.</p>
        </div>
        ${optOut ? `<span class="status-pill lost">Opt-Out</span>` : `<span class="status-pill active">${messages.length} message</span>`}
      </div>
      <div class="wa-history-list">
        ${rows || `<div class="empty-state">Belum ada WhatsApp Cloud API message untuk record ini.</div>`}
      </div>
    </section>
  `;
}

function whatsappConversationRecords() {
  const records = companyRecords()
    .filter((record) => record.kind === "lead")
    .map((record) => {
      const messages = whatsappMessagesForRecord(record);
      const latestMessage = messages[0] || null;
      return {
        record,
        messages,
        latestMessage,
        unreadCount: messages.filter((message) => message.direction === "inbound" && message.status === "received").length,
        lastActivity: latestMessage?.created_at || record.updatedAt || record.createdAt || record.date || ""
      };
    })
    .sort((left, right) => String(right.lastActivity || "").localeCompare(String(left.lastActivity || "")));

  return records.slice(0, 12);
}

function renderWhatsAppInboxPreview() {
  const company = activeCompany();
  const whatsapp = mergeWhatsApp(state.whatsapp);
  const settings = whatsapp.settings || {};
  const envStatus = settings.env_status || {};
  const connected = envStatus.status === "connected" && Boolean(settings.is_active);
  const conversations = whatsappConversationRecords();
  const activeConversation = conversations[0] || null;
  const activeRecord = activeConversation?.record || null;
  const timeline = activeConversation?.messages || [];
  const unresolved = conversations.filter((item) => item.unreadCount || !item.messages.some((message) => message.direction === "outbound")).length;
  const optOutCount = whatsapp.optOuts.length;
  const allowedStaff = Array.isArray(envStatus.allowed_staff) && envStatus.allowed_staff.length
    ? envStatus.allowed_staff.join(", ")
    : "All staff";

  const conversationRows = conversations.map(({ record, messages, latestMessage, unreadCount }) => {
    const lastText = latestMessage?.message_body || latestMessage?.template_name || record.notes || record.product || "Belum ada mesej API.";
    const sent = messages.some((message) => message.direction === "outbound" && ["sent", "delivered", "read"].includes(message.status));
    return `
      <button class="wa-inbox-contact ${record.id === activeRecord?.id ? "active" : ""}" type="button" data-view-record-id="${record.id}">
        <span class="wa-avatar">${escapeHtml((record.name || "?").slice(0, 1).toUpperCase())}</span>
        <span class="wa-contact-main">
          <strong>${escapeHtml(record.name || "Lead tanpa nama")}</strong>
          <small>${escapeHtml(lastText).slice(0, 76)}</small>
        </span>
        <span class="wa-contact-meta">
          ${unreadCount ? `<b>${formatNumber(unreadCount)}</b>` : ""}
          <small>${escapeHtml(record.staff || "-")}</small>
          <em class="${sent ? "sent" : ""}">${sent ? "WS sent" : "Belum WS"}</em>
        </span>
      </button>
    `;
  }).join("");

  const chatRows = timeline.slice().reverse().map((message) => `
    <article class="wa-chat-bubble ${message.direction === "outbound" ? "outbound" : message.direction === "inbound" ? "inbound" : "system"}">
      <p>${escapeHtml(message.message_body || message.template_name || message.message_type || "-")}</p>
      <small>
        ${message.template_name ? `Template ${escapeHtml(message.template_name)} · ` : ""}
        ${escapeHtml(message.status || "-")}
        ${message.created_at ? ` · ${localDateTimeLabel(new Date(message.created_at))}` : ""}
      </small>
    </article>
  `).join("");

  return `
    <article class="wa-inbox-shell system-card-wide">
      <div class="wa-inbox-topbar">
        <div>
          <p class="eyebrow">WhatsApp Inbox</p>
          <h3>Team conversation desk</h3>
        </div>
        <div class="wa-inbox-stats">
          <span><b>${formatNumber(conversations.length)}</b> chats</span>
          <span><b>${formatNumber(unresolved)}</b> perlu semak</span>
          <span><b>${formatNumber(optOutCount)}</b> opt-out</span>
          <span><b>${escapeHtml(allowedStaff)}</b> pilot</span>
        </div>
      </div>

      <div class="wa-inbox-layout">
        <aside class="wa-inbox-filter">
          <strong>Inbox</strong>
          <span class="wa-filter-pill active">All chats</span>
          <span class="wa-filter-pill">Pending reply</span>
          <span class="wa-filter-pill">Belum WS</span>
          <span class="wa-filter-pill">Resolved</span>
          <span class="wa-filter-pill">Opt-out</span>
          <div class="wa-mini-note">
            <b>Status API</b>
            <small>${whatsappStatusLabel(envStatus.status)} · ${settings.is_active ? "Auto intro on" : "Auto intro off"}</small>
          </div>
        </aside>

        <section class="wa-inbox-list">
          <div class="wa-search-row">
            <span>Search contact, message, staff</span>
            <b>${formatNumber(whatsapp.messages.length)} logs</b>
          </div>
          ${conversationRows || `<div class="empty-state">Belum ada lead untuk preview inbox.</div>`}
        </section>

        <section class="wa-chat-panel">
          ${activeRecord ? `
            <div class="wa-chat-head">
              <div>
                <strong>${escapeHtml(activeRecord.name || "Lead")}</strong>
                <small>${escapeHtml(activeRecord.phone || "-")} · ${escapeHtml(activeRecord.staff || "-")} · ${escapeHtml(activeRecord.status || "-")}</small>
              </div>
              <button class="ghost-button" type="button" data-view-record-id="${activeRecord.id}">Open profile</button>
            </div>
            <div class="wa-chat-thread">
              ${chatRows || `
                <article class="wa-chat-bubble system">
                  <p>No WhatsApp history yet.</p>
                  <small>Waiting for first API event</small>
                </article>
              `}
            </div>
            <div class="wa-composer ${connected ? "" : "locked"}">
              <span>${connected ? "24-hour reply window active" : "Locked until Cloud API is connected"}</span>
              <button class="primary-button" type="button" ${connected ? "" : "disabled"}>Send reply</button>
            </div>
          ` : `
            <div class="empty-state">Pilih lead untuk lihat conversation preview.</div>
          `}
        </section>

        <aside class="wa-info-panel">
          <strong>Lead information</strong>
          ${activeRecord ? `
            <dl>
              <dt>Customer</dt><dd>${escapeHtml(activeRecord.name || "-")}</dd>
              <dt>Phone</dt><dd>${escapeHtml(activeRecord.phone || "-")}</dd>
              <dt>Staff</dt><dd>${escapeHtml(activeRecord.staff || "-")}</dd>
              <dt>Product</dt><dd>${escapeHtml(activeRecord.product || "-")}</dd>
              <dt>Source</dt><dd>${escapeHtml(activeRecord.source || "-")}</dd>
              <dt>Status</dt><dd>${escapeHtml(activeRecord.status || "-")}</dd>
            </dl>
            <button class="ws-button" type="button" data-wa-id="${activeRecord.id}" data-wa-type="followup">Open WhatsApp manual</button>
          ` : `<p>Tiada lead dipilih.</p>`}
        </aside>
      </div>
    </article>
  `;
}

function openRecordDetail(recordId = "") {
  if (!refs.detailDialog || !refs.detailContent) return;
  const record = visibleRecords(state.records).find((item) => item.id === recordId);
  if (!record) return;
  const details = record.details || {};
  const payment = record.kind === "order" ? paymentSnapshot(record) : null;
  refs.detailEyebrow.textContent = `${record.kind === "order" ? "Order" : "Lead"} detail`;
  refs.detailTitle.textContent = record.customerName || record.phone || "Record";
  refs.detailContent.innerHTML = `
    <section class="detail-card">
      <div class="detail-card-head">
        <div>
          <strong>${escapeHtml(record.product || "-")}</strong>
          <p>${escapeHtml(recordSummary(record))}</p>
        </div>
        <span class="status-pill ${statusClass(record)}">${escapeHtml(record.status || "-")}</span>
      </div>
      <div class="detail-grid">
        ${detailRows([
          ["Company", companyById(record.companyId)?.name || record.companyId],
          ["Phone", record.phone],
          ["Staff / team sales", record.staff],
          ["Source", record.source],
          ["Campaign", campaignName(record.campaignId)],
          ["Created", record.createdAt],
          ["Next action", record.nextFollowUp],
          ["Value", formatCurrency(record.value || 0)]
        ])}
      </div>
    </section>
    ${record.kind === "order" && payment ? `
      <section class="detail-card">
        <div class="detail-card-head">
          <div>
            <strong>Payment snapshot</strong>
            <p>Ringkasan bayaran daripada data order sedia ada.</p>
          </div>
          <span class="payment-stage-pill ${paymentStatusClass(payment.status)}">${escapeHtml(payment.status)}</span>
        </div>
        <div class="detail-grid">
          ${detailRows([
            ["Gross", formatCurrency(payment.gross)],
            ["Discount", formatCurrency(payment.discount)],
            ["Net total", formatCurrency(payment.total)],
            ["Paid", formatCurrency(payment.paid)],
            ["Balance", formatCurrency(payment.outstanding)],
            ["Last payment", payment.lastPaymentDate ? prettyDate(payment.lastPaymentDate) : "-"]
          ])}
        </div>
      </section>
    ` : ""}
    ${renderWhatsAppHistory(record)}
    <section class="detail-card">
      <strong>Details</strong>
      <div class="detail-grid">
        ${detailRows(Object.entries(details)
          .filter(([key, value]) => !["paymentSchedule"].includes(key) && value !== undefined && value !== "")
          .slice(0, 16)
          .map(([key, value]) => [key.replace(/([A-Z])/g, " $1").replace(/^./, (char) => char.toUpperCase()), Array.isArray(value) ? `${value.length} item` : String(value)]))}
      </div>
      <p class="detail-note">${escapeHtml(record.notes || "Tiada remark.")}</p>
    </section>
    <div class="detail-actions">
      ${record.kind === "lead" ? `<button class="ws-button" type="button" data-wa-id="${record.id}" data-wa-type="followup">Open WhatsApp</button>` : `<button class="primary-button" type="button" data-edit-order-id="${record.id}">Edit order</button>`}
      ${record.kind === "order" && !isCancelledRefund(record) ? `<button class="ghost-button danger-button" type="button" data-cancel-order-id="${record.id}">Cancel / Refund</button>` : ""}
      <button class="ghost-button" type="button" data-close-detail>Close</button>
    </div>
  `;
  if (!refs.detailDialog.open) refs.detailDialog.showModal();
}

function openLotDetail(lotNo = "") {
  if (!refs.detailDialog || !refs.detailContent || activeCompany().id !== "salam-land") return;
  const entry = buildSalamLotBoardEntries().find((item) => item.lotNo === lotNo);
  if (!entry) return;
  refs.detailEyebrow.textContent = "Lot detail";
  refs.detailTitle.textContent = entry.lotNo;
  refs.detailContent.innerHTML = `
    <section class="detail-card">
      <div class="detail-card-head">
        <div>
          <strong>${escapeHtml(entry.project || "Project belum dipilih")}</strong>
          <p>${escapeHtml(entry.location || "-")}</p>
        </div>
        <span class="lot-status-badge ${slugify(entry.status)}">${escapeHtml(entry.status)}</span>
      </div>
      <div class="detail-grid">
        ${detailRows([
          ["Lot", entry.lotNo],
          ["Project", entry.project],
          ["Team sales", entry.staff || "Belum assign"],
          ["Customer", entry.customerName || "-"],
          ["Phone", entry.phone || "-"],
          ["Price", entry.price ? formatCurrency(entry.price) : "-"],
          ["Booking", entry.bookingAmount ? formatCurrency(entry.bookingAmount) : "-"],
          ["Closed value", entry.closedValue ? formatCurrency(entry.closedValue) : "-"]
        ])}
      </div>
      <p class="detail-note">${escapeHtml(entry.notes || "Lot status diambil daripada inventory dan rekod CRM aktif.")}</p>
    </section>
    <div class="detail-actions">
      ${entry.recordId ? `<button class="ghost-button" type="button" data-view-record-id="${entry.recordId}">View linked record</button>` : ""}
      <button class="ghost-button" type="button" data-lot-action="booking" data-lot-no="${entry.lotNo}">${salamLotActionLabels(entry).booking}</button>
      <button class="primary-button" type="button" data-lot-action="closed" data-lot-no="${entry.lotNo}">${salamLotActionLabels(entry).close}</button>
      <button class="ghost-button" type="button" data-close-detail>Close</button>
    </div>
  `;
  if (!refs.detailDialog.open) refs.detailDialog.showModal();
}

function renderCompanyRail() {
  refs.companyRail.innerHTML = visibleCompanies().map((company) => `
    <button class="company-card company-card-${company.logoClass || company.id} ${company.id === state.activeCompanyId ? "active" : ""}" data-company-id="${company.id}" type="button">
      <div class="company-logo-card ${company.id === "bumi-hayat" ? "bumi" : ""}">
        <img src="${company.logo}" alt="${company.name} logo">
      </div>
      <div>
        <strong>${company.name}</strong>
        <span>${company.themeBadge}</span>
      </div>
    </button>
  `).join("");
}

function renderSidebarPanels() {
  const company = activeCompany();
  if (refs.staffRuleList) {
    refs.staffRuleList.innerHTML = company.sidebarRules.map((item) => `<div class="side-item">${item}</div>`).join("");
  }
  if (refs.autoCaptureList) {
    refs.autoCaptureList.innerHTML = company.autoCapture.map((item) => `<div class="side-item">${item}</div>`).join("");
  }
}

function renderSectionNav() {
  const hiddenSections = activeProfile().role === "staff" ? new Set(["publishSection", "whatsappSection"]) : new Set();
  const sections = WORKSPACE_SECTIONS
    .filter((section) => !hiddenSections.has(section.id))
    .filter((section) => !section.companyIds || section.companyIds.includes(state.activeCompanyId));
  const navSections = sections.filter((section) => section.id !== "whatsappSection");
  const canShowWhatsAppSubmenu = sections.some((section) => section.id === "whatsappSection");
  if (!sections.some((section) => section.id === state.activeSectionId)) {
    state.activeSectionId = sections[0]?.id || "overviewSection";
  }
  const integrationSubmenuOpen = ["publishSection", "whatsappSection"].includes(state.activeSectionId);
  refs.sectionNav.innerHTML = navSections.map((section) => {
    const isIntegration = section.id === "publishSection";
    const activeClass = section.id === state.activeSectionId || (isIntegration && integrationSubmenuOpen) ? "active" : "";
    const submenu = isIntegration && canShowWhatsAppSubmenu ? `
      <div class="section-submenu ${integrationSubmenuOpen ? "open" : ""}" aria-label="Integration tools">
        <button class="section-sub-link ${state.activeSectionId === "whatsappSection" ? "active" : ""}" data-section-target="whatsappSection" type="button">
          <span class="section-sub-icon">WA</span>
          <span>
            <strong>WhatsApp API</strong>
            <small>Command centre</small>
          </span>
        </button>
      </div>
    ` : "";
    return `
      <div class="section-group ${isIntegration ? "has-submenu" : ""}">
        <button class="section-link ${activeClass} ${isIntegration ? "has-child" : ""}" data-section-target="${section.id}" type="button" aria-expanded="${isIntegration ? String(integrationSubmenuOpen) : "false"}">
          <span class="section-link-code">${section.code}</span>
          <div class="section-link-copy">
            <strong>${section.label}</strong>
            <span>${section.note}</span>
          </div>
          ${isIntegration ? `<span class="section-caret" aria-hidden="true">⌄</span>` : ""}
        </button>
        ${submenu}
      </div>
    `;
  }).join("");
}

function setActiveSection(sectionId) {
  if (!sectionId || state.activeSectionId === sectionId) return;
  state.activeSectionId = sectionId;
  renderSectionNav();
  applyActiveSectionVisibility();
}

function syncActiveSectionFromScroll() {
  applyActiveSectionVisibility();
}

function queueSectionSync() {
  if (sectionScrollFrame) window.cancelAnimationFrame(sectionScrollFrame);
  sectionScrollFrame = window.requestAnimationFrame(() => {
    sectionScrollFrame = 0;
    applyActiveSectionVisibility();
  });
}

function renderTopbarStatus() {
  const profile = activeProfile();
  const company = activeCompany();
  const profileLabel = accessLocked()
    ? "Login required"
    : roleLabel(profile.role);
  const recordCount = companyRecords(company.id).length;
  const chips = [
    {
      label: state.runtime.backendReady ? "Live system" : "Preview mode",
      className: state.runtime.backendReady ? "live" : "warn"
    },
    {
      label: profileLabel,
      className: accessLocked() ? "warn" : ""
    },
    {
      label: company.name,
      className: "live"
    },
    {
      label: `${formatNumber(recordCount)} records`,
      className: ""
    }
  ];

  refs.topbarStatus.innerHTML = chips.map((chip) => `<span class="status-chip ${chip.className}">${chip.label}</span>`).join("");
}

function syncActionAccess() {
  const profile = activeProfile();
  const authLocked = state.runtime.backendReady && !state.session.authenticated;
  const staffLocked = profile.role === "staff";
  const integrationButton = document.querySelector("#integrationButton");
  const campaignButton = document.querySelector("#campaignButton");
  const exportButton = document.querySelector("#exportButton");
  const controlButton = document.querySelector("#controlButton");
  const leadButton = document.querySelector("#leadButton");
  const orderButton = document.querySelector("#orderButton");
  const reportButton = document.querySelector("#reportButton");
  const authButton = document.querySelector("#authButton");
  const activeSection = state.activeSectionId;

  authButton.textContent = state.session.authenticated ? `Logout ${state.session.user?.name || ""}`.trim() : "Sign in";
  leadButton.hidden = !["overviewSection", "recordsSection"].includes(activeSection);
  orderButton.hidden = !["overviewSection", "recordsSection", "lotStatusSection", "paymentSection", "automationSection"].includes(activeSection);
  reportButton.hidden = !["overviewSection", "reportSection", "paymentSection", "performanceSection", "teamSection"].includes(activeSection);
  campaignButton.hidden = !["performanceSection", "publishSection"].includes(activeSection);
  integrationButton.hidden = activeSection !== "publishSection";
  exportButton.hidden = !["publishSection", "controlSection"].includes(activeSection);
  controlButton.hidden = activeSection !== "controlSection";
  integrationButton.disabled = authLocked || staffLocked;
  campaignButton.disabled = authLocked || staffLocked;
  exportButton.disabled = authLocked || staffLocked;
  controlButton.disabled = authLocked;
  leadButton.disabled = authLocked;
  orderButton.disabled = authLocked;
  reportButton.disabled = authLocked;
  integrationButton.title = authLocked ? "Login dulu untuk akses integrations." : staffLocked ? "Hanya management / admin boleh ubah integrations." : "";
  campaignButton.title = authLocked ? "Login dulu untuk tambah spend." : staffLocked ? "Hanya management / admin boleh tambah spend campaign." : "";
  exportButton.title = authLocked ? "Login dulu untuk export backup." : staffLocked ? "Hanya management / admin boleh export backup." : "";
  controlButton.title = authLocked ? "Login dulu untuk buka Control Centre." : "";
  leadButton.title = authLocked ? "Login dulu untuk simpan lead live." : "";
  orderButton.title = authLocked ? "Login dulu untuk simpan order live." : "";
  reportButton.title = authLocked ? "Login dulu untuk download report live." : "";
  syncNotificationButton();
}

function renderSystemBoard() {
  const company = activeCompany();
  const baseUrl = currentBaseUrl();
  const scopedRecords = companyRecords(company.id);
  const scopedCampaigns = companyCampaigns(company.id);
  const records = scopedRecords.length;
  const campaigns = scopedCampaigns.length;
  const runtimeLabel = state.runtime.backendReady ? "Server API mode" : "Browser-only mode";
  const backupLabel = state.control.lastBackupAt ? localDateTimeLabel(new Date(state.control.lastBackupAt)) : "Belum ada";
  const healthRows = buildOpsHealth(company, scopedRecords, scopedCampaigns);
  const qaRows = buildQaChecklist(company, scopedRecords, scopedCampaigns);

  refs.systemModeBadge.textContent = state.runtime.backendReady ? "Server mode" : "Browser mode";
  refs.systemBoard.innerHTML = `
    <article class="system-card system-card-wide ops-health-card">
      <strong>Operations health monitor</strong>
      <p>Live signal untuk lead source, spend sync, WhatsApp dan backup status.</p>
      <div class="health-grid">
        ${renderHealthRows(healthRows)}
      </div>
    </article>
    <article class="system-card system-card-wide qa-readiness-card">
      <strong>Operation QA readiness</strong>
      <p>Stability signal untuk modul penting sebelum rollout update.</p>
      <div class="qa-grid">
        ${renderQaRows(qaRows)}
      </div>
    </article>
    <article class="system-card">
      <strong>${runtimeLabel}</strong>
      <p>${state.runtime.statusMessage}</p>
      <div class="system-meta">
        <span class="meta-pill">${state.runtime.storageMode === "server" ? "Webhook live-ready" : "Static preview safe"}</span>
        <span class="meta-pill">${state.runtime.lastSavedAt ? `Last save ${state.runtime.lastSavedAt}` : "Belum disimpan lagi"}</span>
        <span class="meta-pill">Last backup ${backupLabel}</span>
      </div>
    </article>
    <article class="system-card">
      <strong>${company.name} data engine</strong>
      <p>Rekod dan campaign dipaparkan ikut company aktif sahaja supaya data Salam, Bumi Hayat dan Barakah tidak bercampur.</p>
      <div class="system-meta">
        <span class="meta-pill">${formatNumber(records)} records</span>
        <span class="meta-pill">${formatNumber(campaigns)} campaigns</span>
        <span class="meta-pill">Local MY date-safe</span>
        <span class="meta-pill">${formatNumber(state.control.activity.length)} activity logs</span>
      </div>
    </article>
    <article class="system-card">
      <strong>Webhook base</strong>
      <p>Production callback endpoint untuk connector rasmi.</p>
      <code class="webhook-code">${baseUrl}</code>
    </article>
    <article class="system-card">
      <strong>Production readiness</strong>
      <div class="integration-meta">
        <span class="meta-pill">HTTPS live</span>
        <span class="meta-pill">Server endpoint</span>
        <span class="meta-pill">Company mapping</span>
        <span class="meta-pill">Health monitor</span>
      </div>
    </article>
  `;
}

function renderIntegrationBoard() {
  const company = activeCompany();
  const connection = activeConnection(company.id);
  const baseUrl = currentBaseUrl();
  const metaForms = String(connection.metaFormIds || "").split(/[,\n]+/).map((item) => item.trim()).filter(Boolean);
  const tiktokForms = String(connection.tiktokFormIds || "").split(/[,\n]+/).map((item) => item.trim()).filter(Boolean);
  const activeSyncCount = Number(Boolean(connection.metaEnabled)) + Number(Boolean(connection.tiktokEnabled));
  const eventCount = state.integrations.inboundEvents.length;
  const tiktokReady = company.id === "salam-land" && connection.tiktokEnabled && connection.tiktokAdvertiserId && tiktokForms.length;
  const whatsapp = mergeWhatsApp(state.whatsapp);
  const whatsappStatus = whatsapp.settings.env_status || {};
  const scopedRecords = companyRecords(company.id);
  const scopedCampaigns = companyCampaigns(company.id);
  const healthRows = buildOpsHealth(company, scopedRecords, scopedCampaigns);

  refs.connectionBadge.textContent = `${formatNumber(activeSyncCount)} active sync`;
  refs.integrationBoard.innerHTML = `
    <article class="integration-card system-card-wide ops-health-card">
      <strong>Connector health check</strong>
      <p>Ringkasan ini bantu detect kenapa lead TikTok/Meta tak masuk CRM, atau spend tak keluar dalam report. Semak ini dulu sebelum buat kempen baru.</p>
      <div class="health-grid compact">
        ${renderHealthRows(healthRows.slice(0, 3))}
      </div>
    </article>
    <article class="integration-card">
      <strong>Meta Ads sync</strong>
      <p>${connection.metaEnabled ? "Lead Ads mapping aktif untuk company ini." : "Belum dihidupkan. Sambung bila Page ID, form IDs dan access token dah ada."}</p>
      <div class="integration-meta">
        <span class="meta-pill">${connection.metaEnabled ? "On" : "Off"}</span>
        <span class="meta-pill">${connection.metaPageId || "No Page ID"}</span>
        <span class="meta-pill">${connection.metaAdAccountId ? `Ad account ${connection.metaAdAccountId}` : "No ad account ID"}</span>
        <span class="meta-pill">${metaForms.length ? `${metaForms.length} form mapped` : "No forms mapped"}</span>
        <span class="meta-pill">Spend ${connection.metaSpendSyncEnabled ? "auto-on" : "manual"}</span>
        <span class="meta-pill">${campaignName(connection.metaCampaignId)}</span>
      </div>
      <code class="webhook-code">${baseUrl}/api/webhooks/meta</code>
    </article>
    <article class="integration-card">
      <strong>TikTok Ads sync</strong>
      <p>${connection.tiktokEnabled ? "TikTok lead mode dan callback dah dipetakan untuk company ini." : "Belum dihidupkan. Sesuai untuk instant form, business account lead gen atau website redirect flow."}</p>
      <div class="integration-meta">
        <span class="meta-pill">${connection.tiktokEnabled ? "On" : "Off"}</span>
        <span class="meta-pill">${connection.tiktokLeadMode || "instant-form"}</span>
        <span class="meta-pill">${tiktokForms.length ? `${tiktokForms.length} form mapped` : "No forms mapped"}</span>
        <span class="meta-pill">Spend ${connection.tiktokSpendSyncEnabled ? "auto-on" : "manual"}</span>
        <span class="meta-pill">${campaignName(connection.tiktokCampaignId)}</span>
      </div>
      <code class="webhook-code">${baseUrl}/api/webhooks/tiktok</code>
    </article>
    <article class="integration-card">
      <strong>Capture rules</strong>
      <p>Auto-assign, company tag, status awal dan campaign attribution.</p>
      <div class="integration-meta">
        <span class="meta-pill">Meta start ${connection.metaDefaultStaff || "-"}</span>
        <span class="meta-pill">TikTok start ${connection.tiktokDefaultStaff || "-"}</span>
        <span class="meta-pill">${company.name}</span>
      </div>
    </article>
    <article class="integration-card tiktok-launch-card">
      <strong>TikTok launch profile</strong>
      <p>${tiktokReady ? "Salam Land TikTok CRM-side ready." : "TikTok connection pending."}</p>
      <div class="integration-meta">
        <span class="meta-pill">${tiktokReady ? "Ready run" : "Pending mapping"}</span>
        <span class="meta-pill">Advertiser ${connection.tiktokAdvertiserId || "-"}</span>
        <span class="meta-pill">${tiktokForms.length ? `Form ${tiktokForms[0]}` : "Form ID pending"}</span>
      </div>
      <div class="integration-meta">
        <span class="meta-pill">SLD Tanah Lot Lead Form</span>
        <span class="meta-pill">Nama + phone + projek</span>
        <span class="meta-pill">Terengganu projects</span>
        <span class="meta-pill">CRM auto-capture</span>
      </div>
      <code class="webhook-code">${baseUrl}/api/webhooks/tiktok</code>
    </article>
    <article class="integration-card">
      <strong>Official WhatsApp Cloud API</strong>
      <p>Auto-send template bila lead baru masuk, rekod reply customer, status sent/delivered/read/failed dan opt-out. Token hanya dibaca dari backend ENV.</p>
      <div class="integration-meta">
        <span class="meta-pill ${whatsappStatus.status === "connected" ? "success" : ""}">${whatsappStatusLabel(whatsappStatus.status)}</span>
        <span class="meta-pill">${whatsapp.settings.is_active ? "Auto send on" : "Auto send off"}</span>
        <span class="meta-pill">${formatNumber(whatsapp.messages.length)} message log</span>
        <span class="meta-pill">${whatsapp.settings.default_template_name || "Template pending"}</span>
      </div>
      <code class="webhook-code">${baseUrl}/api/webhooks/whatsapp</code>
      <button class="ghost-button" type="button" data-open-whatsapp-settings ${canManageWhatsAppSettings() ? "" : "disabled"}>WhatsApp settings</button>
    </article>
    <article class="integration-card">
      <strong>Inbound event inbox</strong>
      <p>Semua event webhook yang berjaya masuk boleh direkod dalam backend. Ini penting untuk audit, dedupe, dan troubleshooting bila publish production.</p>
      <div class="integration-meta">
        <span class="meta-pill">${eventCount ? `${formatNumber(eventCount)} event recent` : "No event yet"}</span>
        <span class="meta-pill">${state.runtime.backendReady ? "200 OK route ready" : "Run server mode first"}</span>
      </div>
    </article>
  `;
}

function renderWhatsAppApiBoard() {
  if (!refs.whatsappApiBoard) return;
  const whatsapp = mergeWhatsApp(state.whatsapp);
  const settings = whatsapp.settings || {};
  const envStatus = settings.env_status || {};
  const missing = Array.isArray(envStatus.missing) ? envStatus.missing : [];
  const allowedStaff = Array.isArray(envStatus.allowed_staff) && envStatus.allowed_staff.length
    ? envStatus.allowed_staff.join(", ")
    : "All staff";
  const canManage = canManageWhatsAppSettings();
  const webhookUrl = `${currentBaseUrl()}/api/webhooks/whatsapp`;

  refs.whatsappApiBoard.innerHTML = `
    <article class="integration-card system-card-wide wa-command-card">
      <div class="wa-command-header">
        <div>
          <p class="eyebrow">Official WhatsApp Cloud API</p>
          <strong>Nureen pilot command centre</strong>
        </div>
        <span class="panel-badge">${whatsappStatusLabel(envStatus.status)}</span>
      </div>
      <div class="integration-meta">
        <span class="meta-pill ${envStatus.status === "connected" ? "success" : ""}">${whatsappStatusLabel(envStatus.status)}</span>
        <span class="meta-pill">${settings.is_active ? "Auto intro on" : "Auto intro off"}</span>
        <span class="meta-pill">${envStatus.has_access_token ? "ENV token ready" : "ENV token missing"}</span>
        <span class="meta-pill">${settings.default_template_name || "Template pending"}</span>
        <span class="meta-pill">Pilot: ${escapeHtml(allowedStaff)}</span>
        <span class="meta-pill">${formatNumber(whatsapp.messages.length)} message log</span>
        <span class="meta-pill">${formatNumber(whatsapp.optOuts.length)} opt-out</span>
      </div>
      ${missing.length ? `<p class="modal-note">Missing config: ${missing.map(escapeHtml).join(", ")}</p>` : ""}
      <code class="webhook-code">${webhookUrl}</code>
      <div class="wa-command-actions">
        <button class="primary-button" type="button" data-open-whatsapp-settings ${canManage ? "" : "disabled"}>Open WhatsApp settings</button>
        <button class="ghost-button" type="button" data-open-control ${canManage ? "" : "disabled"}>Open server settings</button>
      </div>
    </article>
    ${renderWhatsAppInboxPreview()}
    <article class="integration-card system-card-wide wa-readiness-card">
      <div class="wa-command-header">
        <div>
          <p class="eyebrow">Readiness</p>
          <strong>Production controls</strong>
        </div>
        <span class="panel-badge">${settings.is_active ? "Active" : "Standby"}</span>
      </div>
      <div class="wa-readiness-grid">
        <span class="wa-readiness-item ${envStatus.status === "connected" ? "ready" : ""}">
          <b>Number</b>
          <small>${whatsappStatusLabel(envStatus.status)}</small>
        </span>
        <span class="wa-readiness-item ${envStatus.has_access_token ? "ready" : ""}">
          <b>Token</b>
          <small>${envStatus.has_access_token ? "ENV ready" : "Missing ENV"}</small>
        </span>
        <span class="wa-readiness-item ${settings.default_template_name ? "ready" : ""}">
          <b>Template</b>
          <small>${settings.default_template_name || "Pending"}</small>
        </span>
        <span class="wa-readiness-item ready">
          <b>Pilot</b>
          <small>${escapeHtml(allowedStaff)}</small>
        </span>
        <span class="wa-readiness-item">
          <b>Messages</b>
          <small>${formatNumber(whatsapp.messages.length)} logs</small>
        </span>
        <span class="wa-readiness-item">
          <b>Opt-out</b>
          <small>${formatNumber(whatsapp.optOuts.length)} contacts</small>
        </span>
      </div>
    </article>
  `;
}

function renderHero() {
  const company = activeCompany();
  const records = companyRecords();
  const monthClosedSales = currentMonthRecords(records.filter(isClosed)).reduce((sum, item) => sum + Number(item.value || 0), 0);

  refs.systemLabel.textContent = accessLocked()
    ? "Secure access"
    : "Company overview";
  refs.workspaceHeading.textContent = accessLocked()
    ? "CRM Salam Fortress / Secure Preview"
    : `CRM Salam Fortress / ${company.name}`;
  refs.companyLogo.src = company.logo;
  refs.companyLogo.alt = `${company.name} logo`;
  refs.companyLogo.className = `hero-logo ${company.logoClass}`.trim();
  refs.companyLogoWrap.className = `hero-logo-wrap ${company.logoClass ? `is-${company.logoClass}` : ""}`.trim();
  refs.heroBrand.className = `hero-brand ${company.logoClass ? `is-${company.logoClass}` : ""}`.trim();
  refs.companyBusiness.textContent = company.business;
  refs.companyName.textContent = company.name;
  refs.companyTagline.textContent = company.tagline;
  refs.heroPills.innerHTML = company.pills.map((pill) => `<span class="hero-pill">${pill}</span>`).join("");
  refs.todayLeadsCount.textContent = formatNumber(todayRecords(records).filter((record) => record.kind === "lead").length);
  refs.followUpDueCount.textContent = formatNumber(dueFollowUps(records).length);
  refs.monthClosedValue.textContent = formatCurrency(monthClosedSales);
}

function renderMetrics() {
  const company = activeCompany();
  const records = companyRecords();
  const info = summary(records, companyCampaigns());
  const openLeads = records.filter((record) => record.kind === "lead" && isOpen(record));
  const belumWs = openLeads.filter((record) => !normalizeActionFlags(record.actionFlags, record).wsSent).length;
  const monthOrders = currentMonthRecords(activeOrders(records)).length;
  const metrics = [
    ["Today leads", formatNumber(info.todayLeads), "Lead masuk hari ini"],
    ["Belum WS", formatNumber(belumWs), "Customer belum ditekan WhatsApp"],
    ["Open queue", formatNumber(info.open), "Lead / order yang belum selesai"],
    ["Booking month", formatNumber(monthOrders), "Order bulan semasa"],
    ["Closed sales", formatCurrency(info.sales), `${formatNumber(info.closedCount)} rekod closed`],
    ["Spend / CPL", formatCurrency(info.spend), `CPL ${formatCurrency(info.cpl)}`]
  ];

  refs.metricStrip.innerHTML = metrics.map(([label, value, note]) => `
    <article class="metric-card">
      <span>${label}</span>
      <strong>${value}</strong>
      <p>${note}</p>
    </article>
  `).join("");
  refs.themeBadge.textContent = company.themeBadge;
}

function compactCurrency(value = 0) {
  const amount = Number(value || 0);
  const sign = amount < 0 ? "-" : "";
  const absolute = Math.abs(amount);
  if (absolute >= 1000000) return `${sign}RM ${(absolute / 1000000).toFixed(1).replace(/\.0$/, "")}M`;
  if (absolute >= 1000) return `${sign}RM ${Math.round(absolute / 1000)}K`;
  return formatCurrency(amount);
}

function statusColor(index = 0) {
  return ["#14b8a6", "#22c55e", "#2563eb", "#f59e0b", "#ef4444", "#8b5cf6", "#64748b"][index % 7];
}

function dashboardMonthLabel(dateValue = "") {
  const date = toDate(dateValue);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat("en-MY", { month: "short" }).format(date)
    : "-";
}

function lastMonthKeys(count = 6) {
  const now = new Date();
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(now.getFullYear(), now.getMonth() - (count - 1 - index), 1);
    return localIsoDate(date).slice(0, 7);
  });
}

function renderBumiHayatDashboardLayer(records) {
  const orders = activeOrders(records);
  const leads = records.filter((record) => record.kind === "lead");
  const productionStatuses = ["Artwork", "Mockup", "Printing", "QC", "Ready", "Delivered"];
  const productionRows = productionStatuses.map((status) => ({
    status,
    count: orders.filter((record) => record.details?.productionStatus === status || record.status === status).length
  }));
  const maxProduction = Math.max(...productionRows.map((item) => item.count), 1);
  const quoteCount = records.filter((record) => record.status === "Quotation" || numeric(record.details?.quoteAmount)).length;
  const depositCount = records.filter((record) => record.status === "Deposit" || numeric(record.details?.designDeposit) || numeric(record.details?.depositAmount) || numeric(record.details?.finalPaymentAmount)).length;
  const totalQuantity = orders.reduce((sum, record) => sum + numeric(record.details?.quantity || record.units), 0);
  const deliveredCount = orders.filter((record) => record.status === "Delivered" || record.details?.productionStatus === "Delivered").length;
  const deadlineRows = orders
    .filter((record) => record.details?.deadline)
    .slice()
    .sort((a, b) => String(a.details.deadline).localeCompare(String(b.details.deadline)))
    .slice(0, 5);
  const customerTypeRows = Array.from(records.reduce((map, record) => {
    const type = record.details?.customerType || "Tidak pasti";
    map.set(type, (map.get(type) || 0) + 1);
    return map;
  }, new Map()).entries()).sort((a, b) => b[1] - a[1]);

  return `
    <article class="dash-card company-insight-card">
      <div class="dash-card-head">
        <div>
          <p class="eyebrow">Factory pipeline</p>
          <h3>Quotation sampai delivery</h3>
        </div>
        <span class="dash-count">${formatNumber(totalQuantity)} pcs</span>
      </div>
      <div class="company-insight-grid">
        <div class="mini-stat"><span>Leads</span><strong>${formatNumber(leads.length)}</strong></div>
        <div class="mini-stat"><span>Quotation</span><strong>${formatNumber(quoteCount)}</strong></div>
        <div class="mini-stat"><span>Payment step</span><strong>${formatNumber(depositCount)}</strong></div>
        <div class="mini-stat"><span>Delivered</span><strong>${formatNumber(deliveredCount)}</strong></div>
      </div>
      <div class="horizontal-chart compact">
        ${productionRows.map((item) => `
          <div class="chart-row">
            <span>${escapeHtml(item.status)}</span>
            <div class="chart-track"><i style="width:${Math.max(item.count ? 8 : 0, Math.round((item.count / maxProduction) * 100))}%"></i></div>
            <strong>${formatNumber(item.count)}</strong>
          </div>
        `).join("")}
      </div>
    </article>

    <article class="dash-card">
      <div class="dash-card-head">
        <div>
          <p class="eyebrow">Order deadline</p>
          <h3>Production due list</h3>
        </div>
        <span class="dash-count">${formatNumber(deadlineRows.length)}</span>
      </div>
      <div class="mini-table company-mini-list">
        ${deadlineRows.map((record) => `
          <div class="mini-table-row">
            <strong>${escapeHtml(record.customerName || "-")}</strong>
            <span>${escapeHtml(record.details?.productionStatus || record.status || "-")}</span>
            <span>${escapeHtml(record.staff || "-")}</span>
            <em>${prettyDate(record.details.deadline)}</em>
          </div>
        `).join("") || `<div class="empty-state compact">Belum ada deadline production direkod.</div>`}
      </div>
      <div class="source-bars">
        ${customerTypeRows.map(([type, count], index) => `
          <div>
            <span>${escapeHtml(type)}</span>
            <strong>${formatNumber(count)}</strong>
            <i style="--source-color:${statusColor(index)}; width:${Math.max(8, Math.round((count / Math.max(records.length, 1)) * 100))}%"></i>
          </div>
        `).join("")}
      </div>
    </article>
  `;
}

function renderBarakahDashboardLayer(records) {
  const orders = activeOrders(records);
  const leads = records.filter((record) => record.kind === "lead");
  const transactionRows = Array.from(records.reduce((map, record) => {
    const type = record.details?.transactionType || "Survey harga";
    map.set(type, (map.get(type) || 0) + 1);
    return map;
  }, new Map()).entries()).sort((a, b) => b[1] - a[1]);
  const maxTransaction = Math.max(...transactionRows.map(([, count]) => count), 1);
  const totalGram = orders.reduce((sum, record) => sum + numeric(record.details?.grams || record.units), 0);
  const avgRate = totalGram ? orders.reduce((sum, record) => sum + dashboardOrderValue(record), 0) / totalGram : 0;
  const paymentRows = ["Payment", "Closed", "Appointment", "Product Suggested"].map((status) => ({
    status,
    count: records.filter((record) => record.status === status).length
  }));
  const maxPayment = Math.max(...paymentRows.map((item) => item.count), 1);

  return `
    <article class="dash-card company-insight-card gold-insight-card">
      <div class="dash-card-head">
        <div>
          <p class="eyebrow">Gold transaction lens</p>
          <h3>Lead, gram dan transaksi</h3>
        </div>
        <span class="dash-count">${formatNumber(totalGram)}g</span>
      </div>
      <div class="company-insight-grid">
        <div class="mini-stat"><span>Leads</span><strong>${formatNumber(leads.length)}</strong></div>
        <div class="mini-stat"><span>Orders</span><strong>${formatNumber(orders.length)}</strong></div>
        <div class="mini-stat"><span>Total gram</span><strong>${formatNumber(totalGram)}</strong></div>
        <div class="mini-stat"><span>Avg RM/g</span><strong>${avgRate ? formatCurrency(avgRate) : "RM 0"}</strong></div>
      </div>
      <div class="horizontal-chart compact">
        ${transactionRows.map(([type, count]) => `
          <div class="chart-row">
            <span>${escapeHtml(type)}</span>
            <div class="chart-track"><i style="width:${Math.max(count ? 8 : 0, Math.round((count / maxTransaction) * 100))}%"></i></div>
            <strong>${formatNumber(count)}</strong>
          </div>
        `).join("") || `<div class="empty-state compact">Belum ada transaksi emas direkod.</div>`}
      </div>
    </article>

    <article class="dash-card">
      <div class="dash-card-head">
        <div>
          <p class="eyebrow">Trust pipeline</p>
          <h3>Status jualan emas</h3>
        </div>
        <span class="dash-count">${formatRatePerGram(state.goldRates.gram916 || 0)} 916/g</span>
      </div>
      <div class="horizontal-chart compact">
        ${paymentRows.map((item) => `
          <div class="chart-row">
            <span>${escapeHtml(item.status)}</span>
            <div class="chart-track"><i style="width:${Math.max(item.count ? 8 : 0, Math.round((item.count / maxPayment) * 100))}%"></i></div>
            <strong>${formatNumber(item.count)}</strong>
          </div>
        `).join("")}
      </div>
      <div class="company-rate-strip">
        <span>999/g <strong>${state.goldRates.gram999 ? formatRatePerGram(state.goldRates.gram999) : "-"}</strong></span>
        <span>916/g <strong>${state.goldRates.gram916 ? formatRatePerGram(state.goldRates.gram916) : "-"}</strong></span>
      </div>
    </article>
  `;
}

function renderCompanyDashboardLayer(company, records) {
  if (company.id === "bumi-hayat") return renderBumiHayatDashboardLayer(records);
  if (company.id === "barakah-emas") return renderBarakahDashboardLayer(records);
  return "";
}

function dashboardSafeNumber(value) {
  const number = Number(String(value ?? 0).replace(/[^\d.-]/g, ""));
  return Number.isFinite(number) ? number : 0;
}

function dashboardRecordDate(record) {
  return recordDateKey(record);
}

function dashboardDateKeys(days = 7) {
  const base = new Date(`${todayIso()}T00:00:00`);
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(base);
    date.setDate(base.getDate() - (days - 1 - index));
    return localIsoDate(date);
  });
}

function dashboardShortDateLabel(isoDate = "") {
  const [, month, day] = String(isoDate).split("-");
  return day && month ? `${Number(day)}/${Number(month)}` : isoDate;
}

function dashboardCampaignPlatform(campaign = {}) {
  const text = `${campaign.platform || ""} ${campaign.source || ""} ${campaign.name || campaign.campaignName || ""}`.toLowerCase();
  if (text.includes("tiktok") || text.includes("tt ads")) return "TikTok Ads";
  if (text.includes("meta") || text.includes("facebook") || text.includes("fb ads")) return "Meta Ads";
  return campaign.platform || campaign.source || "Other";
}

function dashboardCampaignDailyValue(campaign, isoDate, fields) {
  const rows = Array.isArray(campaign.dailyInsights) ? campaign.dailyInsights : [];
  if (rows.length) {
    return rows
      .filter((row) => String(row.date || row.date_start || row.dateStart || "").slice(0, 10) === isoDate)
      .reduce((sum, row) => sum + fields.reduce((fieldSum, field) => fieldSum + dashboardSafeNumber(row[field]), 0), 0);
  }
  const fallbackDate = String(campaign.date || campaign.createdAt || campaign.updatedAt || "").slice(0, 10);
  if (fallbackDate !== isoDate) return 0;
  return fields.reduce((sum, field) => sum + dashboardSafeNumber(campaign[field]), 0);
}

function dashboardIsBookingRecord(record) {
  if (isCancelledRefund(record)) return false;
  const flags = normalizeActionFlags(record.actionFlags, record);
  return record.kind === "order" || record.status === "Booking" || record.status === "Deposit" || Boolean(flags.booking);
}

function buildDashboardPlatformRows(records, campaigns, dateKeys = dashboardDateKeys(7)) {
  return ["Meta Ads", "TikTok Ads"].map((platform) => {
    const platformCampaigns = campaigns.filter((campaign) => dashboardCampaignPlatform(campaign) === platform);
    const daily = dateKeys.map((date) => {
      const spend = platformCampaigns.reduce((sum, campaign) => sum + dashboardCampaignDailyValue(campaign, date, ["spend", "amountSpent", "cost"]), 0);
      const adsLeads = platformCampaigns.reduce((sum, campaign) => sum + dashboardCampaignDailyValue(campaign, date, ["adsManagerLeads", "leads", "conversions", "formSubmissions"]), 0);
      const crmLeads = records.filter((record) => record.kind === "lead" && record.source === platform && dashboardRecordDate(record) === date).length;
      return { date, spend, adsLeads, crmLeads };
    });
    const dailySpend = daily.reduce((sum, row) => sum + row.spend, 0);
    const dailyAdsLeads = daily.reduce((sum, row) => sum + row.adsLeads, 0);
    const crmLeadTotal = daily.reduce((sum, row) => sum + row.crmLeads, 0);
    const fallbackSpend = platformCampaigns.reduce((sum, campaign) => sum + dashboardSafeNumber(campaign.spend || campaign.amountSpent || campaign.cost), 0);
    const fallbackAdsLeads = platformCampaigns.reduce((sum, campaign) => sum + dashboardSafeNumber(campaign.adsManagerLeads || campaign.leads || campaign.conversions || campaign.formSubmissions), 0);
    const reportedAdsLeads = dailyAdsLeads || fallbackAdsLeads;
    const spend = dailySpend || fallbackSpend;
    const adsLeads = reportedAdsLeads || crmLeadTotal;
    return {
      platform,
      daily,
      spend,
      adsLeads,
      reportedAdsLeads,
      crmLeads: crmLeadTotal,
      cpl: spend && adsLeads ? spend / adsLeads : 0,
      needsSpendToken: platform === "TikTok Ads" && crmLeadTotal > 0 && spend === 0
    };
  });
}

function healthToneClass(tone = "neutral") {
  if (tone === "success") return "success";
  if (tone === "warning") return "warning";
  if (tone === "danger") return "danger";
  return "";
}

function renderHealthRows(rows = []) {
  return rows.map((row) => `
    <div class="health-row ${healthToneClass(row.tone)}">
      <div>
        <span>${escapeHtml(row.label)}</span>
        <strong>${escapeHtml(row.value)}</strong>
        <small>${escapeHtml(row.detail || "")}</small>
      </div>
      <em>${escapeHtml(row.status)}</em>
    </div>
  `).join("");
}

function renderQaRows(rows = []) {
  return rows.map((row) => `
    <div class="qa-row ${healthToneClass(row.tone)}">
      <span>${escapeHtml(row.label)}</span>
      <strong>${escapeHtml(row.status)}</strong>
      <small>${escapeHtml(row.detail || "")}</small>
    </div>
  `).join("");
}

function buildQaChecklist(company, records, campaigns) {
  const connection = activeConnection(company.id);
  const orders = activeOrders(records);
  const hasLeadFlow = records.some((record) => record.kind === "lead");
  const hasOrderFlow = orders.length > 0;
  const hasPaymentFlow = orders.some((record) => {
    const phases = Array.isArray(record.details?.paymentPhases) ? record.details.paymentPhases : [];
    return numeric(record.details?.bookingAmount) || numeric(record.details?.totalPaid) || phases.length;
  });
  const hasCampaignFlow = campaigns.length > 0;
  const hasMetaSignal = connection.metaEnabled || campaigns.some((campaign) => campaign.platform === "Meta Ads");
  const hasTikTokSignal = connection.tiktokEnabled || campaigns.some((campaign) => campaign.platform === "TikTok Ads");
  const hasReportFlow = Boolean(refs.reportButton);
  const duplicateRisk = records.filter((record) => record.status === "Duplicate Lead" || record.details?.archivedDuplicate).length;

  return [
    {
      label: "Login & role scope",
      status: accessLocked() ? "Locked" : "Ready",
      detail: `${activeProfile().name} / ${activeProfile().role}`,
      tone: accessLocked() ? "warning" : "success"
    },
    {
      label: "Lead capture",
      status: hasLeadFlow || hasMetaSignal || hasTikTokSignal ? "Ready" : "No signal",
      detail: `${formatNumber(records.filter((record) => record.kind === "lead").length)} lead visible dalam ${company.name}`,
      tone: hasLeadFlow || hasMetaSignal || hasTikTokSignal ? "success" : "warning"
    },
    {
      label: "Orders & payment",
      status: hasOrderFlow ? "Ready" : "Empty",
      detail: `${formatNumber(orders.length)} order · ${hasPaymentFlow ? "payment fields active" : "belum ada payment log"}`,
      tone: hasOrderFlow ? "success" : "neutral"
    },
    {
      label: "Campaign spend",
      status: hasCampaignFlow ? "Ready" : "Empty",
      detail: `${formatNumber(campaigns.length)} campaign · Meta/TikTok dipisahkan`,
      tone: hasCampaignFlow ? "success" : "warning"
    },
    {
      label: "Reports",
      status: hasReportFlow ? "Ready" : "Check",
      detail: "PDF report + spend summary available dari Reports",
      tone: hasReportFlow ? "success" : "warning"
    },
    {
      label: "Duplicate/status risk",
      status: duplicateRisk ? "Review" : "Clear",
      detail: duplicateRisk ? `${formatNumber(duplicateRisk)} duplicate/archived record detected` : "Tiada duplicate risk visible",
      tone: duplicateRisk ? "warning" : "success"
    }
  ];
}

function buildOpsHealth(company, records, campaigns) {
  const connection = activeConnection(company.id);
  const platformRows = buildDashboardPlatformRows(records, campaigns, dashboardDateKeys(7));
  const platformByName = Object.fromEntries(platformRows.map((row) => [row.platform, row]));
  const meta = platformByName["Meta Ads"] || {};
  const tiktok = platformByName["TikTok Ads"] || {};
  const whatsapp = mergeWhatsApp(state.whatsapp);
  const whatsappStatus = whatsapp.settings.env_status || {};
  const metaMissing = Math.max(0, dashboardSafeNumber(meta.reportedAdsLeads) - dashboardSafeNumber(meta.crmLeads));
  const tiktokMissing = Math.max(0, dashboardSafeNumber(tiktok.reportedAdsLeads) - dashboardSafeNumber(tiktok.crmLeads));
  const backupLabel = state.control.lastBackupAt ? localDateTimeLabel(new Date(state.control.lastBackupAt)) : "Belum ada backup";
  const hasTikTokSpendToken = Boolean(String(connection.tiktokAccessToken || "").trim());
  const hasMetaSpendToken = Boolean(String(connection.metaSpendAccessToken || connection.metaAccessToken || "").trim());

  return [
    {
      label: "Meta Ads capture",
      value: `${formatNumber(meta.crmLeads || 0)} CRM / ${formatNumber(meta.reportedAdsLeads || 0)} Ads leads`,
      detail: metaMissing ? `${formatNumber(metaMissing)} lead perlu semak mapping / import` : "Lead gap clear untuk window 7 hari",
      status: connection.metaEnabled ? "Active" : "Off",
      tone: connection.metaEnabled && !metaMissing ? "success" : metaMissing ? "warning" : "neutral"
    },
    {
      label: "TikTok Ads capture",
      value: `${formatNumber(tiktok.crmLeads || 0)} CRM / ${formatNumber(tiktok.reportedAdsLeads || 0)} Ads leads`,
      detail: tiktokMissing ? `${formatNumber(tiktokMissing)} lead perlu semak LeadsBridge / webhook` : "Lead gap clear untuk window 7 hari",
      status: connection.tiktokEnabled ? "Active" : "Off",
      tone: connection.tiktokEnabled && !tiktokMissing ? "success" : tiktokMissing ? "warning" : "neutral"
    },
    {
      label: "Marketing spend sync",
      value: `Meta ${formatCurrency(meta.spend || 0)} · TikTok ${formatCurrency(tiktok.spend || 0)}`,
      detail: `${hasMetaSpendToken ? "Meta token ready" : "Meta token/manual"} · ${hasTikTokSpendToken ? "TikTok token ready" : "TikTok spend token pending"}`,
      status: connection.metaSpendSyncEnabled || connection.tiktokSpendSyncEnabled ? "Tracked" : "Manual",
      tone: tiktok.needsSpendToken || (connection.tiktokSpendSyncEnabled && !hasTikTokSpendToken) ? "warning" : "success"
    },
    {
      label: "WhatsApp Cloud API",
      value: whatsappStatusLabel(whatsappStatus.status),
      detail: `${formatNumber(whatsapp.messages.length)} message log · ${formatNumber(whatsapp.optOuts.length)} opt-out`,
      status: whatsapp.settings.is_active ? "Auto on" : "Auto off",
      tone: whatsappStatus.status === "connected" ? "success" : whatsapp.settings.is_active ? "warning" : "neutral"
    },
    {
      label: "Backup & rollback",
      value: backupLabel,
      detail: `${state.control.settings.autoBackupEnabled ? "Auto backup enabled" : "Auto backup off"} · retention ${formatNumber(state.control.settings.backupRetentionDays)} hari`,
      status: state.control.lastBackupAt ? "Ready" : "Pending",
      tone: state.control.lastBackupAt ? "success" : "warning"
    }
  ];
}

function renderDashboardAnalytics() {
  if (!refs.dashboardAnalytics) return;
  const company = activeCompany();
  const records = companyRecords();
  const campaigns = companyCampaigns(company.id);
  const closedRecords = records.filter(isClosed);
  const orderRecords = activeOrders(records);
  const dateKeys = dashboardDateKeys(7);
  const leadRows = dateKeys.map((date) => ({
    date,
    leads: records.filter((record) => record.kind === "lead" && dashboardRecordDate(record) === date).length,
    bookings: records.filter((record) => dashboardIsBookingRecord(record) && dashboardRecordDate(record) === date).length,
    closed: closedRecords.filter((record) => dashboardRecordDate(record) === date).length
  }));
  const maxLeadFlow = Math.max(...leadRows.flatMap((item) => [item.leads, item.bookings, item.closed]), 1);
  const platformRows = buildDashboardPlatformRows(records, campaigns, dateKeys);
  const maxSpend = Math.max(...platformRows.flatMap((item) => item.daily.map((row) => row.spend || row.crmLeads)), 1);
  const staffRows = company.staff.map((staffName) => {
    const staffRecords = records.filter((record) => record.staff === staffName);
    const staffOrders = orderRecords.filter((record) => record.staff === staffName);
    const staffClosed = closedRecords.filter((record) => record.staff === staffName);
    return {
      staffName,
      leads: staffRecords.filter((record) => record.kind === "lead").length,
      wsSent: staffRecords.filter((record) => normalizeActionFlags(record.actionFlags, record).wsSent).length,
      booking: staffOrders.length,
      closed: staffClosed.length,
      salesValue: staffOrders.reduce((sum, item) => sum + dashboardOrderValue(item), 0),
      closedValue: staffClosed.reduce((sum, item) => sum + dashboardOrderValue(item), 0)
    };
  }).sort((a, b) => b.salesValue - a.salesValue || b.closedValue - a.closedValue || b.booking - a.booking || b.leads - a.leads || a.staffName.localeCompare(b.staffName));
  const riskRows = company.staff.map((staffName) => {
    const staffRecords = records.filter((record) => record.staff === staffName && isOpen(record));
    return {
      staffName,
      overdue: staffRecords.filter((record) => record.nextFollowUp && record.nextFollowUp < todayIso()).length,
      belumWs: staffRecords.filter((record) => !normalizeActionFlags(record.actionFlags, record).wsSent).length,
      noReply: staffRecords.filter((record) => {
        const flags = normalizeActionFlags(record.actionFlags, record);
        return flags.wsSent && !flags.reply;
      }).length
    };
  }).sort((a, b) => (b.overdue + b.belumWs) - (a.overdue + a.belumWs) || a.staffName.localeCompare(b.staffName));

  refs.dashboardAnalytics.innerHTML = `
    <article class="dash-card dashboard-chart-card lead-flow-card">
      <div class="dash-card-head">
        <div>
          <p class="eyebrow">Lead conversion pulse</p>
          <h3>Leads vs Booking vs Closed</h3>
        </div>
        <span class="dash-count">7 hari</span>
      </div>
      <div class="multi-series-chart" aria-label="Leads booking closed by date">
        ${leadRows.map((item) => `
          <div class="series-day">
            <div class="series-bars">
              <i class="bar-leads" title="Leads ${item.leads}" style="height:${Math.max(item.leads ? 12 : 3, Math.round((item.leads / maxLeadFlow) * 132))}px"></i>
              <i class="bar-booking" title="Booking ${item.bookings}" style="height:${Math.max(item.bookings ? 12 : 3, Math.round((item.bookings / maxLeadFlow) * 132))}px"></i>
              <i class="bar-closed" title="Closed ${item.closed}" style="height:${Math.max(item.closed ? 12 : 3, Math.round((item.closed / maxLeadFlow) * 132))}px"></i>
            </div>
            <strong>${formatNumber(item.leads)}</strong>
            <em>${dashboardShortDateLabel(item.date)}</em>
          </div>
        `).join("")}
      </div>
      <div class="chart-legend">
        <span><i class="bar-leads"></i>Leads</span>
        <span><i class="bar-booking"></i>Booking</span>
        <span><i class="bar-closed"></i>Closed</span>
      </div>
    </article>

    <article class="dash-card dashboard-chart-card spend-cpl-card">
      <div class="dash-card-head">
        <div>
          <p class="eyebrow">Marketing efficiency</p>
          <h3>Meta vs TikTok Spend / CPL</h3>
        </div>
        <span class="dash-count">${formatCurrency(platformRows.reduce((sum, item) => sum + item.spend, 0))}</span>
      </div>
      <div class="spend-platform-grid">
        ${platformRows.map((item) => `
          <div class="platform-spend-card ${item.platform === "TikTok Ads" ? "is-tiktok" : "is-meta"}">
            <div>
              <span>${item.platform}</span>
              <strong>${formatCurrency(item.spend)}</strong>
              <small>${formatNumber(item.adsLeads)} total leads · ${formatNumber(item.crmLeads)} CRM captured · CPL ${item.spend ? formatCurrency(item.cpl) : "-"}</small>
              ${item.needsSpendToken ? `<small class="sync-warning">TikTok spend belum sync</small>` : ""}
            </div>
            <div class="daily-spend-bars">
              ${item.daily.map((row) => {
                const visualValue = row.spend || row.crmLeads;
                return `<i title="${dashboardShortDateLabel(row.date)} · ${formatCurrency(row.spend)} · ${formatNumber(row.crmLeads)} CRM leads" style="height:${Math.max(visualValue ? 9 : 3, Math.round((visualValue / maxSpend) * 78))}px"></i>`;
              }).join("")}
            </div>
          </div>
        `).join("")}
      </div>
    </article>

    <article class="dash-card leaderboard-card">
      <div class="dash-card-head">
        <div>
          <p class="eyebrow">Team sales leaderboard</p>
          <h3>Top performers</h3>
        </div>
        <span class="dash-count">${formatCurrency(staffRows.reduce((sum, item) => sum + item.salesValue, 0))}</span>
      </div>
      <div class="premium-leaderboard">
        ${staffRows.slice(0, 5).map((item, index) => `
          <div class="leaderboard-row">
            <b>${String(index + 1).padStart(2, "0")}</b>
            <div>
              <strong>${escapeHtml(item.staffName)}</strong>
              <small>${formatNumber(item.leads)} leads · ${formatNumber(item.wsSent)} WS sent · ${formatNumber(item.booking)} booking · ${formatNumber(item.closed)} closed</small>
            </div>
            <em>
              <span>${formatCurrency(item.salesValue)}</span>
              <small>Jumlah sales</small>
            </em>
          </div>
        `).join("")}
      </div>
    </article>

    <article class="dash-card risk-panel-card">
      <div class="dash-card-head">
        <div>
          <p class="eyebrow">Follow-up risk</p>
          <h3>Overdue & belum WS</h3>
        </div>
        <span class="dash-count">${formatNumber(riskRows.reduce((sum, item) => sum + item.overdue + item.belumWs, 0))} risk</span>
      </div>
      <div class="risk-list">
        ${riskRows.slice(0, 5).map((item) => `
          <div class="risk-row">
            <strong>${escapeHtml(item.staffName)}</strong>
            <span><b>${formatNumber(item.overdue)}</b> overdue</span>
            <span><b>${formatNumber(item.belumWs)}</b> belum WS</span>
            <span><b>${formatNumber(item.noReply)}</b> belum reply</span>
          </div>
        `).join("")}
      </div>
    </article>
  `;
}

function renderFlowArchitecture() {
  const company = activeCompany();
  refs.flowEyebrow.textContent = company.id === "salam-land"
    ? "Land conversion architecture"
    : company.id === "bumi-hayat"
      ? "Factory delivery architecture"
      : "Gold conversion architecture";
  refs.flowHeading.textContent = `${company.name} command flow`;
  refs.flowSummary.textContent = company.flowSummary || "Setiap modul ada lane yang jelas dari capture sampai conversion supaya staff, marketing dan owner tengok sistem yang sama tanpa berselerak.";
  refs.flowMeta.innerHTML = `
    <span class="meta-pill">${company.operationsFlow.length}-stage operating lane</span>
    <span class="meta-pill">${company.staff.length} staff / team sales</span>
    <span class="meta-pill">${company.themeBadge}</span>
  `;
  refs.flowRail.innerHTML = company.operationsFlow.map((item, index) => `
    <article class="flow-step" data-stage="${item.stage}">
      <div class="flow-step-top">
        <span class="flow-step-index">${item.stage}</span>
        ${index < company.operationsFlow.length - 1 ? `<span class="flow-step-line" aria-hidden="true"></span>` : ""}
      </div>
      <strong>${item.title}</strong>
      <p>${item.note}</p>
    </article>
  `).join("");
}

function renderBarakahGoldRateBoard() {
  const rates = state.goldRates;
  const staleLabel = rates.status === "live"
    ? "Auto sync active"
    : rates.status === "stale"
      ? "Using last snapshot"
      : rates.status === "loading" || rates.status === "refreshing"
        ? "Fetching live rate"
        : "Rate feed standby";
  const updatedLabel = rates.updatedAt ? localDateTimeLabel(new Date(rates.updatedAt)) : rates.fxDate ? prettyDate(rates.fxDate) : "-";

  return `
    <article class="document-card gold-rate-card centered">
      <div class="gold-rate-head">
        <div>
          <strong>Gold Rate Center</strong>
          <p>Harga rujukan auto untuk dashboard Barakah Emas. Nilai ini sesuai untuk pantau pasaran dan cadangan harga semasa.</p>
        </div>
        <span class="panel-badge">${staleLabel}</span>
      </div>
      <div class="gold-rate-grid">
        <div class="gold-rate-stat">
          <span>Emas 999 / g</span>
          <strong>${rates.gram999 ? formatRatePerGram(rates.gram999) : "-"}</strong>
          <p>Indicative spot reference</p>
        </div>
        <div class="gold-rate-stat">
          <span>Emas 916 / g</span>
          <strong>${rates.gram916 ? formatRatePerGram(rates.gram916) : "-"}</strong>
          <p>Indicative spot reference</p>
        </div>
      </div>
      <div class="gold-rate-grid compact">
        <div class="gold-rate-stat compact">
          <span>XAU / oz (USD)</span>
          <strong>${rates.ounceUsd ? `$${Number(rates.ounceUsd).toFixed(2)}` : "-"}</strong>
        </div>
        <div class="gold-rate-stat compact">
          <span>USD to MYR</span>
          <strong>${rates.usdMyr ? Number(rates.usdMyr).toFixed(4) : "-"}</strong>
        </div>
      </div>
      <div class="showcase-meta">
        <span class="meta-pill">Gold API spot</span>
        <span class="meta-pill">Frankfurter FX</span>
        <span class="meta-pill">Updated ${updatedLabel}</span>
      </div>
      <p class="showcase-note">${rates.error ? `Status: ${rates.error}` : "Nota: ini harga rujukan spot-based. Harga jual kedai, upah dan spread masih boleh ditetapkan berasingan."}</p>
      <button class="ghost-button" data-gold-refresh="true" type="button">Refresh gold rates</button>
    </article>
  `;
}

function renderShowcase() {
  const company = activeCompany();
  refs.showcaseEyebrow.textContent = company.id === "salam-land" ? "Imported project layer" : company.id === "bumi-hayat" ? "Catalog & showroom layer" : "Gold sales layer";
  refs.showcaseHeading.textContent = company.showcaseTitle;
  refs.showcaseBadge.textContent = company.showcaseBadge;
  refs.showcaseBoard.innerHTML = company.showcase.map((item) => `
    <article class="showcase-card ${company.id === "barakah-emas" ? "centered" : ""}">
      <strong>${item.title}</strong>
      <p>${item.text}</p>
      <div class="showcase-meta">
        ${item.meta.map((meta) => `<span class="meta-pill">${meta}</span>`).join("")}
      </div>
    </article>
  `).join("");

  refs.documentHeading.textContent = company.document.title;
  refs.documentBoard.innerHTML = company.id === "barakah-emas"
    ? renderBarakahGoldRateBoard()
    : `
      <article class="document-card ${company.id === "barakah-emas" ? "centered" : ""}">
        <strong>${company.document.title}</strong>
        <p>${company.document.text}</p>
        ${company.document.link ? `<a class="document-link" href="${company.document.link}" target="_blank" rel="noreferrer">${company.document.linkLabel}</a>` : ""}
        ${company.document.embed ? `<div class="document-frame"><iframe src="${company.document.link}#view=FitH" title="${company.document.title}"></iframe></div>` : ""}
      </article>
    `;
}

function renderWorkflow() {
  const company = activeCompany();
  refs.workflowGrid.innerHTML = company.workflow.map((item) => `
    <article class="workflow-card">
      <strong>${item.title}</strong>
      <p>${item.text}</p>
      <ul>${item.bullets.map((bullet) => `<li>${bullet}</li>`).join("")}</ul>
    </article>
  `).join("");
}

function renderInputPlan() {
  const company = activeCompany();
  refs.inputPlan.innerHTML = `
    <article class="plan-card">
      <strong>Lead mode</strong>
      <p>Sistem auto banyakkan benda supaya staff tak kena key-in panjang.</p>
      <ul>
        ${company.leadPlan.auto.map((item) => `<li>Auto: ${item}</li>`).join("")}
        ${company.leadPlan.staff.map((item) => `<li>Staff isi: ${item}</li>`).join("")}
      </ul>
    </article>
    <article class="plan-card">
      <strong>Order mode</strong>
      <p>Order capture hanya fokus benda yang memang kritikal untuk close dan audit.</p>
      <ul>
        ${company.orderPlan.auto.map((item) => `<li>Auto: ${item}</li>`).join("")}
        ${company.orderPlan.staff.map((item) => `<li>Staff isi: ${item}</li>`).join("")}
      </ul>
    </article>
  `;
}

function matchesPeriod(value, period = "daily", offset = 0) {
  if (!value) return false;
  if (period === "daily") {
    const target = isoOffset(-offset);
    return value === target;
  }

  const valueDate = toDate(value);
  const now = new Date();

  if (period === "weekly") {
    const end = new Date(now);
    end.setDate(end.getDate() - (offset * 7));
    const start = new Date(end);
    start.setDate(start.getDate() - 6);
    return valueDate >= toDate(localIsoDate(start)) && valueDate <= toDate(localIsoDate(end));
  }

  const anchor = new Date(now.getFullYear(), now.getMonth() - offset, 1);
  const targetYear = anchor.getFullYear();
  const targetMonth = anchor.getMonth() + 1;
  const [year, month] = String(value).split("-").map(Number);
  return year === targetYear && month === targetMonth;
}

function filterRecordsByNamedPeriod(records, period = "daily", offset = 0) {
  return records.filter((record) => matchesPeriod(recordDateKey(record), period, offset));
}

function filterCampaignsByNamedPeriod(campaigns, period = "daily", offset = 0) {
  return campaigns.filter((campaign) => matchesPeriod(campaign.createdAt, period, offset));
}

function periodTitle(period = "daily") {
  if (period === "weekly") return "Weekly";
  if (period === "monthly") return "Monthly";
  return "Daily";
}

function recordsForPeriod(records) {
  return filterRecordsByNamedPeriod(records, state.period, 0);
}

function renderStaffBoard() {
  const company = activeCompany();
  const records = recordsForPeriod(companyRecords());
  const staffNames = activeProfile().role === "staff" ? [activeProfile().staffName] : company.staff;
  const staffStats = staffNames.map((staffName) => {
    const items = records.filter((record) => record.staff === staffName);
    const leads = items.filter((record) => record.kind === "lead");
    const orders = activeOrders(items);
    const closed = items.filter(isClosed);
    const sales = closed.reduce((sum, item) => sum + Number(item.value || 0), 0);
    return {
      staffName,
      leads: leads.length,
      bluetick: items.filter((item) => item.status === "Bluetick").length,
      open: items.filter(isOpen).length,
      closed: closed.length,
      orders: orders.length,
      sales
    };
  }).sort((a, b) => b.sales - a.sales || b.closed - a.closed || b.leads - a.leads);

  const maxSales = Math.max(...staffStats.map((item) => item.sales), 1);
  refs.staffBoard.innerHTML = staffStats.map((item) => `
    <article class="staff-card">
      <div class="staff-card-top">
        <div>
          <strong>${item.staffName}</strong>
          <p>${state.period.charAt(0).toUpperCase() + state.period.slice(1)} performance</p>
        </div>
        <span class="panel-badge">${formatCurrency(item.sales)}</span>
      </div>
      <div class="staff-grid">
        <div class="mini-stat"><span>Leads</span><strong>${formatNumber(item.leads)}</strong></div>
        <div class="mini-stat"><span>Bluetick</span><strong>${formatNumber(item.bluetick)}</strong></div>
        <div class="mini-stat"><span>Open</span><strong>${formatNumber(item.open)}</strong></div>
        <div class="mini-stat"><span>Closed</span><strong>${formatNumber(item.closed)}</strong></div>
        <div class="mini-stat"><span>Orders</span><strong>${formatNumber(item.orders)}</strong></div>
        <div class="mini-stat"><span>Sales</span><strong>${formatCurrency(item.sales)}</strong></div>
      </div>
      <div class="bar-track"><div class="bar-fill" style="width:${Math.max(6, Math.round((item.sales / maxSales) * 100))}%"></div></div>
    </article>
  `).join("");
}

function renderMarketingBoard() {
  const records = companyRecords();
  const campaigns = companyCampaigns();
  refs.marketingBoard.innerHTML = campaigns.length ? campaigns.map((campaign) => {
    const campaignRecords = records.filter((record) => record.campaignId === campaign.id);
    const leadCount = campaignRecords.filter((record) => record.kind === "lead").length;
    const closedSales = campaignRecords.filter(isClosed).reduce((sum, item) => sum + Number(item.value || 0), 0);
    const cpl = leadCount ? Number(campaign.spend || 0) / leadCount : 0;
    return `
      <article class="marketing-card">
        <div class="marketing-head">
          <div>
            <strong>${campaign.name}</strong>
            <p>${campaign.platform}</p>
          </div>
          <span class="panel-badge">${formatCurrency(campaign.spend)}</span>
        </div>
        <div class="marketing-meta">
          <span class="meta-pill">${formatNumber(leadCount)} leads</span>
          <span class="meta-pill">CPL ${formatCurrency(cpl)}</span>
          <span class="meta-pill">Closed ${formatCurrency(closedSales)}</span>
        </div>
        <div class="bar-track"><div class="bar-fill" style="width:${Math.max(8, Math.min(100, leadCount * 14))}%"></div></div>
      </article>
    `;
  }).join("") : `<div class="empty-state">Belum ada campaign untuk company ini.</div>`;
}

function automationQueues() {
  const company = activeCompany();
  const records = companyRecords();
  return {
    bluetick: records.filter((record) => record.status === "Bluetick" && daysBetween(recordDateKey(record)) >= 30),
    followUp: records.filter((record) => isOpen(record) && record.nextFollowUp && record.nextFollowUp <= todayIso()),
    company
  };
}

function renderAutomationBoard() {
  const { bluetick, followUp, company } = automationQueues();
  const blastRecord = bluetick[0];
  const followRecord = followUp[0];

  refs.automationBoard.innerHTML = `
    <article class="automation-card">
      <div class="automation-head">
        <div>
          <strong>Monthly blast queue</strong>
          <p>Bluetick lebih 30 hari tanpa reply.</p>
        </div>
        <span class="panel-badge">${formatNumber(bluetick.length)}</span>
      </div>
      <div class="automation-meta">
        <span class="meta-pill">WhatsApp Business no-API</span>
        <span class="meta-pill">Script generated</span>
      </div>
      ${blastRecord ? `<button class="ghost-button" data-wa-id="${blastRecord.id}" data-wa-type="blast" type="button">Open first blast</button>` : `<div class="empty-state">Tiada blast due sekarang.</div>`}
    </article>
    <article class="automation-card">
      <div class="automation-head">
        <div>
          <strong>14-day follow-up</strong>
          <p>Lead atau order yang perlu disentuh semula hari ini.</p>
        </div>
        <span class="panel-badge">${formatNumber(followUp.length)}</span>
      </div>
      ${followRecord ? `<button class="ghost-button" data-wa-id="${followRecord.id}" data-wa-type="followup" type="button">Open first follow-up</button>` : `<div class="empty-state">Tiada follow-up due sekarang.</div>`}
    </article>
    <article class="automation-card">
      <div class="automation-head">
        <div>
          <strong>Night reply 12am-6am</strong>
          <p>${company.nightBotMessage}</p>
        </div>
      </div>
      <div class="automation-meta">
        <span class="meta-pill">Reply script ready</span>
        <span class="meta-pill">Auto-send perlukan API</span>
      </div>
    </article>
  `;
}

function renderOrderBoard() {
  const company = activeCompany();
  const orders = recordsForPeriod(activeOrders(companyRecords()));
  if (company.id === "bumi-hayat") {
    renderBumiHayatOrderBoard(orders);
    return;
  }
  if (company.id === "barakah-emas") {
    renderBarakahOrderBoard(orders);
    return;
  }
  const byProduct = company.products.map((product) => {
    const items = orders.filter((record) => record.product === product);
    return {
      product,
      count: items.length,
      value: items.reduce((sum, item) => sum + Number(item.value || 0), 0),
      units: items.reduce((sum, item) => sum + Number(item.units || 0), 0)
    };
  }).filter((item) => item.count > 0).sort((a, b) => b.value - a.value || b.count - a.count);

  refs.orderBoard.innerHTML = byProduct.length ? byProduct.map((item) => `
    <article class="order-card">
      <div class="order-head">
        <div>
          <strong>${item.product}</strong>
          <p>${formatNumber(item.count)} order / closed record</p>
        </div>
        <span class="panel-badge">${formatCurrency(item.value)}</span>
      </div>
      <div class="order-meta">
        <span class="meta-pill">${formatNumber(item.units)} ${company.id === "barakah-emas" ? "g" : company.id === "salam-land" ? "lot" : "pcs"}</span>
        <span class="meta-pill">${state.period} window</span>
      </div>
    </article>
  `).join("") : `<div class="empty-state">Belum ada order dalam tempoh ${state.period}.</div>`;
}

function renderBumiHayatOrderBoard(orders) {
  const buckets = BH_PRODUCTS.map((product) => {
    const items = orders.filter((record) => record.product === product || record.details?.product === product);
    const quantity = items.reduce((sum, record) => sum + numeric(record.details?.quantity || record.units), 0);
    const quote = items.reduce((sum, record) => sum + numeric(record.details?.quoteAmount || record.value), 0);
    const deposit = items.reduce((sum, record) => sum + numeric(record.details?.totalPaid || record.details?.designDeposit || 0) + numeric(record.details?.depositAmount || 0) + numeric(record.details?.finalPaymentAmount || 0), 0);
    const production = items.reduce((map, record) => {
      const status = record.details?.productionStatus || record.status || "Open";
      map.set(status, (map.get(status) || 0) + 1);
      return map;
    }, new Map());
    return { product, items, quantity, quote, deposit, production };
  }).filter((item) => item.items.length).sort((a, b) => b.quote - a.quote || b.quantity - a.quantity);

  refs.orderBoard.innerHTML = buckets.length ? buckets.map((item) => `
    <article class="order-card company-order-card">
      <div class="order-head">
        <div>
          <strong>${escapeHtml(item.product)}</strong>
          <p>${formatNumber(item.items.length)} order / ${formatNumber(item.quantity)} pcs</p>
        </div>
        <span class="panel-badge">${formatCurrency(item.quote)}</span>
      </div>
      <div class="company-order-grid">
        <div class="mini-stat"><span>Quantity</span><strong>${formatNumber(item.quantity)} pcs</strong></div>
        <div class="mini-stat"><span>Payment collected</span><strong>${formatCurrency(item.deposit)}</strong></div>
        <div class="mini-stat"><span>Balance</span><strong>${formatCurrency(Math.max(0, item.quote - item.deposit))}</strong></div>
      </div>
      <div class="order-meta">
        ${Array.from(item.production.entries()).slice(0, 4).map(([status, count]) => `<span class="meta-pill">${escapeHtml(status)} ${formatNumber(count)}</span>`).join("")}
      </div>
    </article>
  `).join("") : `<div class="empty-state">Belum ada order Bumi Hayat dalam tempoh ${state.period}.</div>`;
}

function renderBarakahOrderBoard(orders) {
  const buckets = ["Beli dengan kita", "Jual kepada kita", "Trade-in", "Survey harga"].map((transactionType) => {
    const items = orders.filter((record) => (record.details?.transactionType || "Survey harga") === transactionType);
    const grams = items.reduce((sum, record) => sum + numeric(record.details?.grams || record.units), 0);
    const value = items.reduce((sum, record) => sum + dashboardOrderValue(record), 0);
    const products = Array.from(items.reduce((map, record) => {
      const product = record.details?.product || record.product || "Emas";
      map.set(product, (map.get(product) || 0) + 1);
      return map;
    }, new Map()).entries()).sort((a, b) => b[1] - a[1]);
    return { transactionType, items, grams, value, products };
  }).filter((item) => item.items.length).sort((a, b) => b.value - a.value || b.grams - a.grams);

  refs.orderBoard.innerHTML = buckets.length ? buckets.map((item) => `
    <article class="order-card company-order-card gold-order-card">
      <div class="order-head">
        <div>
          <strong>${escapeHtml(item.transactionType)}</strong>
          <p>${formatNumber(item.items.length)} transaksi / ${formatNumber(item.grams)}g</p>
        </div>
        <span class="panel-badge">${formatCurrency(item.value)}</span>
      </div>
      <div class="company-order-grid">
        <div class="mini-stat"><span>Total gram</span><strong>${formatNumber(item.grams)}g</strong></div>
        <div class="mini-stat"><span>Avg RM/g</span><strong>${item.grams ? formatCurrency(item.value / item.grams) : "RM 0"}</strong></div>
        <div class="mini-stat"><span>Records</span><strong>${formatNumber(item.items.length)}</strong></div>
      </div>
      <div class="order-meta">
        ${item.products.slice(0, 4).map(([product, count]) => `<span class="meta-pill">${escapeHtml(product)} ${formatNumber(count)}</span>`).join("")}
      </div>
    </article>
  `).join("") : `<div class="empty-state">Belum ada transaksi Barakah Emas dalam tempoh ${state.period}.</div>`;
}

function renderStatusFilter() {
  const company = activeCompany();
  refs.statusFilter.innerHTML = [`<option value="all">Semua status</option>`, ...company.statuses.map((status) => `<option value="${status}">${status}</option>`)].join("");
  refs.statusFilter.value = company.statuses.includes(state.statusFilter) ? state.statusFilter : "all";
  state.statusFilter = refs.statusFilter.value;
}

function renderStaffFilter() {
  const company = activeCompany();
  const options = [{ value: "all", label: "Semua staff" }];
  if (activeProfile().role === "staff") {
    options.push({ value: activeProfile().staffName, label: activeProfile().staffName });
    state.staffFilter = activeProfile().staffName;
  } else {
    options.push(...company.staff.map((staff) => ({ value: staff, label: staff })));
  }
  fillSelect(refs.staffFilter, options, options.some((option) => option.value === state.staffFilter) ? state.staffFilter : options[0].value);
  state.staffFilter = refs.staffFilter.value;
}

function renderSourceFilter() {
  const sources = Array.from(new Set(companyRecords().map((record) => record.source))).sort();
  fillSelect(refs.sourceFilter, [{ value: "all", label: "Semua source" }, ...sources.map((source) => ({ value: source, label: source }))], sources.includes(state.sourceFilter) ? state.sourceFilter : "all");
  state.sourceFilter = refs.sourceFilter.value;
}

function reminderBuckets(records = companyRecords()) {
  const aheadWindow = Number(state.control.settings.reminderAheadDays || 7);
  return {
    overdue: records.filter((record) => isOpen(record) && record.nextFollowUp && record.nextFollowUp < todayIso()),
    dueToday: records.filter((record) => isOpen(record) && record.nextFollowUp === todayIso()),
    upcoming: records.filter((record) => isOpen(record) && record.nextFollowUp && record.nextFollowUp > todayIso() && daysBetween(todayIso(), record.nextFollowUp) <= aheadWindow),
    staleBluetick: records.filter((record) => record.status === "Bluetick" && daysBetween(recordDateKey(record)) >= 14)
  };
}

function duplicateLeadCount(companyId = state.activeCompanyId) {
  const counts = new Map();
  companyRecords(companyId)
    .filter((record) => record.kind === "lead")
    .forEach((record) => {
      const phone = normalizePhone(record.phone);
      if (!phone) return;
      counts.set(phone, (counts.get(phone) || 0) + 1);
    });
  return Array.from(counts.values()).filter((count) => count > 1).length;
}

function renderAccessBoard() {
  const profile = activeProfile();
  const companyList = visibleCompanies().map((company) => company.name).join(", ");
  const settings = state.control.settings;
  const backupLabel = state.control.lastBackupAt ? localDateTimeLabel(new Date(state.control.lastBackupAt)) : "Belum ada backup auto";

  refs.accessBoard.innerHTML = `
    <article class="access-card">
      <div class="access-head">
        <div>
          <strong>${profile.name}</strong>
          <p>${profile.title}</p>
        </div>
        <span class="panel-badge">${roleLabel(profile.role)}</span>
      </div>
      <div class="access-meta">
        <span class="meta-pill">${hasGlobalAccess(profile) ? "Semua company" : companyList}</span>
        ${profile.staffName ? `<span class="meta-pill">${profile.staffName}</span>` : `<span class="meta-pill">${profile.role === "company" ? "Company scope" : "Management scope"}</span>`}
      </div>
      <p>${profile.note}</p>
      <button class="ghost-button" data-open-control="true" type="button">Open control centre</button>
    </article>
    <article class="access-card">
      <strong>Ops settings</strong>
      <div class="access-stats">
        <div class="mini-stat"><span>Dedupe</span><strong>${formatNumber(settings.dedupeWindowDays)} hari</strong></div>
        <div class="mini-stat"><span>Follow-up</span><strong>+${formatNumber(settings.defaultFollowUpDays)} hari</strong></div>
        <div class="mini-stat"><span>Reminder</span><strong>${formatNumber(settings.reminderAheadDays)} hari</strong></div>
        <div class="mini-stat"><span>Backup</span><strong>${settings.autoBackupEnabled ? "Auto on" : "Manual"}</strong></div>
      </div>
      <div class="access-meta">
        <span class="meta-pill">Last backup ${backupLabel}</span>
        <span class="meta-pill">Retention ${formatNumber(settings.backupRetentionDays)} hari</span>
      </div>
    </article>
    <article class="access-card">
      <strong>Data shield</strong>
      <div class="access-stats">
        <div class="mini-stat"><span>Duplicate lead</span><strong>${formatNumber(duplicateLeadCount())}</strong></div>
        <div class="mini-stat"><span>Error log</span><strong>${formatNumber(state.control.errors.length)}</strong></div>
        <div class="mini-stat"><span>Activity log</span><strong>${formatNumber(state.control.activity.length)}</strong></div>
      </div>
      <p>Layer ini bantu jaga kualiti data, role access, dan jejak tindakan harian untuk setiap company.</p>
    </article>
  `;
}

function renderControlBoard() {
  const reminders = reminderBuckets();
  const activity = (accessLocked() ? [] : state.control.activity)
    .filter((item) => !item.companyId || item.companyId === state.activeCompanyId)
    .slice(0, 5);
  const errors = accessLocked() ? [] : state.control.errors.slice(0, 3);

  refs.controlBoard.innerHTML = `
    <article class="control-card">
      <div class="control-head">
        <strong>Reminder queue</strong>
        <span class="panel-badge">${formatNumber(reminders.overdue.length + reminders.dueToday.length)}</span>
      </div>
      <div class="access-stats">
        <div class="mini-stat"><span>Overdue</span><strong>${formatNumber(reminders.overdue.length)}</strong></div>
        <div class="mini-stat"><span>Due today</span><strong>${formatNumber(reminders.dueToday.length)}</strong></div>
        <div class="mini-stat"><span>Upcoming</span><strong>${formatNumber(reminders.upcoming.length)}</strong></div>
        <div class="mini-stat"><span>Bluetick 14+</span><strong>${formatNumber(reminders.staleBluetick.length)}</strong></div>
      </div>
      <div class="activity-list">
        ${[...reminders.overdue, ...reminders.dueToday].slice(0, 4).map((record) => `
          <div class="activity-item">
            <strong>${record.customerName}</strong>
            <span>${record.staff} • ${record.status} • ${record.nextFollowUp || "-"}</span>
          </div>
        `).join("") || `<div class="empty-state">Tiada reminder kritikal untuk company ini.</div>`}
      </div>
    </article>
    <article class="control-card">
      <div class="control-head">
        <strong>Recent activity</strong>
        <span class="meta-pill">${formatNumber(activity.length)} latest</span>
      </div>
      <div class="activity-list">
        ${activity.map((item) => `
          <div class="activity-item">
            <strong>${item.action}</strong>
            <span>${item.actor} • ${localDateTimeLabel(new Date(item.at))}</span>
            <p>${item.detail || "-"}</p>
          </div>
        `).join("") || `<div class="empty-state">Activity log akan muncul selepas ada simpanan atau perubahan baru.</div>`}
      </div>
    </article>
    <article class="control-card">
      <div class="control-head">
        <strong>Error watch</strong>
        <span class="meta-pill">${state.control.errors.length ? "Perlu semak" : "Clean"}</span>
      </div>
      <div class="activity-list">
        ${errors.map((item) => `
          <div class="activity-item warning">
            <strong>${item.message}</strong>
            <span>${localDateTimeLabel(new Date(item.at))}</span>
          </div>
        `).join("") || `<div class="empty-state">Belum ada error log untuk sesi ini.</div>`}
      </div>
    </article>
  `;
}

function monthDays(monthValue) {
  const [year, month] = String(monthValue || currentMonthValue()).split("-").map(Number);
  const totalDays = new Date(year, month, 0).getDate();
  return Array.from({ length: totalDays }, (_, index) => {
    const day = index + 1;
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  });
}

function ensureLeadDateFilters() {
  const fallbackMonth = currentMonthValue();
  if (!/^\d{4}-\d{2}$/.test(String(state.leadMonthFilter || ""))) {
    state.leadMonthFilter = fallbackMonth;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(state.leadDateFilter || ""))) {
    state.leadDateFilter = `${state.leadMonthFilter}-01`;
  }
  if (!state.leadDateFilter.startsWith(state.leadMonthFilter)) {
    state.leadDateFilter = state.leadMonthFilter === fallbackMonth ? todayIso() : `${state.leadMonthFilter}-01`;
  }
}

function sourceBreakdown(records) {
  return records.reduce((counts, record) => {
    const source = record.source || "Unknown";
    counts[source] = (counts[source] || 0) + 1;
    return counts;
  }, {});
}

function statusCount(records, statuses = []) {
  return records.filter((record) => statuses.includes(record.status)).length;
}

function applySelectedDateRecordFilter(actionFilter = "all") {
  state.kindFilter = "lead";
  state.dateFilter = "selected";
  state.actionFilter = actionFilter;
  refs.kindFilter.value = state.kindFilter;
  refs.dateFilter.value = state.dateFilter;
  if (refs.actionFilter) refs.actionFilter.value = state.actionFilter;
  renderRecordTable();
  document.querySelector("#recordTable")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderDateDrilldown() {
  if (!refs.leadMonthInput || !refs.leadDateInput || !refs.leadDateSummary || !refs.leadCalendarGrid || !refs.leadDateBreakdown) return;
  ensureLeadDateFilters();
  refs.leadMonthInput.value = state.leadMonthFilter;
  refs.leadDateInput.value = state.leadDateFilter;

  const company = activeCompany();
  const records = companyRecords()
    .filter((record) => record.kind === "lead")
    .filter((record) => state.staffFilter === "all" || record.staff === state.staffFilter);
  const days = monthDays(state.leadMonthFilter);
  const monthLeads = records.filter((record) => recordDateKey(record).startsWith(state.leadMonthFilter));
  const selectedLeads = records.filter((record) => recordDateKey(record) === state.leadDateFilter);
  const selectedOpen = selectedLeads.filter(isOpen);
  const selectedWsPending = selectedLeads.filter((record) => !normalizeActionFlags(record.actionFlags, record).wsSent);
  const selectedSources = sourceBreakdown(selectedLeads);
  const selectedReply = selectedLeads.filter((record) => normalizeActionFlags(record.actionFlags, record).reply);
  const selectedSiteVisit = statusCount(selectedLeads, ["Site Visit"]);
  const selectedBookingClosed = selectedLeads.filter((record) => ["Booking", "Deposit", "Closed"].includes(record.status));
  const firstDay = new Date(`${days[0]}T00:00:00`).getDay();
  const calendarOffset = (firstDay + 6) % 7;
  const countByDate = monthLeads.reduce((counts, record) => {
    const date = recordDateKey(record);
    counts[date] = (counts[date] || 0) + 1;
    return counts;
  }, {});
  const weekdayLabels = ["Isn", "Sel", "Rab", "Kha", "Jum", "Sab", "Ahd"];

  refs.leadDateSummary.innerHTML = [
    ["Lead tarikh dipilih", formatNumber(selectedLeads.length), prettyDate(state.leadDateFilter)],
    ["Lead bulan ini", formatNumber(monthLeads.length), prettyMonth(state.leadMonthFilter)],
    ["Belum WS", formatNumber(selectedWsPending.length), "Perlu first touch"],
    ["Masih open", formatNumber(selectedOpen.length), "Belum closed / lost"]
  ].map(([label, value, note]) => `
    <article class="metric-card compact-card">
      <span>${label}</span>
      <strong>${value}</strong>
      <p>${note}</p>
    </article>
  `).join("");

  refs.leadCalendarGrid.innerHTML = [
    ...weekdayLabels.map((label) => `<div class="calendar-weekday">${label}</div>`),
    ...Array.from({ length: calendarOffset }, () => `<div class="calendar-day empty"></div>`),
    ...days.map((date) => {
      const count = countByDate[date] || 0;
      return `
        <button class="calendar-day ${date === state.leadDateFilter ? "active" : ""} ${count ? "has-leads" : ""}" type="button" data-calendar-date="${date}">
          <span>${Number(date.slice(-2))}</span>
          <strong>${formatNumber(count)}</strong>
          <small>${count === 1 ? "lead" : "leads"}</small>
        </button>
      `;
    })
  ].join("");

  const staffRows = (activeProfile().role === "staff" ? [activeProfile().staffName] : company.staff).filter(Boolean).map((staff) => {
    const staffLeads = selectedLeads.filter((record) => record.staff === staff);
    const contacted = staffLeads.filter((record) => normalizeActionFlags(record.actionFlags, record).wsSent).length;
    return `
      <div class="date-breakdown-card">
        <strong>${staff}</strong>
        <span>${formatNumber(staffLeads.length)} lead</span>
        <small>${formatNumber(contacted)} dah WS</small>
      </div>
    `;
  }).join("");

  const sourceRows = Object.entries(selectedSources).map(([source, count]) => `
    <span class="meta-pill">${source}: ${formatNumber(count)}</span>
  `).join("") || `<span class="meta-pill">Belum ada lead hari ini</span>`;

  refs.leadDateBreakdown.innerHTML = `
    <div class="date-breakdown-head">
      <div>
        <p class="eyebrow">Selected date</p>
        <h3>${prettyDate(state.leadDateFilter)}</h3>
      </div>
      <div class="showcase-meta">${sourceRows}</div>
    </div>
    <div class="date-breakdown-grid">${staffRows || `<div class="empty-state compact">Tiada staff dalam scope ini.</div>`}</div>
    <div class="date-action-grid">
      <article class="date-action-card">
        <span>Belum WhatsApp</span>
        <strong>${formatNumber(selectedWsPending.length)}</strong>
        <p>Lead yang belum ada first touch.</p>
        <button class="ghost-button" type="button" data-date-record-filter="belumWs">Tapis table</button>
      </article>
      <article class="date-action-card">
        <span>Dah reply</span>
        <strong>${formatNumber(selectedReply.length)}</strong>
        <p>Prospect yang sudah beri respons.</p>
        <button class="ghost-button" type="button" data-date-record-filter="all">Lihat semua lead tarikh ini</button>
      </article>
      <article class="date-action-card">
        <span>Site visit</span>
        <strong>${formatNumber(selectedSiteVisit)}</strong>
        <p>Lead yang bergerak ke appointment/site visit.</p>
        <button class="ghost-button" type="button" data-date-record-filter="siteVisit">Tapis site visit</button>
      </article>
      <article class="date-action-card highlight">
        <span>Booking / Closed</span>
        <strong>${formatNumber(selectedBookingClosed.length)}</strong>
        <p>Lead yang dah masuk stage sales.</p>
        <button class="primary-button" type="button" data-date-record-filter="booking">Tapis hot leads</button>
      </article>
    </div>
  `;
}

function paymentSnapshot(record) {
  const details = record.details || {};
  const gross = orderGrossValue(details, record.value || 0);
  const discount = orderDiscountValue(details, gross);
  const total = orderNetValue(details, record.value || 0);
  const designDeposit = numeric(details.designDeposit);
  const booking = numeric(details.bookingAmount);
  const deposit = numeric(details.depositAmount);
  const installment = numeric(details.installmentAmount);
  const finalPayment = numeric(details.finalPaymentAmount);
  const directPaid = numeric(details.paidAmount || details.totalPaid);
  const legacySchedule = [];

  if (!Array.isArray(details.paymentSchedule) || !details.paymentSchedule.length) {
    if (designDeposit) {
      legacySchedule.push({
        label: "Design deposit",
        amount: designDeposit,
        paymentDate: record.createdAt || todayIso(),
        method: details.paymentMethod || "",
        status: "Paid",
        paidDate: record.createdAt || todayIso(),
        reference: details.paymentReference || "",
        remark: "BH custom design deposit, carry forward to total payment"
      });
    }
    if (booking) {
      legacySchedule.push({
        label: "Booking",
        amount: booking,
        paymentDate: record.createdAt || todayIso(),
        method: details.paymentMethod || "",
        status: "Paid",
        paidDate: record.createdAt || todayIso(),
        reference: details.paymentReference || "",
        remark: "Legacy booking amount"
      });
    }
    if (deposit && deposit !== booking) {
      legacySchedule.push({
        label: "Deposit",
        amount: deposit,
        paymentDate: record.createdAt || todayIso(),
        method: details.paymentMethod || "",
        status: "Paid",
        paidDate: record.createdAt || todayIso(),
        reference: details.paymentReference || "",
        remark: "Legacy deposit amount"
      });
    }
    if (installment) {
      legacySchedule.push({
        label: "Pay 1",
        amount: installment,
        paymentDate: details.paymentDate || details.nextPaymentDate || record.createdAt || todayIso(),
        method: details.paymentMethod || "",
        status: "Paid",
        reference: "",
        remark: "Legacy installment amount"
      });
    }
    if (finalPayment) {
      legacySchedule.push({
        label: "Final payment",
        amount: finalPayment,
        paymentDate: details.paymentDate || details.nextPaymentDate || record.createdAt || todayIso(),
        method: details.paymentMethod || "",
        status: "Paid",
        reference: "",
        remark: "Full payment before pickup"
      });
    }
    if (directPaid && !legacySchedule.length) {
      legacySchedule.push({
        label: "Paid amount",
        amount: directPaid,
        paymentDate: record.createdAt || todayIso(),
        method: details.paymentMethod || "",
        status: "Paid",
        paidDate: record.createdAt || todayIso(),
        reference: details.paymentReference || "",
        remark: "Legacy paid amount"
      });
    }
  }

  const schedule = normalizePaymentSchedule(Array.isArray(details.paymentSchedule) && details.paymentSchedule.length
    ? details.paymentSchedule
    : legacySchedule);
  const summary = summarizePaymentSchedule(schedule, total);
  const fallbackPaid = directPaid || (designDeposit + booking + (deposit && deposit !== booking ? deposit : 0) + installment + finalPayment);
  const paid = schedule.length ? summary.totalPaid : fallbackPaid;
  const outstanding = schedule.length ? summary.balance : Math.max(0, total - paid);
  const status = details.paymentStatus || summary.paymentStatus || (total && outstanding <= 0 ? "Paid" : paid > 0 ? "Partial" : "Unpaid");
  return {
    gross,
    discount,
    total,
    designDeposit,
    booking,
    deposit,
    installment,
    finalPayment,
    paid,
    outstanding,
    status,
    lastPaymentDate: summary.lastPaymentDate || details.lastPaymentDate || "",
    lastPaymentLabel: summary.lastPaymentLabel || "",
    lastPaymentAmount: summary.lastPaymentAmount || 0,
    paymentCount: summary.paymentCount || 0,
    balanceDue: outstanding,
    schedule
  };
}

function paymentStatusClass(status = "") {
  const lowered = status.toLowerCase();
  if (lowered.includes("refund")) return "refunded";
  if (lowered.includes("paid") && !lowered.includes("unpaid")) return "paid";
  if (lowered.includes("partial") || lowered.includes("deposit")) return "partial";
  if (lowered.includes("due") || lowered.includes("unpaid")) return "due";
  return "pending";
}

function dashboardOrderValue(record) {
  if (record.kind !== "order") return Number(record.value || 0);
  const payment = paymentSnapshot(record);
  return Number(payment.total || record.value || 0);
}

function dashboardActivityTime(record) {
  const payment = record.kind === "order" ? paymentSnapshot(record) : null;
  return Date.parse(record.updatedAt || payment?.lastPaymentDate || record.createdAt || "") || 0;
}

function renderPaymentBoard() {
  if (!refs.paymentSummary || !refs.paymentStaffGraph || !refs.paymentBoard) return;
  const company = activeCompany();
  const visibleStaff = (state.staffFilter !== "all"
    ? [state.staffFilter]
    : activeProfile().role === "staff"
      ? [activeProfile().staffName]
      : company.staff).filter(Boolean);
  const orders = activeOrders(companyRecords())
    .filter((record) => state.staffFilter === "all" || record.staff === state.staffFilter)
    .map((record) => ({ record, payment: paymentSnapshot(record) }));
  const totalValue = orders.reduce((sum, item) => sum + item.payment.total, 0);
  const collected = orders.reduce((sum, item) => sum + item.payment.paid, 0);
  const outstanding = orders.reduce((sum, item) => sum + item.payment.outstanding, 0);
  const outstandingOrders = orders.filter((item) => item.payment.outstanding > 0).length;
  const denominator = Math.max(totalValue, 1);

  refs.paymentSummary.innerHTML = [
    ["Total order value", formatCurrency(totalValue), `${formatNumber(orders.length)} order direkodkan`],
    ["Collected", formatCurrency(collected), `${Math.round((collected / denominator) * 100)}% daripada value`],
    ["Outstanding", formatCurrency(outstanding), "Balance belum selesai"],
    ["Open balance", formatNumber(outstandingOrders), "Order masih ada balance"]
  ].map(([label, value, note]) => `
    <article class="metric-card compact-card">
      <span>${label}</span>
      <strong>${value}</strong>
      <p>${note}</p>
    </article>
  `).join("");

  refs.paymentStaffGraph.innerHTML = visibleStaff.map((staff) => {
    const staffOrders = orders.filter((item) => item.record.staff === staff);
    const staffTotal = staffOrders.reduce((sum, item) => sum + item.payment.total, 0);
    const staffCollected = staffOrders.reduce((sum, item) => sum + item.payment.paid, 0);
    const staffOutstanding = staffOrders.reduce((sum, item) => sum + item.payment.outstanding, 0);
    const percent = staffTotal ? Math.min(100, Math.round((staffCollected / staffTotal) * 100)) : 0;
    return `
      <article class="payment-staff-row">
        <div class="payment-row-head">
          <div>
            <strong>${staff}</strong>
            <span>${formatNumber(staffOrders.length)} order / ${formatCurrency(staffTotal)}</span>
          </div>
          <em>${percent}%</em>
        </div>
        <div class="payment-track"><span style="width:${percent}%"></span></div>
        <div class="payment-row-meta">
          <span>Collected ${formatCurrency(staffCollected)}</span>
          <span>Balance ${formatCurrency(staffOutstanding)}</span>
        </div>
      </article>
    `;
  }).join("") || `<div class="empty-state compact">Tiada staff dalam scope ini.</div>`;

  const sortedOrders = orders.sort((a, b) => {
    const balanceDiff = b.payment.outstanding - a.payment.outstanding;
    if (balanceDiff) return balanceDiff;
    const lastA = a.payment.lastPaymentDate || "0000-00-00";
    const lastB = b.payment.lastPaymentDate || "0000-00-00";
    if (lastA !== lastB) return lastB.localeCompare(lastA);
    return b.record.createdAt.localeCompare(a.record.createdAt);
  });

  refs.paymentBoard.innerHTML = sortedOrders.length ? sortedOrders.map(({ record, payment }) => {
    const percent = payment.total ? Math.min(100, Math.round((payment.paid / payment.total) * 100)) : 0;
    const lastPaymentLabel = payment.lastPaymentDate
      ? `${payment.lastPaymentLabel ? `${payment.lastPaymentLabel} / ` : ""}${prettyDate(payment.lastPaymentDate)}`
      : "-";
    const phasePreview = payment.schedule.slice(0, 4).map((phase) => `
      <span class="payment-phase-chip paid">${escapeHtml(phase.label)} ${formatCurrency(phase.amount)} • ${phase.paymentDate ? prettyDate(phase.paymentDate) : "no date"}</span>
    `).join("");
    return `
      <article class="payment-client-card">
        <div class="payment-row-head">
          <div>
            <strong>${record.customerName || "-"}</strong>
            <span>${record.product} / ${record.staff}</span>
          </div>
          <span class="payment-stage-pill ${paymentStatusClass(payment.status)}">${payment.status}</span>
        </div>
        <div class="payment-track"><span style="width:${percent}%"></span></div>
        <div class="payment-detail-grid">
          ${payment.discount ? `<span>Harga asal <strong>${formatCurrency(payment.gross)}</strong></span>` : ""}
          ${payment.discount ? `<span>Diskaun <strong>${formatCurrency(payment.discount)}</strong></span>` : ""}
          <span>Total <strong>${formatCurrency(payment.total)}</strong></span>
          <span>Paid <strong>${formatCurrency(payment.paid)}</strong></span>
          <span>Balance <strong>${formatCurrency(payment.outstanding)}</strong></span>
          <span>Last paid <strong>${lastPaymentLabel}</strong></span>
        </div>
        ${phasePreview ? `<div class="payment-phase-preview">${phasePreview}</div>` : ""}
        <button class="ghost-button record-edit-button" type="button" data-edit-order-id="${record.id}">Update payment</button>
      </article>
    `;
  }).join("") : `<div class="empty-state">Belum ada order untuk payment board. Bila staff save order, deposit dan balance akan masuk sini.</div>`;
}

function renderReportCenter() {
  if (!refs.reportCentreSummary || !refs.reportCentreBoard) return;
  const company = activeCompany();
  const records = companyRecords();
  const campaigns = companyCampaigns();
  const info = summary(records, campaigns);
  const teamReport = buildTeamSalesSpendReport(company.id);
  const leadSources = Array.from(records.reduce((map, record) => {
    map.set(record.source || "Unknown", (map.get(record.source || "Unknown") || 0) + 1);
    return map;
  }, new Map()).entries()).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const staffOptions = activeProfile().role === "staff"
    ? [{ value: activeProfile().staffName, label: activeProfile().staffName }]
    : [{ value: "all", label: "All team sales" }, ...company.staff.map((staffName) => ({ value: staffName, label: staffName }))];
  const reportScope = state.teamSpendReport.scope;
  const chartMax = Math.max(...teamReport.staffRows.map((row) => row.spend), ...teamReport.staffRows.map((row) => row.salesValue), 1);
  const dailySpendRows = teamReport.dailySpendRows || [];
  const activeSpendDays = new Set(dailySpendRows.filter((row) => row.totalSpend || row.adsManagerLeads).map((row) => row.date)).size;

  refs.reportCentreSummary.innerHTML = [
    ["Company scope", company.name, "Report ini tidak campur data company lain"],
    ["Ads Manager spend", formatCurrency(teamReport.adsSpend), teamReport.range.label],
    ["Ads Manager leads", formatNumber(teamReport.adsManagerLeads), "Dipisahkan daripada CRM captured"],
    ["Spend days", formatNumber(activeSpendDays), "Hari ada spend / leads ads"],
    ["CPL", formatCurrency(teamReport.cpl), "Spend / Ads Manager leads"]
  ].map(([label, value, note]) => `
    <article class="metric-card compact-card">
      <span>${label}</span>
      <strong>${value}</strong>
      <p>${note}</p>
    </article>
  `).join("");

  refs.reportCentreBoard.innerHTML = `
    <article class="report-card team-spend-report-card">
      <div class="report-card-head">
        <div>
          <strong>Team Sales Spend Report</strong>
          <p>Summary spend Ads Manager untuk ${escapeHtml(company.name)}. Report ini fokus tarikh dan spend, tanpa senarai customer/lead.</p>
        </div>
        <button class="primary-button" type="button" data-open-report-dialog>PDF report</button>
      </div>
      <div class="team-spend-controls">
        <label>
          Tempoh
          <select data-team-spend-filter="scope">
            ${[
              ["day", "Daily"],
              ["week", "Weekly"],
              ["month", "Monthly"],
              ["range", "Custom range"]
            ].map(([value, label]) => `<option value="${value}" ${reportScope === value ? "selected" : ""}>${label}</option>`).join("")}
          </select>
        </label>
        <label>
          Staff
          <select data-team-spend-filter="staff" ${activeProfile().role === "staff" ? "disabled" : ""}>
            ${staffOptions.map((option) => `<option value="${escapeAttribute(option.value)}" ${state.teamSpendReport.staff === option.value ? "selected" : ""}>${escapeHtml(option.label)}</option>`).join("")}
          </select>
        </label>
        <label ${reportScope === "month" ? "" : "hidden"}>
          Bulan
          <input data-team-spend-filter="month" type="month" value="${escapeAttribute(state.teamSpendReport.month)}">
        </label>
        <label ${reportScope === "month" ? "hidden" : ""}>
          ${reportScope === "week" ? "Week start" : reportScope === "day" ? "Tarikh" : "Tarikh mula"}
          <input data-team-spend-filter="dateFrom" type="date" value="${escapeAttribute(state.teamSpendReport.dateFrom)}">
        </label>
        <label ${reportScope === "range" ? "" : "hidden"}>
          Tarikh akhir
          <input data-team-spend-filter="dateTo" type="date" value="${escapeAttribute(state.teamSpendReport.dateTo)}">
        </label>
      </div>
      <div class="team-spend-kpis">
        ${[
          ["Spend", formatCurrency(teamReport.adsSpend), "Ads Manager"],
          ["Ads leads", formatNumber(teamReport.adsManagerLeads), "Result ads"],
          ["CRM leads", formatNumber(teamReport.crmCapturedLeads), "Captured"],
          ["CPL", formatCurrency(teamReport.cpl), "Spend / ads lead"],
          ["Booking", formatNumber(teamReport.booking), "Booking/order"],
          ["Closed", formatNumber(teamReport.closed), "Closed sales"],
          ["Sales value", formatCurrency(teamReport.salesValue), "Closed value"]
        ].map(([label, value, note]) => `
          <div class="team-spend-kpi">
            <span>${label}</span>
            <strong>${value}</strong>
            <small>${note}</small>
          </div>
        `).join("")}
      </div>
      <div class="horizontal-chart team-spend-chart">
        ${teamReport.staffRows.map((row) => `
          <div class="chart-row">
            <span>${escapeHtml(row.staffName)}</span>
            <div class="chart-track" title="Spend ${formatCurrency(row.spend)} / Sales ${formatCurrency(row.salesValue)}">
              <i style="width:${Math.max(4, Math.round((Math.max(row.spend, row.salesValue) / chartMax) * 100))}%"></i>
            </div>
            <strong>${formatCurrency(row.spend)}</strong>
          </div>
        `).join("") || `<div class="empty-state compact">Belum ada team sales dalam scope ini.</div>`}
      </div>
      <div class="report-actions-row">
        <button class="ghost-button" type="button" data-sync-team-spend>Sync Ads Manager spend</button>
        <button class="ghost-button" type="button" data-download-team-spend-daily>Download daily spend CSV</button>
      </div>
      <div class="team-spend-daily-list">
        <div class="team-spend-daily-head">
          <strong>Daily spend & Ads Manager leads</strong>
          <small>${escapeHtml(teamReport.range.label)}. Tiada senarai customer, hanya spend dan total leads ads ikut tarikh.</small>
        </div>
        <div class="team-spend-daily-table" role="table" aria-label="Daily spend">
          <span class="team-spend-daily-row is-head" role="row">
            <b>Tarikh</b>
            <b>Platform</b>
            <b>Campaign</b>
            <b>Total leads</b>
            <b>Spend</b>
          </span>
          ${dailySpendRows.map((row) => `
            <span class="team-spend-daily-row" role="row">
              <b>${prettyDate(row.date)}</b>
              <em>${escapeHtml(row.platform)}</em>
              <small>${escapeHtml(row.name)}</small>
              <em>${formatNumber(row.adsManagerLeads)}</em>
              <strong>${formatCurrency(row.totalSpend)}</strong>
            </span>
          `).join("") || `<span class="team-spend-daily-row"><b>-</b><em>-</em><small>-</small><em>0</em><strong>RM 0</strong></span>`}
        </div>
      </div>
    </article>
    <article class="report-card">
      <div class="report-card-head">
        <div>
          <strong>Export-ready PDF</strong>
          <p>Report PDF sedia ada kini boleh pilih daily, weekly, monthly atau custom date range.</p>
        </div>
        <button class="primary-button" type="button" data-open-report-dialog>Open PDF report</button>
      </div>
      <div class="report-pill-grid">
        <span class="meta-pill">Lead ${formatNumber(info.totalLeads)}</span>
        <span class="meta-pill">Order ${formatNumber(info.totalOrders)}</span>
        <span class="meta-pill">Open ${formatNumber(info.open)}</span>
        <span class="meta-pill">Due ${formatNumber(info.due)}</span>
      </div>
    </article>
    <article class="report-card">
      <div class="report-card-head">
        <div>
          <strong>Top source</strong>
          <p>Ringkasan source yang masuk untuk company aktif.</p>
        </div>
      </div>
      <div class="report-list">
        ${leadSources.map(([source, count]) => `<span><strong>${escapeHtml(source)}</strong><em>${formatNumber(count)} record</em></span>`).join("") || `<div class="empty-state compact">Belum ada source dalam scope ini.</div>`}
      </div>
    </article>
    <article class="report-card">
      <div class="report-card-head">
        <div>
          <strong>Campaign summary</strong>
          <p>Spend campaign dalam scope report tanpa maklumat customer.</p>
        </div>
      </div>
      <div class="report-list">
        ${teamReport.campaigns.slice(0, 6).map((item) => `
          <span>
            <strong>${escapeHtml(item.name || item.platform)}</strong>
            <em>${prettyDate(item.reportDate)} / ${formatCurrency(item.spend)}</em>
          </span>
        `).join("") || `<div class="empty-state compact">Belum ada campaign spend dalam scope ini.</div>`}
      </div>
    </article>
  `;
}

function downloadTeamSpendDailySpend() {
  const report = buildTeamSalesSpendReport();
  const rows = [
    ["Tarikh", "Platform", "Nama kempen", "Total leads", "Spend"],
    ...report.dailySpendRows.map((row) => [
      prettyDate(row.date),
      row.platform,
      row.name,
      row.adsManagerLeads,
      row.totalSpend
    ])
  ];
  const csv = rows.map((row) => row.map(csvCell).join(",")).join("\n");
  const filenameStaff = report.staffFilter === "all" ? "all-staff" : slugify(report.staffFilter);
  const filename = `team-sales-daily-spend-${report.company.id}-${filenameStaff}-${report.range.dateFrom}-${report.range.dateTo}.csv`;
  downloadBlob(new Blob([csv], { type: "text/csv;charset=utf-8" }), filename);
}

function filteredRecords() {
  const query = state.search.trim().toLowerCase();
  return companyRecords()
    .filter((record) => state.kindFilter === "all" || record.kind === state.kindFilter)
    .filter((record) => state.statusFilter === "all" || record.status === state.statusFilter)
    .filter((record) => state.staffFilter === "all" || record.staff === state.staffFilter)
    .filter((record) => state.sourceFilter === "all" || record.source === state.sourceFilter)
    .filter((record) => matchesActionFilter(record, state.actionFilter))
    .filter((record) => {
      const date = recordDateKey(record);
      return state.dateFilter === "all"
        || (state.dateFilter === "today" && date === todayIso())
        || (state.dateFilter === "yesterday" && date === isoOffset(-1))
        || (state.dateFilter === "selected" && date === state.leadDateFilter)
        || (state.dateFilter === "week" && daysBetween(date) <= 7)
        || (state.dateFilter === "month" && daysBetween(date) <= 31);
    })
    .filter((record) => {
      if (!query) return true;
      return [
        record.customerName,
        record.phone,
        record.product,
        record.staff,
        record.status,
        recordSummary(record),
        record.notes || ""
      ].join(" ").toLowerCase().includes(query);
    })
    .sort((a, b) => recordDateKey(b).localeCompare(recordDateKey(a)));
}

function matchesActionFilter(record, filter = "all") {
  const flags = normalizeActionFlags(record.actionFlags, record);
  if (filter === "all") return true;
  if (filter === "newToday") return record.kind === "lead" && recordDateKey(record) === todayIso();
  if (filter === "belumWs") return record.kind === "lead" && isOpen(record) && !flags.wsSent;
  if (filter === "followUpDue") return isOpen(record) && record.nextFollowUp && record.nextFollowUp <= todayIso();
  if (filter === "noReply") return record.kind === "lead" && flags.wsSent && !flags.reply && !flags.closed && !flags.rejected;
  if (filter === "siteVisit") return flags.siteVisit || record.status === "Site Visit";
  if (filter === "booking") return flags.booking || record.status === "Booking";
  if (filter === "closed") return flags.closed || isClosed(record);
  return true;
}

function filteredSalamLotEntries() {
  const query = state.lotSearch.trim().toLowerCase();
  return buildSalamLotBoardEntries()
    .filter((entry) => state.lotStatusFilter === "all" || entry.status === state.lotStatusFilter)
    .filter((entry) => {
      if (!query) return true;
      return [
        entry.lotNo,
        entry.project,
        entry.location,
        entry.customerName,
        entry.staff,
        entry.status,
        entry.buyerSegment,
        entry.source
      ].join(" ").toLowerCase().includes(query);
    });
}

function renderSalamLotBoard() {
  if (!refs.lotStatusShell || !refs.lotStatusBoard || !refs.lotStatusMetrics || !refs.lotStatusLegend || !refs.lotStatusDeck) return;
  const isSalam = activeCompany().id === "salam-land" && !accessLocked();
  refs.lotStatusShell.hidden = !isSalam;
  if (!isSalam) return;

  const entries = buildSalamLotBoardEntries();
  const filtered = filteredSalamLotEntries();
  const totalLots = entries.length;
  const availableCount = entries.filter((entry) => entry.status === "Available").length;
  const reservedCount = entries.filter((entry) => entry.status === "Reserved").length;
  const bookingCount = entries.filter((entry) => entry.status === "Booking").length;
  const closedCount = entries.filter((entry) => entry.status === "Closed").length;

  refs.lotStatusSummary.textContent = `Cari cepat masa dekat tapak. ${formatNumber(totalLots)} lot dalam board, ${formatNumber(bookingCount)} booking dan ${formatNumber(closedCount)} closed sedang dipantau live. Klik tile lot untuk fokus terus pada satu unit.`;
  refs.lotStatusMetrics.innerHTML = [
    ["Total lots", formatNumber(totalLots), "Semua lot yang sedang dipantau"],
    ["Available", formatNumber(availableCount), "Masih boleh offer dekat buyer"],
    ["Reserved", formatNumber(reservedCount), "Masuk qualify / site visit"],
    ["Booking / Closed", `${formatNumber(bookingCount)} / ${formatNumber(closedCount)}`, "Lot yang dah dipegang atau sold"]
  ].map(([label, value, note]) => `
    <article class="metric-card lot-metric-card">
      <span>${label}</span>
      <strong>${value}</strong>
      <p>${note}</p>
    </article>
  `).join("");

  refs.lotStatusLegend.innerHTML = SALAM_LOT_STATUSES.map((status) => `
    <div class="lot-legend-pill ${slugify(status)}">
      <span class="lot-legend-dot"></span>
      <strong>${status}</strong>
      <span>${salamLotStatusDescription(status)}</span>
    </div>
  `).join("");

  refs.lotStatusDeck.innerHTML = SALAM_LOT_STATUSES.map((status) => {
    const laneEntries = entries.filter((entry) => entry.status === status);
    return `
      <article class="lot-lane ${slugify(status)}">
        <div class="lot-lane-head">
          <div>
            <strong>${status}</strong>
            <p>${salamLotStatusDescription(status)}</p>
          </div>
          <span>${formatNumber(laneEntries.length)}</span>
        </div>
        <div class="lot-lane-track">
          ${laneEntries.length ? laneEntries.map((entry) => `
            <button
              class="lot-tile ${slugify(entry.status)} ${state.lotFocusLotNo === entry.lotNo ? "active" : ""}"
              type="button"
              data-lot-tile="${entry.lotNo}"
              aria-label="Focus lot ${entry.lotNo}"
            >
              <div class="lot-tile-top">
                <strong>${escapeHtml(entry.lotNo)}</strong>
                <span>${escapeHtml(lotProjectCode(entry.project))}</span>
              </div>
              <small class="lot-tile-land">${escapeHtml(entry.project || "Project belum dipilih")}</small>
              ${entry.customerName ? `<small class="lot-tile-customer">${escapeHtml(entry.customerName)}</small>` : ""}
              <span class="lot-staff-chip">${entry.staff ? `Team sales: ${escapeHtml(entry.staff)}` : "Belum assign team sales"}</span>
              <em>${entry.price ? formatCurrency(entry.price) : "Harga pending"}</em>
            </button>
          `).join("") : `<div class="empty-state compact">Belum ada lot dalam lane ini.</div>`}
        </div>
      </article>
    `;
  }).join("");

  refs.lotStatusBoard.innerHTML = filtered.length ? filtered.map((entry) => `
    <article class="lot-card lot-card--${slugify(entry.status)} ${state.lotFocusLotNo === entry.lotNo ? "lot-card--focused" : ""}">
      <div class="lot-card-top">
        <div>
          <strong>${entry.lotNo}</strong>
          <p>${escapeHtml(entry.project || "Project belum dipilih")}</p>
        </div>
        <span class="lot-status-badge ${slugify(entry.status)}">${entry.status}</span>
      </div>
      <div class="lot-meta">
        <span class="meta-pill">Project: ${escapeHtml(entry.project)}</span>
        <span class="meta-pill">Team: ${escapeHtml(entry.staff || "Belum assign team sales")}</span>
        <span class="meta-pill">${escapeHtml(entry.buyerSegment)}</span>
        <span class="meta-pill">${entry.price ? formatCurrency(entry.price) : "Harga pending"}</span>
      </div>
      <div class="lot-detail-grid">
        <div class="lot-detail">
          <span>Customer</span>
          <strong>${escapeHtml(entry.customerName || "-")}</strong>
        </div>
        <div class="lot-detail">
          <span>Team sales</span>
          <strong>${escapeHtml(entry.staff || "-")}</strong>
        </div>
        <div class="lot-detail">
          <span>Booking</span>
          <strong>${entry.bookingAmount ? formatCurrency(entry.bookingAmount) : "-"}</strong>
        </div>
        <div class="lot-detail">
          <span>Closed value</span>
          <strong>${entry.closedValue ? formatCurrency(entry.closedValue) : "-"}</strong>
        </div>
      </div>
      <div class="lot-card-bottom">
        <span>${entry.source || "Belum ada source live"}</span>
        <span>${entry.nextFollowUp ? `Follow-up ${entry.nextFollowUp}` : (entry.createdAt ? `Updated ${entry.createdAt}` : "Belum ada aktiviti")}</span>
      </div>
      <p class="lot-card-note">${entry.notes || "Status lot akan berubah automatik bila team update record ke Booking atau Closed."}</p>
      <div class="lot-actions">
        <button class="ghost-button" type="button" data-lot-detail="${entry.lotNo}">View detail</button>
        <button class="ghost-button" type="button" data-lot-action="booking" data-lot-no="${entry.lotNo}">${salamLotActionLabels(entry).booking}</button>
        <button class="primary-button" type="button" data-lot-action="closed" data-lot-no="${entry.lotNo}">${salamLotActionLabels(entry).close}</button>
      </div>
    </article>
  `).join("") : `<div class="empty-state">Tiada lot jumpa untuk carian atau filter semasa.</div>`;
  bindSalamLotBoardButtons();
}

function renderRecordTable() {
  const records = filteredRecords();
  refs.recordTable.innerHTML = records.length ? records.map((record) => {
    const dates = actionDateMeta(record);
    return `
      <tr>
        <td>
          <div class="stack">
            <strong>${record.customerName || "-"}</strong>
            <span>${record.phone || "-"}</span>
            <span>${record.kind === "lead" ? "Lead" : "Order"} / ${dates.leadDate}</span>
            ${record.attachments?.length ? `<span>${record.attachments.length} lampiran</span>` : ""}
          </div>
        </td>
        <td>
          <div class="stack">
            <strong>${record.product}</strong>
            <span>${recordSummary(record)}</span>
          </div>
        </td>
        <td>
          <div class="stack">
            <strong>${record.source}</strong>
            <span>${campaignName(record.campaignId)}</span>
          </div>
        </td>
        <td>${record.staff}</td>
        <td>${renderStatusControl(record)}</td>
        <td>
          <div class="stack">
            <strong>${formatCurrency(record.value || 0)}</strong>
            <span>${formatNumber(record.units || 0)}</span>
          </div>
        </td>
        <td>
          <div class="stack date-stack">
            <strong>${dates.nextDate || "-"}</strong>
            <span>Lead date ${dates.leadDate}</span>
            ${dates.fourteenDayDate ? `<span>14-day ${dates.fourteenDayDate}</span>` : ""}
            <span>${record.notes || "-"}</span>
            ${record.details?.paymentStatus ? `<span>Payment ${record.details.paymentStatus}</span>` : ""}
          </div>
        </td>
        <td>${renderLeadActionTicks(record)}</td>
      </tr>
    `;
  }).join("") : `<tr><td colspan="8"><div class="empty-state">Tiada rekod untuk filter semasa.</div></td></tr>`;
}

function render() {
  ensureAccessibleActiveCompany();
  applyTheme();
  syncAuthLayer();
  syncActionAccess();
  renderCompanyRail();
  renderSectionNav();
  renderSidebarPanels();
  renderTopbarStatus();
  renderHero();
  renderFlowArchitecture();
  renderMetrics();
  renderDashboardAnalytics();
  renderSystemBoard();
  renderIntegrationBoard();
  renderWhatsAppApiBoard();
  renderShowcase();
  renderWorkflow();
  renderInputPlan();
  renderStaffBoard();
  renderMarketingBoard();
  renderAutomationBoard();
  renderOrderBoard();
  renderReportCenter();
  renderStatusFilter();
  renderStaffFilter();
  renderSourceFilter();
  renderPaymentBoard();
  renderDateDrilldown();
  renderSalamLotBoard();
  renderAccessBoard();
  renderControlBoard();
  renderRecordTable();
  applyActiveSectionVisibility();
  queueSectionSync();
}

function fillSelect(element, options, selected = "") {
  element.innerHTML = options.map((option) => {
    const value = typeof option === "string" ? option : option.value;
    const label = typeof option === "string" ? option : option.label;
    return `<option value="${value}" ${value === selected ? "selected" : ""}>${label}</option>`;
  }).join("");
}

function renderDynamicFields(fields, container) {
  container.innerHTML = fields.map((field) => {
    const fullClass = field.full ? "full-field" : "";
    if (field.type === "select") {
      const options = Array.isArray(field.options) ? field.options : [];
      return `
        <label class="${fullClass}" data-detail-field="${field.name}">
          ${field.label}
          <select name="detail:${field.name}" ${field.required ? "required" : ""}>
            ${field.placeholder ? `<option value="">${field.placeholder}</option>` : ""}
            ${options.map((option) => `<option value="${escapeAttribute(option)}">${escapeHtml(option)}</option>`).join("")}
          </select>
        </label>
      `;
    }
    return `
      <label class="${fullClass}" data-detail-field="${field.name}">
        ${field.label}
        <input name="detail:${field.name}" type="${field.type}" placeholder="${field.placeholder || ""}" ${field.required ? "required" : ""}>
      </label>
    `;
  }).join("");
}

function syncOrderFormLayout(company) {
  if (!refs.orderForm) return;
  const hiddenForSalam = new Set(["status", "value", "paymentStatus", "paidAmount", "paymentReference"]);
  refs.orderForm.querySelectorAll("[data-order-field]").forEach((field) => {
    const fieldName = field.dataset.orderField;
    const shouldHide = company.id === "salam-land" && hiddenForSalam.has(fieldName);
    field.classList.toggle("order-field-hidden", shouldHide);
  });

  const unitsLabel = refs.orderForm.querySelector('[data-order-field="units"]');
  if (unitsLabel) {
    const input = unitsLabel.querySelector("input");
    unitsLabel.childNodes[0].textContent = company.id === "salam-land" ? "Kuantiti lot" : "Quantity / unit";
    if (input) input.placeholder = company.id === "salam-land" ? "Contoh: 1" : "";
  }

  const paymentMethodLabel = refs.orderForm.querySelector('[data-order-field="paymentMethod"]');
  if (paymentMethodLabel) {
    paymentMethodLabel.classList.toggle("order-field-emphasis", company.id === "salam-land");
  }

  if (company.id === "salam-land") {
    refs.orderStatusInput.value = "Booking";
    if (refs.orderForm.elements.value) refs.orderForm.elements.value.value = "";
    const paymentStatus = refs.orderForm.elements["detail:paymentStatus"];
    const paidAmount = refs.orderForm.elements["detail:paidAmount"];
    const paymentReference = refs.orderForm.elements["detail:paymentReference"];
    if (paymentStatus) paymentStatus.value = "Unpaid";
    if (paidAmount) paidAmount.value = "";
    if (paymentReference) paymentReference.value = "";
  }

  if (company.id === "bumi-hayat") {
    const orderType = refs.orderQuickFields.querySelector('[name="detail:orderType"]');
    const designDeposit = refs.orderQuickFields.querySelector('[name="detail:designDeposit"]');
    const depositAmount = refs.orderQuickFields.querySelector('[name="detail:depositAmount"]');
    const finalPaymentAmount = refs.orderQuickFields.querySelector('[name="detail:finalPaymentAmount"]');
    if (orderType && !orderType.value) orderType.value = "Custom";
    if (designDeposit) {
      designDeposit.placeholder = "Custom design: RM100, carry forward";
    }
    if (depositAmount) depositAmount.placeholder = "50% selepas design submit";
    if (finalPaymentAmount) finalPaymentAmount.placeholder = "Baki full sebelum pickup/ambil baju";
  }

  const cameraCard = refs.orderForm.querySelector(".order-camera-card");
  if (cameraCard) {
    cameraCard.hidden = company.id !== "salam-land";
  }
}

function orderAttachmentFiles() {
  return [
    ...Array.from(refs.orderIcFrontInput?.files || []),
    ...Array.from(refs.orderIcBackInput?.files || []),
    ...Array.from(refs.orderFilesInput?.files || [])
  ];
}

function suggestedBarakahRate(productName = "") {
  if (String(productName).includes("999")) return state.goldRates.gram999;
  if (String(productName).includes("916")) return state.goldRates.gram916;
  return 0;
}

function syncBarakahOrderRate() {
  if (refs.orderCompanyInput.value !== "barakah-emas") return;
  const detailProduct = refs.orderQuickFields.querySelector('[name="detail:product"]');
  const priceInput = refs.orderQuickFields.querySelector('[name="detail:pricePerGram"]');
  if (!priceInput) return;

  const selectedProduct = detailProduct?.value || refs.orderProductInput.value || "";
  const rate = suggestedBarakahRate(selectedProduct);
  priceInput.placeholder = rate ? `Auto cadangan ${Number(rate).toFixed(2)}` : "Akan ikut rate semasa";
  if (!priceInput.value && rate) {
    priceInput.value = Number(rate).toFixed(2);
  }
}

function syncSalamLotSelection({ onlyEmpty = false } = {}) {
  if (refs.orderCompanyInput.value !== "salam-land") return;
  const lotField = refs.orderQuickFields.querySelector('[name="detail:lotNo"]');
  if (!lotField?.value) return;
  const canonicalLot = canonicalSalamLotNo(lotField.value);
  if (canonicalLot && lotField.value !== canonicalLot) lotField.value = canonicalLot;
  const entry = salamLotCatalogEntry(canonicalLot);
  if (!entry) return;

  const projectField = refs.orderQuickFields.querySelector('[name="detail:projectLocation"]');
  const priceField = refs.orderQuickFields.querySelector('[name="detail:landPrice"]');
  const buyerField = refs.orderQuickFields.querySelector('[name="detail:buyerSegment"]');
  const projectLabel = cleanSalamProjectLabel(entry.project)
    || inferSalamProjectLabel(entry.lotNo, entry.project, entry.location)
    || cleanSalamProjectLabel(entry.location);
  const projectOption = SALAM_PROJECT_OPTIONS.includes(projectLabel)
    ? projectLabel
    : (inferSalamProjectLabel(entry.lotNo, entry.project, entry.location) || projectLabel);

  if (projectField && (!onlyEmpty || !projectField.value) && projectOption) {
    setNamedFieldValue(refs.orderQuickFields, "detail:projectLocation", projectOption);
  }
  if (priceField && (!onlyEmpty || !priceField.value) && entry.price) {
    priceField.value = String(entry.price);
  }
  if (buyerField && (!onlyEmpty || !buyerField.value) && entry.buyerSegment) {
    setNamedFieldValue(refs.orderQuickFields, "detail:buyerSegment", entry.buyerSegment === "Mixed" ? "Tidak pasti" : entry.buyerSegment);
  }

  const productName = normalizeSalamProductName(refs.orderProductInput.value, entry.lotNo, entry.project, entry.location);
  if (refs.orderProductInput && (!onlyEmpty || !refs.orderProductInput.value)) {
    refs.orderProductInput.value = productName;
  }
}

function renderLeadDuplicateState() {
  const companyId = refs.leadCompanyInput.value;
  const phone = refs.leadPhoneInput.value;
  const duplicates = recentDuplicates(companyId, phone);
  if (!phone.trim()) {
    refs.leadDuplicateState.innerHTML = `<div class="empty-state">Masukkan phone untuk semak duplicate lead secara automatik.</div>`;
    return;
  }

  if (!duplicates.length) {
    refs.leadDuplicateState.innerHTML = `<div class="ok-state">Tiada duplicate dikesan dalam ${formatNumber(state.control.settings.dedupeWindowDays)} hari.</div>`;
    return;
  }

  refs.leadDuplicateState.innerHTML = `
    <div class="warning-state">Jumpa ${formatNumber(duplicates.length)} lead lama dengan nombor sama.</div>
    <div class="activity-list">
      ${duplicates.slice(0, 3).map((record) => `
        <div class="activity-item warning">
          <strong>${record.customerName}</strong>
          <span>${record.staff} • ${record.status} • ${prettyDate(recordDateKey(record))}</span>
          <p>${record.product} • ${record.notes || "-"}</p>
        </div>
      `).join("")}
    </div>
  `;
}

function updateLeadForm() {
  const company = companyById(refs.leadCompanyInput.value);
  const profile = activeProfile();
  const availableStaff = profile.role === "staff" && profile.companyId === company.id ? [profile.staffName] : company.staff;
  fillSelect(refs.leadStaffInput, availableStaff, availableStaff[0]);
  fillSelect(refs.leadSourceInput, SOURCE_OPTIONS);
  fillSelect(refs.leadCampaignInput, [{ value: "", label: "Organic / no campaign" }, ...companyCampaigns(company.id).map((item) => ({ value: item.id, label: `${item.platform}: ${item.name}` }))]);
  fillSelect(refs.leadProductInput, company.products, company.defaultLeadProduct);
  fillSelect(refs.leadStatusInput, company.statuses, "New Lead");
  refs.leadQuickTitle.textContent = `${company.name} lead essentials`;
  renderDynamicFields(company.leadFields, refs.leadQuickFields);
  renderLeadDuplicateState();
}

function updateOrderForm() {
  const company = companyById(refs.orderCompanyInput.value);
  const profile = activeProfile();
  const availableStaff = profile.role === "staff" && profile.companyId === company.id ? [profile.staffName] : company.staff;
  const orderStatuses = company.closedStatuses.concat(company.statuses.filter((status) => !company.closedStatuses.includes(status)));
  const defaultOrderStatus = company.id === "salam-land" ? "Booking" : company.closedStatuses[0];
  fillSelect(refs.orderStaffInput, availableStaff, availableStaff[0]);
  fillSelect(refs.orderProductInput, company.products, company.defaultLeadProduct);
  fillSelect(refs.orderStatusInput, orderStatuses, defaultOrderStatus);
  refs.orderQuickTitle.textContent = `${company.name} order essentials`;
  const orderFields = company.id === "salam-land"
    ? company.orderFields.map((field) => (field.name === "lotNo" ? { ...field, options: salamLotOptions() } : field))
    : company.orderFields;
  renderDynamicFields(orderFields, refs.orderQuickFields);
  syncOrderFormLayout(company);
  const detailProduct = refs.orderQuickFields.querySelector('[name="detail:product"]');
  if (detailProduct) {
    detailProduct.value = refs.orderProductInput.value;
  }
  syncBarakahOrderRate();
}

function setNamedFieldValue(container, name, value) {
  if (!container) return;
  const field = container.querySelector(`[name="${name}"]`);
  if (!field || value === undefined || value === null) return;
  const nextValue = name === "detail:lotNo"
    ? canonicalSalamLotNo(value)
    : (["detail:projectLocation", "detail:location"].includes(name) ? cleanSalamProjectLabel(value) : String(value));
  if (field.tagName === "SELECT" && nextValue && !Array.from(field.options).some((option) => option.value === nextValue)) {
    field.append(new Option(nextValue, nextValue));
  }
  field.value = nextValue;
}

function applyOrderPrefill(prefill = {}) {
  if (!prefill || !refs.orderForm) return;
  const isEdit = Boolean(prefill.id);
  refs.orderRecordIdInput.value = isEdit ? prefill.id : "";
  if (refs.orderDialogTitle) refs.orderDialogTitle.textContent = isEdit ? "Edit order" : "Add order";
  document.querySelector("#saveOrderButton").textContent = isEdit ? "Update order" : "Save order";
  if (prefill.customerName) refs.orderForm.elements.customerName.value = prefill.customerName;
  if (prefill.phone) refs.orderForm.elements.phone.value = prefill.phone;
  if (prefill.product) refs.orderProductInput.value = prefill.product;
  if (prefill.status) refs.orderStatusInput.value = prefill.status;
  if (prefill.staff && Array.from(refs.orderStaffInput.options).some((option) => option.value === prefill.staff)) {
    refs.orderStaffInput.value = prefill.staff;
  }
  if (prefill.value !== undefined) refs.orderForm.elements.value.value = String(prefill.value || "");
  if (prefill.units !== undefined) refs.orderForm.elements.units.value = String(prefill.units || "");

  const detailSource = prefill.details || {};
  Object.entries(detailSource).forEach(([key, value]) => {
    setNamedFieldValue(refs.orderForm, `detail:${key}`, value);
    setNamedFieldValue(refs.orderQuickFields, `detail:${key}`, value);
  });
  syncSalamLotSelection({ onlyEmpty: true });

  if (prefill.notes) {
    refs.orderForm.elements.notes.value = cleanOrderNoteText(prefill.notes);
  }
  const schedule = Array.isArray(detailSource.paymentSchedule) && detailSource.paymentSchedule.length
    ? detailSource.paymentSchedule
    : (isEdit ? paymentSnapshot(prefill).schedule : []);
  if (!detailSource.paymentMethod && schedule[0]?.method) {
    setNamedFieldValue(refs.orderForm, "detail:paymentMethod", schedule[0].method);
  }
  renderPaymentScheduleRows(schedule);
  checkCurrentOrderDuplicate();
}

function lotOrderDraft(entry, actionType = "booking") {
  const company = activeCompany();
  const status = actionType === "closed" ? "Closed" : "Booking";
  const paymentStatus = actionType === "closed" ? "Paid" : (entry.bookingAmount ? "Deposit" : "Unpaid");
  const bookingAmount = entry.bookingAmount || "";
  const normalizedBuyerSegment = entry.buyerSegment === "Non-Bumi" ? "Non-Bumi" : "Bumi";
  const paidAmount = actionType === "closed"
    ? (entry.closedValue || entry.price || 0)
    : (entry.bookingAmount || 0);

  return {
    companyId: "salam-land",
    customerName: entry.customerName || "",
    phone: entry.phone || "",
    product: entry.product || company.defaultLeadProduct,
    status,
    staff: entry.staff || company.staff[0],
    value: actionType === "closed" ? (entry.closedValue || entry.price || 0) : (entry.price || entry.closedValue || 0),
    units: 1,
    details: {
      lotNo: entry.lotNo,
      projectLocation: entry.project || entry.location || "",
      location: entry.location || entry.project || "",
      landPrice: entry.price || entry.closedValue || 0,
      bookingAmount,
      buyerSegment: normalizedBuyerSegment,
      paymentStatus,
      paidAmount,
      systemNote: actionType === "closed" ? "Lot board close shortcut" : "Lot board booking shortcut"
    },
    notes: entry.notes || ""
  };
}

function openLeadDialog() {
  refs.leadForm.reset();
  fillSelect(refs.leadCompanyInput, visibleCompanies().map((company) => ({ value: company.id, label: company.name })), state.activeCompanyId);
  updateLeadForm();
  refs.leadForm.elements.nextFollowUp.value = isoOffset(Number(state.control.settings.defaultFollowUpDays || 1));
  refs.leadAllowDuplicateInput.checked = false;
  refs.leadDialog.showModal();
}

function openOrderDialog(prefill = null) {
  refs.orderForm.reset();
  refs.orderRecordIdInput.value = "";
  if (refs.orderDialogTitle) refs.orderDialogTitle.textContent = "Add order";
  document.querySelector("#saveOrderButton").textContent = "Save order";
  if (refs.paymentSchedulePasteInput) refs.paymentSchedulePasteInput.value = "";
  const companyId = prefill?.companyId || state.activeCompanyId;
  fillSelect(refs.orderCompanyInput, visibleCompanies().map((company) => ({ value: company.id, label: company.name })), companyId);
  updateOrderForm();
  renderPaymentScheduleRows([]);
  renderOrderDuplicateState(null);
  applyOrderPrefill(prefill);
  refs.orderDialog.showModal();
}

function openOrderEditor(recordId) {
  const record = state.records.find((item) => item.id === recordId && item.kind === "order");
  if (!record || !canEditRecord(record)) return;
  openOrderDialog(record);
}

function updateControlDialogPreview() {
  const profile = state.control.profiles.find((item) => item.id === refs.controlProfileInput.value) || state.control.profiles[0];
  refs.controlQuickTitle.textContent = `${profile.name} / ${profile.title}`;
  refs.controlPreview.innerHTML = `
    <div class="preview-row">
      <span>Access scope</span>
      <code>${hasGlobalAccess(profile) ? "Semua company" : profile.companyIds.map((companyId) => companyById(companyId)?.name || companyId).join(", ")}</code>
    </div>
    <div class="preview-row">
      <span>Staff lens</span>
      <code>${profile.staffName || (profile.role === "company" ? "Company access" : "Management / owner view")}</code>
    </div>
    <div class="preview-row">
      <span>Ops rules</span>
      <code>Dedupe ${refs.controlDedupeDaysInput.value || "-"} hari • Follow-up +${refs.controlFollowUpDaysInput.value || "-"} hari • Reminder ${refs.controlReminderDaysInput.value || "-"} hari</code>
    </div>
  `;
}

function openControlDialog() {
  refs.controlForm.reset();
  const hasManagementAccess = !state.runtime.backendReady || hasGlobalAccess(state.session.user);
  const profileOptions = hasManagementAccess
    ? state.control.profiles.map((profile) => ({ value: profile.id, label: `${profile.name} • ${profile.title}` }))
    : state.control.profiles
      .filter((profile) => profile.id === state.session.user?.profileId)
      .map((profile) => ({ value: profile.id, label: `${profile.name} • ${profile.title}` }));
  fillSelect(refs.controlProfileInput, profileOptions, hasManagementAccess ? state.control.activeProfileId : state.session.user?.profileId);
  refs.controlProfileInput.disabled = !hasManagementAccess;
  refs.controlFollowUpDaysInput.value = state.control.settings.defaultFollowUpDays;
  refs.controlDedupeDaysInput.value = state.control.settings.dedupeWindowDays;
  refs.controlReminderDaysInput.value = state.control.settings.reminderAheadDays;
  refs.controlAutoBackupInput.value = String(Boolean(state.control.settings.autoBackupEnabled));
  refs.controlBackupRetentionInput.value = state.control.settings.backupRetentionDays;
  updateControlDialogPreview();
  refs.controlDialog.showModal();
}

function openCampaignDialog() {
  refs.campaignForm.reset();
  fillSelect(refs.campaignCompanyInput, visibleCompanies().map((company) => ({ value: company.id, label: company.name })), state.activeCompanyId);
  refs.campaignDialog.showModal();
}

function fillIntegrationConnectionFields(companyId) {
  const company = companyById(companyId);
  const connection = activeConnection(company.id);
  fillSelect(refs.integrationMetaCampaignInput, campaignOptionsForCompany(company.id), connection.metaCampaignId || "");
  fillSelect(refs.integrationMetaStaffInput, company.staff, connection.metaDefaultStaff || company.staff[0]);
  fillSelect(refs.integrationMetaStatusInput, company.statuses, connection.metaLeadStatus || "New Lead");
  fillSelect(refs.integrationTikTokCampaignInput, campaignOptionsForCompany(company.id), connection.tiktokCampaignId || "");
  fillSelect(refs.integrationTikTokStaffInput, company.staff, connection.tiktokDefaultStaff || company.staff[0]);
  fillSelect(refs.integrationTikTokStatusInput, company.statuses, connection.tiktokLeadStatus || "New Lead");

  refs.integrationMetaEnabledInput.value = String(Boolean(connection.metaEnabled));
  refs.integrationMetaPageIdInput.value = connection.metaPageId || "";
  refs.integrationMetaAdAccountIdInput.value = connection.metaAdAccountId || "";
  refs.integrationMetaFormIdsInput.value = connection.metaFormIds || "";
  refs.integrationMetaSpendSyncInput.value = String(Boolean(connection.metaSpendSyncEnabled));
  refs.integrationMetaAccessTokenInput.value = connection.metaAccessToken || "";
  refs.integrationMetaSpendAccessTokenInput.value = connection.metaSpendAccessToken || "";
  refs.integrationTikTokEnabledInput.value = String(Boolean(connection.tiktokEnabled));
  refs.integrationTikTokAdvertiserIdInput.value = connection.tiktokAdvertiserId || "";
  refs.integrationTikTokFormIdsInput.value = connection.tiktokFormIds || "";
  refs.integrationTikTokSpendSyncInput.value = String(Boolean(connection.tiktokSpendSyncEnabled));
  refs.integrationTikTokLeadModeInput.value = connection.tiktokLeadMode || "instant-form";
  refs.integrationTikTokCallbackTokenInput.value = connection.tiktokCallbackToken || state.integrations.tiktok.callbackToken || "";
  refs.integrationTikTokAccessTokenInput.value = connection.tiktokAccessToken || "";
  refs.integrationNotesInput.value = connection.notes || "";
}

function updateIntegrationForm() {
  const company = companyById(refs.integrationCompanyInput.value);
  const draftBaseUrl = String(refs.integrationBaseUrlInput.value || "").trim();
  const baseUrl = draftBaseUrl ? draftBaseUrl.replace(/\/+$/, "") : currentBaseUrl();

  refs.integrationQuickTitle.textContent = `${company.name} webhook & publish map`;
  refs.metaWebhookPreview.textContent = `${baseUrl}/api/webhooks/meta`;
  refs.tiktokWebhookPreview.textContent = `${baseUrl}/api/webhooks/tiktok`;
  refs.storageModePreview.textContent = state.runtime.backendReady ? "Server mode active" : "Browser mode preview";
  refs.integrationHint.textContent = state.runtime.backendReady
    ? "Server mode aktif. Credentials dan mapping akan disimpan dalam backend supaya production lebih selamat."
    : "Sekarang masih browser mode. Untuk live webhook dan simpan token secara lebih proper, publish menggunakan `node server.js` di domain HTTPS.";
}

function openIntegrationDialog() {
  refs.integrationForm.reset();
  fillSelect(refs.integrationCompanyInput, visibleCompanies().map((company) => ({ value: company.id, label: company.name })), state.activeCompanyId);
  const company = activeCompany();

  refs.integrationBaseUrlInput.value = state.integrations.publicBaseUrl || "";
  refs.integrationMetaVerifyTokenInput.value = state.integrations.meta.verifyToken || "";
  refs.integrationMetaApiVersionInput.value = state.integrations.meta.apiVersion || "v22.0";
  fillIntegrationConnectionFields(company.id);
  updateIntegrationForm();
  refs.integrationDialog.showModal();
}

function updateReportForm() {
  const company = companyById(refs.reportCompanyInput.value);
  const isStaffProfile = activeProfile().role === "staff";
  const staffOptions = isStaffProfile
    ? [{ value: activeProfile().staffName, label: activeProfile().staffName }]
    : [{ value: "all", label: "Semua staff / team sales" }, ...company.staff.map((staff) => ({ value: staff, label: staff }))];
  const selectedStaff = isStaffProfile
    ? activeProfile().staffName
    : company.staff.includes(refs.reportStaffInput.value) ? refs.reportStaffInput.value : "all";
  fillSelect(refs.reportStaffInput, staffOptions, selectedStaff);
  refs.reportStaffInput.disabled = isStaffProfile;

  const scope = refs.reportScopeInput.value || "month";
  const useMonth = scope === "month";
  const useRange = scope === "range";
  refs.reportMonthWrap.hidden = !useMonth;
  refs.reportDateFromWrap.hidden = useMonth;
  refs.reportDateToWrap.hidden = !useRange;
  refs.reportMonthInput.required = useMonth;
  refs.reportDateFromInput.required = !useMonth;
  refs.reportDateToInput.required = useRange;

  const monthValue = refs.reportMonthInput.value || currentMonthValue();
  const dateFrom = refs.reportDateFromInput.value || todayIso();
  const dateTo = refs.reportDateToInput.value || todayIso();
  const staffLabel = refs.reportStaffInput.value === "all" ? "Semua staff / team sales" : refs.reportStaffInput.value;

  refs.reportQuickTitle.textContent = `${company.name} / ${staffLabel}`;
  refs.reportHint.textContent = useMonth
    ? `PDF akan export spend report dari 1 hingga hujung bulan ${prettyMonth(monthValue)} tanpa senarai customer/lead.`
    : scope === "day"
      ? `PDF akan export daily spend report untuk ${prettyDate(dateFrom)}.`
      : scope === "week"
        ? `PDF akan export weekly spend report dari ${prettyDate(dateFrom)} hingga ${prettyDate(isoOffsetFromDate(dateFrom, 6))}.`
        : `PDF akan export spend report dari ${prettyDate(dateFrom)} hingga ${prettyDate(dateTo)}.`;
}

function openReportDialog() {
  refs.reportForm.reset();
  fillSelect(refs.reportCompanyInput, visibleCompanies().map((company) => ({ value: company.id, label: company.name })), state.activeCompanyId);
  refs.reportCompanyInput.disabled = activeProfile().role === "staff";
  refs.reportScopeInput.value = "month";
  refs.reportMonthInput.value = currentMonthValue();
  refs.reportDateFromInput.value = isoOffset(-7);
  refs.reportDateToInput.value = todayIso();
  updateReportForm();
  refs.reportDialog.showModal();
}

function sourceSummary(records) {
  return Array.from(records.reduce((map, record) => {
    map.set(record.source, (map.get(record.source) || 0) + 1);
    return map;
  }, new Map()).entries()).sort((a, b) => b[1] - a[1]);
}

function nonNegativeNumberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function explicitAdsManagerLeads(campaign = {}) {
  const candidates = [
    campaign.adsManagerLeads,
    campaign.adsManagerLeadCount,
    campaign.adsLeads,
    campaign.leadCount,
    campaign.leads,
    campaign.results,
    campaign.resultCount,
    campaign.insights?.leads,
    campaign.insights?.results
  ];
  for (const value of candidates) {
    if (value === "" || value === null || value === undefined) continue;
    const number = nonNegativeNumberOrNull(value);
    if (number !== null) return number;
  }
  return null;
}

function campaignStaffHint(campaign = {}, company = activeCompany()) {
  const directStaff = String(campaign.staff || campaign.staffName || campaign.teamSales || "").trim();
  if (company.staff.includes(directStaff)) return directStaff;
  const haystack = `${campaign.name || ""} ${campaign.externalCampaignId || ""} ${campaign.externalAdId || ""}`.toLowerCase();
  return company.staff.find((staffName) => haystack.includes(staffName.toLowerCase())) || "";
}

function isAdsRecord(record = {}) {
  const source = String(record.source || "").toLowerCase();
  const platform = String(record.details?.externalPlatform || "").toLowerCase();
  return source.includes("ads") || ["meta", "tiktok", "google"].includes(platform);
}

function maskPhoneNumber(phone = "") {
  const digits = normalizePhone(phone);
  if (!digits) return "-";
  if (digits.length <= 6) return `${digits.slice(0, 2)}***`;
  return `${digits.slice(0, 4)}***${digits.slice(-3)}`;
}

function csvCell(value = "") {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

function campaignAdsManagerLeads(campaign, linkedLeads, staffFilter, company) {
  const explicit = explicitAdsManagerLeads(campaign);
  const hintedStaff = campaignStaffHint(campaign, company);
  if (explicit !== null && (staffFilter === "all" || hintedStaff === staffFilter)) return explicit;
  return linkedLeads.length;
}

function recordDateKey(record = {}) {
  return recordSourceDate(record);
}

function adCampaignNameFromRecord(record = {}) {
  const details = record.details || {};
  return String(
    details.metaCampaignName
    || details.tiktokCampaignName
    || details.campaign_name
    || details.campaignName
    || details.ad_name
    || details.adName
    || record.product
    || "Ads campaign"
  ).trim();
}

function mergeDailyInsightsWithLeadFallback(campaign = {}, linkedLeads = []) {
  const rowsByDate = new Map();
  const addInsightRow = (row = {}) => {
    const date = String(row.date || row.date_start || row.dateStart || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    const existing = rowsByDate.get(date) || {
      date,
      spend: 0,
      adsManagerLeads: 0,
      crmFallbackLeads: 0
    };
    existing.spend += Number(row.spend || 0);
    existing.adsManagerLeads += Number(row.adsManagerLeads || row.leads || row.results || 0);
    rowsByDate.set(date, existing);
  };

  (Array.isArray(campaign.dailyInsights) ? campaign.dailyInsights : []).forEach(addInsightRow);

  linkedLeads.forEach((record) => {
    const date = recordDateKey(record);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    const existing = rowsByDate.get(date) || {
      date,
      spend: 0,
      adsManagerLeads: 0,
      crmFallbackLeads: 0
    };
    existing.crmFallbackLeads += 1;
    rowsByDate.set(date, existing);
  });

  return Array.from(rowsByDate.values())
    .map((row) => ({
      date: row.date,
      spend: Number(row.spend || 0),
      adsManagerLeads: Number(row.adsManagerLeads || row.crmFallbackLeads || 0)
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function buildSyntheticCampaignRowsFromAdLeads(adLeads = [], company = activeCompany(), staffFilter = "all") {
  const grouped = new Map();
  adLeads.forEach((record) => {
    const staffName = normalizeStaffName(record.companyId, record.staff, record) || record.staff || "";
    if (staffFilter !== "all" && staffName !== staffFilter) return;
    const sourceText = String(record.source || record.details?.externalPlatform || "Ads");
    const platform = sourceText.toLowerCase().includes("tiktok")
      ? "TikTok Ads"
      : sourceText.toLowerCase().includes("meta")
        ? "Meta Ads"
        : sourceText;
    const campaignName = adCampaignNameFromRecord(record);
    const key = [platform, campaignName, staffName || "Mixed"].join("::");
    if (!grouped.has(key)) {
      grouped.set(key, {
        id: `synthetic-${key.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`,
        companyId: company.id,
        platform,
        name: campaignName,
        spend: 0,
        adsManagerLeads: 0,
        crmCapturedLeads: 0,
        staffName: staffName || "Mixed",
        createdAt: recordDateKey(record) || todayIso(),
        reportDate: recordDateKey(record) || todayIso(),
        dailyInsights: [],
        linkedLeads: []
      });
    }
    const item = grouped.get(key);
    item.linkedLeads.push(record);
    item.crmCapturedLeads += 1;
    if (recordDateKey(record) && recordDateKey(record) < item.reportDate) item.reportDate = recordDateKey(record);
  });

  return Array.from(grouped.values()).map((campaign) => ({
    ...campaign,
    adsManagerLeads: campaign.linkedLeads.length,
    dailyInsights: mergeDailyInsightsWithLeadFallback(campaign, campaign.linkedLeads),
    cpl: 0
  }));
}

function spendBucketForPlatform(platform = "") {
  const normalized = String(platform).toLowerCase();
  if (normalized.includes("meta") || normalized.includes("facebook")) return "metaSpend";
  if (normalized.includes("tiktok")) return "tiktokSpend";
  if (normalized.includes("google")) return "googleSpend";
  return "otherSpend";
}

function buildDailySpendRows(campaigns, dateFrom, dateTo) {
  const dates = dateRangeList(dateFrom, dateTo);
  const rowsByDate = new Map(dates.map((date) => [date, []]));

  campaigns.forEach((campaign) => {
    const dailyInsights = Array.isArray(campaign.dailyInsights) ? campaign.dailyInsights : [];
    const insightRows = dailyInsights.length
      ? dailyInsights.map((insight) => ({
        date: String(insight.date || insight.date_start || insight.dateStart || "").slice(0, 10),
        spend: Number(insight.spend || 0),
        adsManagerLeads: Number(insight.adsManagerLeads || insight.leads || 0)
      }))
      : [{
        date: campaign.reportDate || campaignReportDate(campaign),
        spend: Number(campaign.spend || 0),
        adsManagerLeads: Number(campaign.adsManagerLeads || 0)
      }];

    insightRows.forEach((insight) => {
      const targetRows = rowsByDate.get(insight.date);
      if (!targetRows) return;
      const spend = Number(insight.spend || 0);
      const adsLeads = Number(insight.adsManagerLeads || 0);
      const bucket = spendBucketForPlatform(campaign.platform);
      if (!spend && !adsLeads) return;
      targetRows.push({
        date: insight.date,
        platform: campaign.platform || "-",
        name: campaign.name || "Unnamed campaign",
        adsManagerLeads: adsLeads,
        metaSpend: bucket === "metaSpend" ? spend : 0,
        tiktokSpend: bucket === "tiktokSpend" ? spend : 0,
        googleSpend: bucket === "googleSpend" ? spend : 0,
        otherSpend: bucket === "otherSpend" ? spend : 0,
        totalSpend: spend,
        spend,
        campaignCount: 1
      });
    });
  });

  return dates.flatMap((date) => {
    const rows = rowsByDate.get(date) || [];
    if (!rows.length) {
      return [{
        date,
        platform: "-",
        name: "Tiada campaign spend direkodkan",
        adsManagerLeads: 0,
        metaSpend: 0,
        tiktokSpend: 0,
        googleSpend: 0,
        otherSpend: 0,
        totalSpend: 0,
        spend: 0,
        campaignCount: 0
      }];
    }
    const aggregatedRows = Array.from(rows.reduce((map, row) => {
      const key = [row.date, row.platform || "-", row.name || "-"].join("::");
      const existing = map.get(key) || {
        ...row,
        adsManagerLeads: 0,
        metaSpend: 0,
        tiktokSpend: 0,
        googleSpend: 0,
        otherSpend: 0,
        totalSpend: 0,
        spend: 0,
        campaignCount: 0
      };
      existing.adsManagerLeads += Number(row.adsManagerLeads || 0);
      existing.metaSpend += Number(row.metaSpend || 0);
      existing.tiktokSpend += Number(row.tiktokSpend || 0);
      existing.googleSpend += Number(row.googleSpend || 0);
      existing.otherSpend += Number(row.otherSpend || 0);
      existing.totalSpend += Number(row.totalSpend || 0);
      existing.spend += Number(row.spend || 0);
      existing.campaignCount += Number(row.campaignCount || 0);
      map.set(key, existing);
      return map;
    }, new Map()).values());
    return aggregatedRows.sort((a, b) => String(a.platform || "").localeCompare(String(b.platform || "")) || String(a.name || "").localeCompare(String(b.name || "")));
  });
}

function ensureTeamSpendReportState(company = activeCompany()) {
  const report = state.teamSpendReport || {};
  const profile = activeProfile();
  const validStaff = profile.role === "staff"
    ? profile.staffName
    : company.staff.includes(report.staff) ? report.staff : "all";
  state.teamSpendReport = {
    scope: ["day", "week", "month", "range"].includes(report.scope) ? report.scope : "month",
    month: /^\d{4}-\d{2}$/.test(String(report.month || "")) ? report.month : currentMonthValue(),
    dateFrom: /^\d{4}-\d{2}-\d{2}$/.test(String(report.dateFrom || "")) ? report.dateFrom : todayIso(),
    dateTo: /^\d{4}-\d{2}-\d{2}$/.test(String(report.dateTo || "")) ? report.dateTo : todayIso(),
    staff: validStaff,
    showDetails: Boolean(report.showDetails)
  };
}

function buildTeamSalesSpendReport(companyId = state.activeCompanyId) {
  const company = companyById(companyId);
  ensureTeamSpendReportState(company);
  const profile = activeProfile();
  const requestedStaff = profile.role === "staff" ? profile.staffName : state.teamSpendReport.staff;
  const range = resolveReportRange(
    state.teamSpendReport.scope,
    state.teamSpendReport.month,
    state.teamSpendReport.dateFrom,
    state.teamSpendReport.dateTo
  );
  const scopedRecords = recordsInRange(companyRecords(companyId), range.dateFrom, range.dateTo)
    .filter((record) => requestedStaff === "all" || record.staff === requestedStaff);
  const linkedCampaignIds = new Set(scopedRecords.map((record) => record.campaignId).filter(Boolean));
  const scopedCampaigns = companyCampaigns(companyId).filter((campaign) => {
    const linkedToRecords = linkedCampaignIds.has(campaign.id);
    const hintedStaff = campaignStaffHint(campaign, company);
    const staffMatch = requestedStaff === "all" || hintedStaff === requestedStaff || linkedToRecords;
    return staffMatch && (campaignTouchedInRange(campaign, range.dateFrom, range.dateTo) || linkedToRecords);
  });
  const crmCapturedLeads = scopedRecords.filter((record) => record.kind === "lead");
  const crmAdsLeads = crmCapturedLeads.filter(isAdsRecord);
  const bookingRecords = scopedRecords.filter((record) => !isCancelledRefund(record) && (record.kind === "order" || ["Booking", "Deposit"].includes(record.status)));
  const closedRecords = scopedRecords.filter(isClosed);
  const salesValue = closedRecords.reduce((sum, record) => sum + Number(record.value || 0), 0);
  const staffList = profile.role === "staff" ? [profile.staffName] : company.staff;
  const staffRows = staffList.map((staffName) => {
    const staffRecords = scopedRecords.filter((record) => record.staff === staffName);
    const staffAdsLeads = staffRecords.filter((record) => record.kind === "lead" && isAdsRecord(record));
    const staffCampaigns = scopedCampaigns.filter((campaign) => {
      const hintedStaff = campaignStaffHint(campaign, company);
      return hintedStaff === staffName || staffRecords.some((record) => record.campaignId === campaign.id);
    });
    const staffSpend = staffCampaigns.reduce((sum, campaign) => sum + Number(campaign.spend || 0), 0);
    const staffAdsManagerLeads = staffCampaigns.reduce((sum, campaign) => {
      const linkedLeads = staffAdsLeads.filter((record) => record.campaignId === campaign.id);
      return sum + campaignAdsManagerLeads(campaign, linkedLeads, staffName, company);
    }, 0);
    const staffBookings = staffRecords.filter((record) => !isCancelledRefund(record) && (record.kind === "order" || ["Booking", "Deposit"].includes(record.status)));
    const staffClosed = staffRecords.filter(isClosed);
    return {
      staffName,
      spend: staffSpend,
      adsManagerLeads: staffAdsManagerLeads,
      crmCapturedLeads: staffRecords.filter((record) => record.kind === "lead").length,
      booking: staffBookings.length,
      closed: staffClosed.length,
      salesValue: staffClosed.reduce((sum, record) => sum + Number(record.value || 0), 0),
      cpl: staffAdsManagerLeads ? staffSpend / staffAdsManagerLeads : 0
    };
  }).sort((a, b) => b.spend - a.spend || b.crmCapturedLeads - a.crmCapturedLeads || b.salesValue - a.salesValue);

  const campaignRows = scopedCampaigns.map((campaign) => {
    const linkedLeads = crmAdsLeads.filter((record) => record.campaignId === campaign.id);
    const adsLeads = campaignAdsManagerLeads(campaign, linkedLeads, requestedStaff, company);
    const reportDate = campaignReportDate(campaign);
    return {
      ...campaign,
      reportDate,
      adsManagerLeads: adsLeads,
      crmCapturedLeads: linkedLeads.length,
      dailyInsights: mergeDailyInsightsWithLeadFallback(campaign, linkedLeads),
      cpl: adsLeads ? Number(campaign.spend || 0) / adsLeads : 0,
      staffName: campaignStaffHint(campaign, company) || "Mixed"
    };
  });
  const campaignRowIds = new Set(campaignRows.map((campaign) => campaign.id).filter(Boolean));
  const orphanCampaignRows = buildSyntheticCampaignRowsFromAdLeads(
    crmAdsLeads.filter((record) => !record.campaignId || !campaignRowIds.has(record.campaignId)),
    company,
    requestedStaff
  );
  const reportCampaignRows = [...campaignRows, ...orphanCampaignRows]
    .sort((a, b) => a.reportDate.localeCompare(b.reportDate) || String(a.platform || "").localeCompare(String(b.platform || "")) || String(a.name || "").localeCompare(String(b.name || "")));
  const dailySpendRows = buildDailySpendRows(reportCampaignRows, range.dateFrom, range.dateTo);
  const adsSpend = dailySpendRows.reduce((sum, row) => sum + Number(row.totalSpend || 0), 0);
  const adsManagerLeads = dailySpendRows.reduce((sum, row) => sum + Number(row.adsManagerLeads || 0), 0);

  return {
    company,
    range,
    staffFilter: requestedStaff,
    scopedRecords,
    campaigns: reportCampaignRows,
    adsSpend,
    adsManagerLeads,
    crmCapturedLeads: crmCapturedLeads.length,
    crmAdsLeads: crmAdsLeads.length,
    cpl: adsManagerLeads ? adsSpend / adsManagerLeads : 0,
    booking: bookingRecords.length,
    closed: closedRecords.length,
    salesValue,
    staffRows,
    dailySpendRows,
    leadDetails: crmCapturedLeads
  };
}

function buildReportData(companyId, staffFilter, range) {
  const company = companyById(companyId);
  const scopedRecords = recordsInRange(companyRecords(companyId), range.dateFrom, range.dateTo)
    .filter((record) => staffFilter === "all" || record.staff === staffFilter)
    .sort((a, b) => recordDateKey(b).localeCompare(recordDateKey(a)));

  const campaignIds = Array.from(new Set(scopedRecords.map((record) => record.campaignId).filter(Boolean)));
  const scopedCampaigns = campaignsInRange(companyCampaigns(companyId), range.dateFrom, range.dateTo)
    .filter((campaign) => staffFilter === "all" || campaignIds.includes(campaign.id));
  const leads = scopedRecords.filter((record) => record.kind === "lead");
  const orders = activeOrders(scopedRecords);
  const closed = scopedRecords.filter(isClosed);
  const lost = scopedRecords.filter(isLost);
  const open = scopedRecords.filter(isOpen);
  const sales = closed.reduce((sum, record) => sum + Number(record.value || 0), 0);
  const statusRows = company.statuses.map((status) => ({
    status,
    count: scopedRecords.filter((record) => record.status === status).length
  })).filter((item) => item.count > 0);
  const staffRows = company.staff
    .filter((staffName) => staffFilter === "all" || staffName === staffFilter)
    .map((staffName) => {
      const items = scopedRecords.filter((record) => record.staff === staffName);
      const staffClosed = items.filter(isClosed);
      return {
        staffName,
        leads: items.filter((record) => record.kind === "lead").length,
        orders: activeOrders(items).length,
        closed: staffClosed.length,
        bluetick: items.filter((record) => record.status === "Bluetick").length,
        sales: staffClosed.reduce((sum, record) => sum + Number(record.value || 0), 0)
      };
    })
    .sort((a, b) => b.sales - a.sales || b.closed - a.closed || b.leads - a.leads);
  const campaignRows = scopedCampaigns.map((campaign) => {
    const linkedLeads = leads.filter((record) => record.campaignId === campaign.id && isAdsRecord(record));
    const campaignAdsLeads = campaignAdsManagerLeads(campaign, linkedLeads, staffFilter, company);
    const reportDate = campaignReportDate(campaign);
    return {
      ...campaign,
      reportDate,
      adsManagerLeads: campaignAdsLeads,
      crmCapturedLeads: linkedLeads.length,
      dailyInsights: mergeDailyInsightsWithLeadFallback(campaign, linkedLeads),
      cpl: campaignAdsLeads ? Number(campaign.spend || 0) / campaignAdsLeads : 0
    };
  });
  const campaignRowIds = new Set(campaignRows.map((campaign) => campaign.id).filter(Boolean));
  const orphanCampaignRows = buildSyntheticCampaignRowsFromAdLeads(
    leads.filter((record) => isAdsRecord(record) && (!record.campaignId || !campaignRowIds.has(record.campaignId))),
    company,
    staffFilter
  );
  const reportCampaignRows = [...campaignRows, ...orphanCampaignRows]
    .sort((a, b) => a.reportDate.localeCompare(b.reportDate) || String(a.platform || "").localeCompare(String(b.platform || "")) || String(a.name || "").localeCompare(String(b.name || "")));
  const dailySpendRows = buildDailySpendRows(reportCampaignRows, range.dateFrom, range.dateTo);
  const spend = dailySpendRows.reduce((sum, row) => sum + Number(row.totalSpend || 0), 0);
  const adsManagerLeads = dailySpendRows.reduce((sum, row) => sum + Number(row.adsManagerLeads || 0), 0);

  return {
    company,
    staffFilter,
    range,
    records: scopedRecords,
    campaigns: reportCampaignRows,
    leads,
    orders,
    closed,
    lost,
    open,
    due: dueFollowUps(scopedRecords).length,
    sales,
    spend,
    dailySpendRows,
    adsManagerLeads,
    crmCapturedLeads: leads.length,
    cpl: adsManagerLeads ? spend / adsManagerLeads : 0,
    unitLabel: companyUnitLabel(company.id),
    statuses: statusRows,
    staffRows,
    sources: sourceSummary(scopedRecords)
  };
}

function companyReportTheme(companyId) {
  if (companyId === "salam-land") {
    return {
      ink: [0.07, 0.11, 0.18],
      accent: [1, 0.76, 0.11],
      accentSoft: [1, 0.96, 0.84],
      panel: [0.95, 0.97, 1],
      panelAlt: [0.98, 0.99, 1],
      line: [0.81, 0.86, 0.95],
      muted: [0.34, 0.41, 0.53],
      white: [1, 1, 1]
    };
  }

  if (companyId === "bumi-hayat") {
    return {
      ink: [0.06, 0.13, 0.1],
      accent: [0.27, 0.84, 0.55],
      accentSoft: [0.88, 0.98, 0.92],
      panel: [0.95, 0.99, 0.97],
      panelAlt: [0.98, 1, 0.99],
      line: [0.79, 0.9, 0.84],
      muted: [0.31, 0.42, 0.37],
      white: [1, 1, 1]
    };
  }

  return {
    ink: [0.11, 0.08, 0.04],
    accent: [0.82, 0.64, 0.17],
    accentSoft: [0.99, 0.95, 0.83],
    panel: [0.99, 0.98, 0.95],
    panelAlt: [1, 0.99, 0.97],
    line: [0.89, 0.84, 0.74],
    muted: [0.38, 0.32, 0.24],
    white: [1, 1, 1]
  };
}

function pdfNumber(value) {
  return Number(value).toFixed(3).replace(/\.?0+$/, "");
}

function maxCharsForWidth(width, size) {
  return Math.max(10, Math.floor(width / Math.max(4.8, size * 0.48)));
}

function buildStyledReportPdf(report) {
  const theme = companyReportTheme(report.company.id);
  const pageWidth = 595;
  const pageHeight = 842;
  const margin = 34;
  const gutter = 12;
  const bottomMargin = 40;
  const contentWidth = pageWidth - (margin * 2);
  const pages = [[]];
  let pageIndex = 0;
  let cursorY = pageHeight - margin;

  function push(op) {
    pages[pageIndex].push(op);
  }

  function fillColor(color) {
    return `${color.map(pdfNumber).join(" ")} rg`;
  }

  function strokeColor(color) {
    return `${color.map(pdfNumber).join(" ")} RG`;
  }

  function shiftColor(color, amount) {
    return color.map((value) => Math.max(0, Math.min(1, value + amount)));
  }

  function drawRect(x, y, width, height, options = {}) {
    const operations = [];
    const mode = options.fill && options.stroke ? "B" : options.fill ? "f" : "S";
    if (options.fill) operations.push(fillColor(options.fill));
    if (options.stroke) operations.push(strokeColor(options.stroke));
    if (options.lineWidth) operations.push(`${pdfNumber(options.lineWidth)} w`);
    operations.push(`${pdfNumber(x)} ${pdfNumber(y)} ${pdfNumber(width)} ${pdfNumber(height)} re ${mode}`);
    push(operations.join("\n"));
  }

  function drawText(text, x, baselineY, options = {}) {
    const font = options.bold ? "F2" : "F1";
    const size = options.size || 11;
    const color = options.color || theme.ink;
    push(`${fillColor(color)}\nBT /${font} ${pdfNumber(size)} Tf 1 0 0 1 ${pdfNumber(x)} ${pdfNumber(baselineY)} Tm (${escapePdfText(text)}) Tj ET`);
  }

  function drawWrappedText(text, x, topY, width, options = {}) {
    const size = options.size || 11;
    const lineHeight = options.lineHeight || Math.round(size * 1.45);
    const lines = wrapPdfText(text, options.maxChars || maxCharsForWidth(width, size));
    let baselineY = topY - size;
    lines.forEach((line) => {
      drawText(line, x, baselineY, options);
      baselineY -= lineHeight;
    });
    return lines.length * lineHeight;
  }

  function addPage() {
    pageIndex += 1;
    pages[pageIndex] = [];
    cursorY = pageHeight - margin;
    drawPageHeader(false);
  }

  function ensureSpace(heightNeeded) {
    if (cursorY - heightNeeded < bottomMargin) {
      addPage();
    }
  }

  function drawPageHeader(isCoverPage) {
    const nameLength = report.company.name.length;
    const leftX = margin + 22;
    const metaWidth = isCoverPage ? 184 : 170;
    const metaPaddingX = isCoverPage ? 16 : 14;
    const metaPaddingY = isCoverPage ? 15 : 12;
    const metaX = margin + contentWidth - metaWidth - 18;
    const titleWidth = Math.max(220, metaX - leftX - 34);
    const titleTopPadding = isCoverPage ? 16 : 14;
    const titleBottomPadding = isCoverPage ? 18 : 16;
    const metaFill = shiftColor(theme.ink, 0.06);
    const metaLine = shiftColor(theme.line, -0.1);

    let titleSize = isCoverPage ? 24 : 19;
    if (nameLength > 20) titleSize -= 1;
    if (nameLength > 28) titleSize -= 1;
    if (nameLength > 36) titleSize -= 1;
    const titleLineHeight = isCoverPage ? 28 : 23;
    const titleLines = wrapPdfText(report.company.name, maxCharsForWidth(titleWidth, titleSize));
    const titleHeight = titleLines.length * titleLineHeight;
    const overlineSize = 12;
    const overlineLineHeight = 14;
    const subtitleSize = isCoverPage ? 14 : 11;
    const subtitleLineHeight = subtitleSize + 2;
    const leftClusterHeight = overlineLineHeight + 8 + titleHeight + 10 + 3 + 8 + subtitleLineHeight;

    const staffValue = report.staffFilter === "all" ? "Semua staff / team sales" : report.staffFilter;
    const metaItems = [
      {
        label: "Period",
        value: report.range.label
      },
      {
        label: "Staff filter",
        value: staffValue
      }
    ];
    if (isCoverPage) {
      metaItems.push({
        label: "Generated",
        value: prettyDate(todayIso())
      });
    }

    const metaLabelSize = 9;
    const metaLabelLineHeight = 11;
    const metaValueSize = isCoverPage ? 10.5 : 9.5;
    const metaValueLineHeight = isCoverPage ? 13 : 12;
    const metaRowGap = isCoverPage ? 9 : 7;
    const metaPrepared = metaItems.map((item) => {
      const lines = wrapPdfText(item.value, maxCharsForWidth(metaWidth - (metaPaddingX * 2), metaValueSize));
      const valueHeight = Math.max(metaValueLineHeight, lines.length * metaValueLineHeight);
      return {
        ...item,
        lines,
        blockHeight: metaLabelLineHeight + 3 + valueHeight
      };
    });
    const metaContentHeight = metaPrepared.reduce((sum, item) => sum + item.blockHeight, 0) + (metaRowGap * Math.max(0, metaPrepared.length - 1));
    const metaHeight = Math.max(isCoverPage ? 104 : 82, metaContentHeight + (metaPaddingY * 2));
    const headerHeight = Math.max(isCoverPage ? 132 : 102, leftClusterHeight + titleTopPadding + titleBottomPadding, metaHeight + 28);
    const headerTop = cursorY;
    const headerBottom = cursorY - headerHeight;
    const metaTop = headerTop - ((headerHeight - metaHeight) / 2);
    const leftClusterTop = headerTop - ((headerHeight - leftClusterHeight) / 2);

    drawRect(margin, headerBottom, contentWidth, headerHeight, { fill: theme.ink });
    drawRect(margin, headerBottom, 9, headerHeight, { fill: theme.accent });
    drawRect(metaX, metaTop - metaHeight, metaWidth, metaHeight, {
      fill: metaFill,
      stroke: metaLine,
      lineWidth: 1
    });

    drawText("CRM Salam Fortress", leftX, leftClusterTop - overlineSize, {
      size: overlineSize,
      bold: true,
      color: theme.accentSoft
    });
    const titleTop = leftClusterTop - overlineLineHeight - 8;
    drawWrappedText(report.company.name, leftX, titleTop, titleWidth, {
      size: titleSize,
      bold: true,
      color: theme.white,
      lineHeight: titleLineHeight
    });
    const accentY = titleTop - titleHeight - 7;
    drawRect(leftX, accentY, 72, 3, { fill: theme.accent });
    drawText("Sales report", leftX, accentY - 8 - subtitleSize, {
      size: subtitleSize,
      bold: true,
      color: theme.accentSoft
    });

    let metaCursorTop = metaTop - metaPaddingY;
    metaPrepared.forEach((item, index) => {
      drawText(item.label, metaX + metaPaddingX, metaCursorTop - metaLabelSize, {
        size: metaLabelSize,
        bold: true,
        color: theme.accentSoft
      });

      let valueBaselineY = metaCursorTop - metaLabelLineHeight - metaValueSize;
      item.lines.forEach((line) => {
        drawText(line, metaX + metaPaddingX, valueBaselineY, {
          size: metaValueSize,
          bold: index === 0,
          color: theme.white
        });
        valueBaselineY -= metaValueLineHeight;
      });

      metaCursorTop -= item.blockHeight;
      if (index < metaPrepared.length - 1) {
        drawRect(metaX + metaPaddingX, metaCursorTop - 4, metaWidth - (metaPaddingX * 2), 1, { fill: metaLine });
        metaCursorTop -= metaRowGap;
      }
    });

    cursorY = headerBottom - 22;
  }

  function drawSectionTitle(title, note = "") {
    ensureSpace(note ? 72 : 46);
    const sectionTop = cursorY;
    drawText(title, margin, sectionTop - 6, {
      size: 13,
      bold: true,
      color: theme.ink
    });
    drawRect(margin, sectionTop - 20, 58, 4, { fill: theme.accent });
    let noteHeight = 0;
    if (note) {
      noteHeight = drawWrappedText(note, margin, sectionTop - 30, Math.min(contentWidth, 400), {
        size: 9,
        color: theme.muted,
        lineHeight: 12
      });
    }
    cursorY = sectionTop - (note ? 36 + noteHeight : 30);
  }

  function drawMetricCard(x, topY, width, height, metric, highlighted = false) {
    const fill = highlighted ? theme.accentSoft : theme.panel;
    drawRect(x, topY - height, width, height, { fill, stroke: theme.line, lineWidth: 1 });
    drawRect(x, topY - 8, width, 8, { fill: highlighted ? theme.accent : theme.line });
    drawText(metric.label, x + 14, topY - 24, {
      size: 9,
      bold: true,
      color: highlighted ? theme.ink : theme.muted
    });
    drawWrappedText(metric.value, x + 14, topY - 32, width - 28, {
      size: 17,
      bold: true,
      color: theme.ink,
      lineHeight: 20,
      maxChars: maxCharsForWidth(width - 28, 17)
    });
    drawWrappedText(metric.note, x + 14, topY - 70, width - 28, {
      size: 9,
      color: theme.muted,
      lineHeight: 12
    });
  }

  function drawMetricGrid(metrics) {
    const columnWidth = (contentWidth - (gutter * 2)) / 3;
    const cardHeight = 96;
    ensureSpace((cardHeight * 2) + 28);
    let index = 0;
    const top = cursorY;
    for (let row = 0; row < 2; row += 1) {
      for (let column = 0; column < 3; column += 1) {
        const metric = metrics[index];
        if (!metric) continue;
        const x = margin + (column * (columnWidth + gutter));
        const rowTop = top - (row * (cardHeight + 12));
        drawMetricCard(x, rowTop, columnWidth, cardHeight, metric, metric.highlighted);
        index += 1;
      }
    }
    cursorY = top - ((cardHeight * 2) + 28);
  }

  function drawSimpleTable(title, columns, rows, note = "") {
    const minRowHeight = 24;
    const headerHeight = 26;
    const tableTopGap = 12;
    const totalWidth = columns.reduce((sum, column) => sum + column.width, 0);
    const previewRowCount = rows.length ? Math.min(rows.length, 2) : 1;
    const titleBlockHeight = note ? 72 : 46;

    ensureSpace(titleBlockHeight + tableTopGap + headerHeight + (previewRowCount * minRowHeight) + 18);
    drawSectionTitle(title, note);

    function drawHeaderRow(topY) {
      drawRect(margin, topY - headerHeight, totalWidth, headerHeight, {
        fill: theme.accentSoft,
        stroke: theme.line,
        lineWidth: 1
      });
      let currentX = margin;
      columns.forEach((column) => {
        drawText(column.label, currentX + 6, topY - 15, {
          size: 8,
          bold: true,
          color: theme.ink
        });
        currentX += column.width;
      });
    }

    let tableTop = cursorY - tableTopGap;
    drawHeaderRow(tableTop);
    let rowTop = tableTop - headerHeight;

    if (!rows.length) {
      drawRect(margin, rowTop - 30, totalWidth, 30, {
        fill: theme.panelAlt,
        stroke: theme.line,
        lineWidth: 1
      });
      drawText("Tiada data dalam scope ini.", margin + 8, rowTop - 18, {
        size: 10,
        color: theme.muted
      });
      cursorY = rowTop - 42;
      return;
    }

    rows.forEach((row, rowIndex) => {
      const prepared = columns.map((column) => {
        const value = column.value(row);
        const lines = wrapPdfText(String(value || "-"), column.maxChars || maxCharsForWidth(column.width - 12, 9));
        return {
          width: column.width,
          lines
        };
      });
      const rowHeight = Math.max(minRowHeight, (Math.max(...prepared.map((cell) => cell.lines.length)) * 12) + 10);

      if (rowTop - rowHeight < bottomMargin) {
        addPage();
        ensureSpace(titleBlockHeight + tableTopGap + headerHeight + rowHeight + 18);
        drawSectionTitle(title, note ? `${note} (sambungan)` : "Sambungan");
        tableTop = cursorY - tableTopGap;
        drawHeaderRow(tableTop);
        rowTop = tableTop - headerHeight;
      }

      drawRect(margin, rowTop - rowHeight, totalWidth, rowHeight, {
        fill: rowIndex % 2 === 0 ? theme.panel : theme.panelAlt,
        stroke: theme.line,
        lineWidth: 1
      });

      let currentX = margin;
      prepared.forEach((cell, cellIndex) => {
        const color = columns[cellIndex].accent ? theme.ink : theme.muted;
        let baseline = rowTop - 14;
        cell.lines.forEach((line, lineIndex) => {
          drawText(line, currentX + 6, baseline - (lineIndex * 12), {
            size: 9,
            bold: lineIndex === 0 && columns[cellIndex].boldFirstLine,
            color
          });
        });
        currentX += cell.width;
      });

      rowTop -= rowHeight;
    });

    cursorY = rowTop - 18;
  }

  drawPageHeader(true);

  const activeSpendDays = new Set((report.dailySpendRows || []).filter((row) => row.totalSpend || row.adsManagerLeads).map((row) => row.date)).size;
  drawMetricGrid([
    { label: "Ads Manager leads", value: formatNumber(report.adsManagerLeads), note: "Total leads dari Ads Manager" },
    { label: "Ads spend", value: formatCurrency(report.spend), note: "Spend kempen dalam scope" },
    { label: "CPL", value: formatCurrency(report.cpl), note: "Spend / Ads Manager leads" },
    { label: "Spend days", value: formatNumber(activeSpendDays), note: "Hari ada spend / leads ads" },
    { label: "Orders", value: formatNumber(report.orders.length), note: "Order / booking direkodkan" },
    { label: "Closed sales", value: formatCurrency(report.sales), note: "Jumlah value closed", highlighted: true }
  ]);

  drawSimpleTable("Daily spend and Ads Manager leads", [
    { label: "Tarikh", width: 78, value: (row) => prettyDate(row.date), boldFirstLine: true, accent: true },
    { label: "Platform", width: 72, value: (row) => row.platform, boldFirstLine: true },
    { label: "Nama kempen", width: 235, value: (row) => row.name, maxChars: 38 },
    { label: "Total leads", width: 67, value: (row) => formatNumber(row.adsManagerLeads), boldFirstLine: true },
    { label: "Spend", width: 75, value: (row) => formatCurrency(row.totalSpend), boldFirstLine: true, accent: true }
  ], report.dailySpendRows || [], "Menggantikan senarai lead/customer. Jadual ini hanya tunjuk setiap tarikh, campaign, total leads Ads Manager dan kos spend harian.");

  const encoder = new TextEncoder();
  const byteLength = (text) => encoder.encode(text).length;
  const objects = [];
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  objects[4] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>";

  let nextObjectId = 5;
  const pageObjectIds = [];
  const contentObjectIds = [];

  for (let index = 0; index < pages.length; index += 1) {
    contentObjectIds.push(nextObjectId++);
    pageObjectIds.push(nextObjectId++);
  }

  objects[2] = `<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`;

  pages.forEach((pageOps, index) => {
    const backgroundOps = `${fillColor([1, 1, 1])}\n0 0 ${pdfNumber(pageWidth)} ${pdfNumber(pageHeight)} re f`;
    const footerOps = [
      `${strokeColor(theme.line)} 0.7 w ${pdfNumber(margin)} 24 m ${pdfNumber(pageWidth - margin)} 24 l S`,
      `${fillColor(theme.muted)}\nBT /F1 9 Tf 1 0 0 1 ${pdfNumber(margin)} 12 Tm (${escapePdfText(report.company.name)}) Tj ET`,
      `${fillColor(theme.muted)}\nBT /F1 9 Tf 1 0 0 1 ${pdfNumber(pageWidth - margin - 60)} 12 Tm (${escapePdfText(`Page ${index + 1} / ${pages.length}`)}) Tj ET`
    ];
    const stream = [backgroundOps, ...pageOps, ...footerOps].join("\n");
    objects[contentObjectIds[index]] = `<< /Length ${byteLength(stream)} >>\nstream\n${stream}\nendstream`;
    objects[pageObjectIds[index]] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentObjectIds[index]} 0 R >>`;
  });

  let pdf = "%PDF-1.4\n";
  const offsets = [0];

  for (let objectId = 1; objectId < objects.length; objectId += 1) {
    offsets[objectId] = byteLength(pdf);
    pdf += `${objectId} 0 obj\n${objects[objectId]}\nendobj\n`;
  }

  const xrefOffset = byteLength(pdf);
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;

  for (let objectId = 1; objectId < objects.length; objectId += 1) {
    pdf += `${String(offsets[objectId]).padStart(10, "0")} 00000 n \n`;
  }

  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return new Blob([pdf], { type: "application/pdf" });
}

function reportLineSpecs(report) {
  const companyName = report.company.name;
  const staffLabel = report.staffFilter === "all" ? "Semua staff / team sales" : report.staffFilter;
  const lines = [
    { text: "CRM Salam Fortress", size: 18, bold: true },
    { text: `${companyName} sales and leads report`, size: 15, bold: true, gapBefore: 4, maxChars: 52 },
    { text: `Period: ${report.range.label}`, size: 11, gapBefore: 6 },
    { text: `Staff filter: ${staffLabel}`, size: 11 },
    { text: `Generated: ${prettyDate(todayIso())}`, size: 10, gapBefore: 4 },
    { text: "SUMMARY", size: 13, bold: true, gapBefore: 18 },
    { text: `- Ads Manager leads: ${formatNumber(report.adsManagerLeads)}`, size: 11 },
    { text: `- Total orders: ${formatNumber(report.orders.length)}`, size: 11 },
    { text: `- Open queue: ${formatNumber(report.open.length)}`, size: 11 },
    { text: `- Closed records: ${formatNumber(report.closed.length)}`, size: 11 },
    { text: `- Lost records: ${formatNumber(report.lost.length)}`, size: 11 },
    { text: `- Follow-up due: ${formatNumber(report.due)}`, size: 11 },
    { text: `- Closed sales value: ${formatCurrency(report.sales)}`, size: 11 },
    { text: `- Marketing spend in scope: ${formatCurrency(report.spend)}`, size: 11 },
    { text: `- CPL: ${formatCurrency(report.cpl)}`, size: 11 }
  ];

  lines.push({ text: "DAILY SPEND AND ADS MANAGER LEADS", size: 13, bold: true, gapBefore: 18 });
  (report.dailySpendRows || []).forEach((row) => {
    lines.push({
      text: `- ${prettyDate(row.date)} | ${row.platform} | ${row.name} | Leads ${formatNumber(row.adsManagerLeads)} | Spend ${formatCurrency(row.totalSpend)}`,
      size: 10,
      maxChars: 88
    });
  });

  lines.push({ text: "DETAIL NOTE", size: 13, bold: true, gapBefore: 18 });
  lines.push({ text: "- Lead/customer detail tidak dimasukkan dalam spend report. Report ini fokus spend, tarikh dan total leads Ads Manager sahaja.", size: 11 });

  return lines;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

async function downloadReportPdf() {
  if (!refs.reportForm.reportValidity()) return;
  const formData = new FormData(refs.reportForm);
  const scope = String(formData.get("scope") || "month");
  const monthValue = String(formData.get("month") || currentMonthValue());
  const dateFrom = String(formData.get("dateFrom") || "");
  const dateTo = String(formData.get("dateTo") || "");

  if (scope === "range" && dateFrom && dateTo && dateFrom > dateTo) {
    window.alert("Tarikh mula mesti sama atau lebih awal daripada tarikh akhir.");
    return;
  }

  const range = resolveReportRange(scope, monthValue, dateFrom, dateTo);
  const downloadButton = document.querySelector("#downloadReportButton");
  const originalText = downloadButton?.textContent || "";
  if (downloadButton) {
    downloadButton.disabled = true;
    downloadButton.textContent = "Syncing ads...";
  }
  try {
    await syncReportSpendData(String(formData.get("companyId")), String(formData.get("staff") || "all"), range);
  } catch (error) {
    pushRuntimeError(`Ads spend sync gagal: ${error.message}`);
  } finally {
    if (downloadButton) {
      downloadButton.disabled = false;
      downloadButton.textContent = originalText || "Download PDF";
    }
  }
  const report = buildReportData(String(formData.get("companyId")), String(formData.get("staff") || "all"), range);
  const pdfBlob = buildStyledReportPdf(report);
  const filenameStaff = report.staffFilter === "all" ? "all-staff" : report.staffFilter.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const filenamePeriod = scope === "month" ? range.month : `${range.dateFrom}-${range.dateTo}`;
  const filename = `crm-salam-fortress-${report.company.id}-${filenameStaff}-${filenamePeriod}.pdf`;

  downloadBlob(pdfBlob, filename);
  refs.reportDialog.close();
}

function collectDetails(formData) {
  const details = {};
  for (const [key, value] of formData.entries()) {
    if (!key.startsWith("detail:")) continue;
    const fieldName = key.slice(7);
    details[fieldName] = value;
  }
  return details;
}

function numeric(value) {
  return Number(value || 0);
}

function orderGrossValue(details = {}, fallbackValue = 0) {
  return numeric(details.landPrice || details.quoteAmount || fallbackValue)
    || (numeric(details.pricePerGram || 0) * numeric(details.grams || 0));
}

function orderDiscountValue(details = {}, grossValue = 0) {
  const discount = Math.max(0, numeric(details.discountAmount || details.discount || 0));
  return grossValue ? Math.min(discount, grossValue) : discount;
}

function orderNetValue(details = {}, fallbackValue = 0) {
  const gross = orderGrossValue(details, fallbackValue);
  const discount = orderDiscountValue(details, gross);
  return Math.max(0, gross - discount);
}

function normalizePaymentSchedule(schedule = []) {
  return (Array.isArray(schedule) ? schedule : []).map((phase, index) => {
    const paymentDate = String(phase.paymentDate || phase.paidDate || phase.dueDate || "").slice(0, 10);
    return {
      id: phase.id || createId("pay"),
      label: String(phase.label || (index === 0 ? "Booking / Deposit" : `Pay ${index + 1}`)).trim(),
      amount: numeric(phase.amount),
      paymentDate,
      method: String(phase.method || phase.paymentMethod || "").trim(),
      reference: String(phase.reference || "").trim(),
      remark: String(phase.remark || "").trim(),
      status: "Paid",
      paidDate: paymentDate,
      dueDate: ""
    };
  }).filter((phase) => phase.label || phase.amount || phase.paymentDate || phase.reference || phase.remark);
}

function collectPaymentSchedule() {
  if (!refs.paymentScheduleRows) return [];
  return normalizePaymentSchedule(Array.from(refs.paymentScheduleRows.querySelectorAll("[data-payment-phase]")).map((row, index) => ({
    id: row.dataset.paymentPhase || createId("pay"),
    label: row.querySelector('[data-payment-field="label"]')?.value || `Pay ${index + 1}`,
    amount: row.querySelector('[data-payment-field="amount"]')?.value || 0,
    paymentDate: row.querySelector('[data-payment-field="paymentDate"]')?.value || "",
    method: row.querySelector('[data-payment-field="method"]')?.value || "",
    reference: row.querySelector('[data-payment-field="reference"]')?.value || "",
    remark: row.querySelector('[data-payment-field="remark"]')?.value || ""
  })));
}

function summarizePaymentSchedule(schedule = [], totalValue = 0) {
  const normalized = normalizePaymentSchedule(schedule);
  const totalPaid = normalized.reduce((sum, phase) => sum + numeric(phase.amount), 0);
  const balance = Math.max(0, numeric(totalValue) - totalPaid);
  const datedPhases = normalized
    .filter((phase) => phase.paymentDate)
    .sort((a, b) => a.paymentDate.localeCompare(b.paymentDate));
  const lastPhase = datedPhases.at(-1) || normalized.at(-1) || null;
  return {
    schedule: normalized,
    totalPaid,
    balance,
    lastPaymentDate: lastPhase?.paymentDate || "",
    lastPaymentAmount: lastPhase ? numeric(lastPhase.amount) : 0,
    lastPaymentLabel: lastPhase?.label || "",
    paymentCount: normalized.length,
    paymentStatus: balance <= 0 && numeric(totalValue) > 0
      ? "Paid"
      : totalPaid > 0
        ? "Partial"
        : "Unpaid"
  };
}

function renderPaymentScheduleRows(schedule = []) {
  if (!refs.paymentScheduleRows) return;
  const normalized = normalizePaymentSchedule(schedule);
  const currentMethod = refs.orderForm?.elements?.["detail:paymentMethod"]?.value || "Bank transfer";
  refs.paymentScheduleRows.innerHTML = normalized.length ? normalized.map((phase) => `
    <div class="payment-phase-row" data-payment-phase="${escapeAttribute(phase.id)}">
      <label>
        Fasa
        <input data-payment-field="label" value="${escapeAttribute(phase.label)}" placeholder="Pay 1">
      </label>
      <label>
        Amount (RM)
        <input data-payment-field="amount" type="number" min="0" step="1" value="${phase.amount || ""}">
      </label>
      <label>
        Payment date
        <input data-payment-field="paymentDate" type="date" value="${escapeAttribute(phase.paymentDate || "")}">
      </label>
      <label>
        Method
        <select data-payment-field="method">
          ${["Bank transfer", "Cash", "QR / DuitNow", "Card", "Installment"].map((method) => `<option value="${method}" ${(phase.method || currentMethod) === method ? "selected" : ""}>${method}</option>`).join("")}
        </select>
      </label>
      <label>
        Ref
        <input data-payment-field="reference" value="${escapeAttribute(phase.reference || "")}" placeholder="Bank/ref">
      </label>
      <label class="phase-remark">
        Remark
        <input data-payment-field="remark" value="${escapeAttribute(phase.remark || "")}" placeholder="Nota bayaran">
      </label>
      <button class="icon-button" type="button" data-remove-payment-phase="${escapeAttribute(phase.id)}" aria-label="Remove payment phase">x</button>
    </div>
  `).join("") : `<div class="empty-state compact">Belum ada payment phase. Klik Auto setup atau Add phase.</div>`;
  renderPaymentScheduleSummary();
}

function renderPaymentScheduleSummary() {
  if (!refs.paymentScheduleSummary) return;
  const schedule = collectPaymentSchedule();
  const isSalam = refs.orderCompanyInput?.value === "salam-land";
  const details = refs.orderForm ? collectDetails(new FormData(refs.orderForm)) : {};
  const grossValue = orderGrossValue(details, numeric(refs.orderForm?.elements.value?.value));
  const discountValue = orderDiscountValue(details, grossValue);
  const orderValue = isSalam
    ? Math.max(0, grossValue - discountValue)
    : numeric(refs.orderForm?.elements.value?.value) || Math.max(0, grossValue - discountValue);
  const summary = summarizePaymentSchedule(schedule, orderValue);
  refs.paymentScheduleSummary.innerHTML = `
    ${discountValue ? `<span>Harga asal <strong>${formatCurrency(grossValue)}</strong></span>` : ""}
    ${discountValue ? `<span>Diskaun <strong>${formatCurrency(discountValue)}</strong></span>` : ""}
    <span>Nett <strong>${formatCurrency(orderValue)}</strong></span>
    <span>Total paid <strong>${formatCurrency(summary.totalPaid)}</strong></span>
    <span>Balance <strong>${formatCurrency(summary.balance)}</strong></span>
    <span>Last payment <strong>${summary.lastPaymentDate ? `${summary.lastPaymentLabel} / ${prettyDate(summary.lastPaymentDate)}` : "-"}</strong></span>
    <span>Payment count <strong>${formatNumber(summary.paymentCount)}</strong></span>
  `;
}

function addPaymentPhase(phase = {}) {
  const current = collectPaymentSchedule();
  const nextIndex = current.length + 1;
  const currentMethod = refs.orderForm?.elements?.["detail:paymentMethod"]?.value || "Bank transfer";
  const nextPhase = {
    id: phase.id || createId("pay"),
    label: phase.label || (nextIndex === 1 ? "Booking / Deposit" : `Pay ${nextIndex}`),
    amount: phase.amount || "",
    paymentDate: phase.paymentDate || phase.paidDate || phase.dueDate || todayIso(),
    method: phase.method || currentMethod,
    reference: phase.reference || "",
    remark: phase.remark || ""
  };
  renderPaymentScheduleRows([...current, nextPhase]);
}

function autoSetupPaymentSchedule() {
  const existing = collectPaymentSchedule();
  if (existing.length && !window.confirm("Ganti payment schedule sedia ada dengan setup auto?")) return;
  const details = collectDetails(new FormData(refs.orderForm));
  const isSalam = refs.orderCompanyInput?.value === "salam-land";
  const isBumiHayat = refs.orderCompanyInput?.value === "bumi-hayat";
  const grossValue = orderGrossValue(details, numeric(refs.orderForm.elements.value.value));
  const orderValue = isSalam ? orderNetValue(details, grossValue) : numeric(refs.orderForm.elements.value.value) || orderNetValue(details, grossValue);
  const designDeposit = isBumiHayat ? numeric(details.designDeposit || 0) : 0;
  const booking = numeric(details.bookingAmount || 0);
  const rawDeposit = isSalam ? 0 : numeric(details.depositAmount || 0);
  const deposit = rawDeposit && rawDeposit !== booking ? rawDeposit : 0;
  const installment = numeric(details.installmentAmount || 0);
  const finalPayment = numeric(details.finalPaymentAmount || 0);
  const paidAmount = numeric(details.paidAmount || 0);
  const currentMethod = details.paymentMethod || "Bank transfer";
  const schedule = [];
  if (designDeposit) {
    schedule.push({
      id: createId("pay"),
      label: "Design deposit",
      amount: designDeposit,
      paymentDate: todayIso(),
      method: currentMethod,
      reference: details.paymentReference || "",
      remark: "RM100 custom design deposit, carry forward to total payment"
    });
  }
  if (booking) {
    schedule.push({
      id: createId("pay"),
      label: "Booking",
      amount: booking,
      paymentDate: todayIso(),
      method: currentMethod,
      reference: details.paymentReference || "",
      remark: "Initial booking payment"
    });
  }
  if (deposit && deposit !== booking) {
    schedule.push({
      id: createId("pay"),
      label: isBumiHayat ? "50% payment" : "Deposit",
      amount: deposit,
      paymentDate: todayIso(),
      method: currentMethod,
      reference: details.paymentReference || "",
      remark: isBumiHayat ? "Payment after design submission" : "Deposit payment"
    });
  }
  if (installment) {
    schedule.push({
      id: createId("pay"),
      label: `Pay ${schedule.length + 1}`,
      amount: installment,
      paymentDate: todayIso(),
      method: currentMethod,
      reference: "",
      remark: "Bayaran fasa direkod staff"
    });
  }
  if (finalPayment) {
    schedule.push({
      id: createId("pay"),
      label: "Final payment",
      amount: finalPayment,
      paymentDate: todayIso(),
      method: currentMethod,
      reference: details.paymentReference || "",
      remark: "Full payment before pickup / ambil baju"
    });
  }
  if (!schedule.length && paidAmount) {
    schedule.push({
      id: createId("pay"),
      label: "Paid amount",
      amount: paidAmount,
      paymentDate: todayIso(),
      method: currentMethod,
      reference: details.paymentReference || "",
      remark: "Paid amount"
    });
  }
  if (!schedule.length && orderValue) {
    window.alert(isSalam
      ? "Isi booking atau bayaran fasa dahulu, atau tekan Add phase untuk rekod bayaran sebenar."
      : "Isi booking/deposit/bayaran fasa dahulu, atau tekan Add phase untuk rekod bayaran sebenar.");
    return;
  }
  renderPaymentScheduleRows(schedule);
}

function parsePaymentAmount(text = "") {
  const match = String(text || "").match(/RM\s*([\d,.]+)/i);
  if (!match) return 0;
  return Number(match[1].replace(/,/g, "")) || 0;
}

function parsePaymentDate(text = "") {
  const match = String(text || "").match(/\((\d{1,2})\/(\d{1,2})\/(\d{2,4})\)/);
  if (!match) return "";
  const day = match[1].padStart(2, "0");
  const month = match[2].padStart(2, "0");
  const year = match[3].length === 2 ? `20${match[3]}` : match[3];
  return `${year}-${month}-${day}`;
}

function importPaymentScheduleFromText() {
  const rawText = String(refs.paymentSchedulePasteInput?.value || "").trim();
  if (!rawText) {
    window.alert("Paste jadual bayaran dulu dalam kotak Import text.");
    return;
  }

  const lines = rawText.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const schedule = [];
  let totalValue = 0;
  let balanceValue = 0;

  lines.forEach((line) => {
    const amount = parsePaymentAmount(line);
    const paymentDate = parsePaymentDate(line) || todayIso();
    const upper = line.toUpperCase();
    if (upper.startsWith("TOTAL")) {
      totalValue = amount;
      return;
    }
    if (upper.startsWith("BALANCE")) {
      balanceValue = amount;
      return;
    }
    if (!amount || (!upper.includes("PAY") && !upper.includes("DEPOSIT") && !upper.includes("BOOKING"))) return;

    const labelMatch = line.match(/^([^:]+):/);
    const label = labelMatch ? labelMatch[1].trim().replace(/\s+/g, " ") : `Pay ${schedule.length + 1}`;
    schedule.push({
      id: createId("pay"),
      label,
      amount,
      paymentDate,
      method: refs.orderForm?.elements?.["detail:paymentMethod"]?.value || "Bank transfer",
      reference: "",
      remark: "Imported from payment text"
    });
  });

  if (!schedule.length) {
    window.alert("Sistem tak jumpa format PAY / DEPOSIT dalam text itu. Cuba paste line macam PAY 1 : RM5,000 (20/1/2026).");
    return;
  }

  if (totalValue) {
    refs.orderForm.elements.value.value = String(totalValue);
    const landPriceInput = refs.orderQuickFields?.querySelector('[name="detail:landPrice"]');
    if (landPriceInput && !landPriceInput.value) landPriceInput.value = String(totalValue);
  }

  if (balanceValue) {
    const currentNotes = cleanOrderNoteText(refs.orderForm.elements.notes.value || "");
    refs.orderForm.elements.notes.value = [currentNotes, `Balance dari payment text: ${formatCurrency(balanceValue)}`]
      .filter(Boolean)
      .join("\n");
  }

  renderPaymentScheduleRows(schedule);
  refs.paymentSchedulePasteInput.value = "";
}

async function saveLead() {
  if (!refs.leadForm.reportValidity()) return;
  const formData = new FormData(refs.leadForm);
  const company = companyById(formData.get("companyId"));
  const duplicates = recentDuplicates(company.id, formData.get("phone"));
  if (duplicates.length && !refs.leadAllowDuplicateInput.checked) {
    renderLeadDuplicateState();
    window.alert("Nombor ini sudah ada dalam lead lama. Tick pilihan duplicate jika memang inquiry baru.");
    return;
  }

  const details = collectDetails(formData);
  let attachments = [];
  try {
    attachments = state.runtime.backendReady && state.session.authenticated
      ? await uploadAttachments(refs.leadFilesInput.files, company.id, "lead")
      : await readAttachments(refs.leadFilesInput.files);
  } catch (error) {
    pushRuntimeError(error.message || "Lampiran lead gagal diproses.");
    saveState();
    window.alert(error.message || "Lampiran lead gagal diproses.");
    return;
  }
  const lead = {
    id: createId("rec"),
    kind: "lead",
    companyId: company.id,
    customerName: String(formData.get("customerName")).trim(),
    phone: String(formData.get("phone")).trim(),
    source: formData.get("source"),
    campaignId: formData.get("campaignId"),
    staff: formData.get("staff"),
    product: formData.get("product"),
    status: formData.get("status"),
    createdAt: todayIso(),
    updatedAt: new Date().toISOString(),
    nextFollowUp: formData.get("nextFollowUp") || isoOffsetFromDate(todayIso(), FOLLOW_UP_DAYS),
    value: numeric(details.landPrice || 0),
    units: numeric(details.quantity || details.grams || 0),
    details,
    actionFlags: normalizeActionFlags(),
    attachments,
    notes: cleanOrderNoteText(formData.get("notes") || "")
  };

  state.records = [lead, ...state.records];
  logActivity({
    action: "Lead saved",
    companyId: company.id,
    detail: `${lead.customerName} / ${lead.product} / ${lead.staff}${duplicates.length ? " / duplicate override" : ""}`
  });
  await persistState();
  refs.leadDialog.close();
  render();
}

async function saveOrder() {
  if (!refs.orderForm.reportValidity()) return;
  const formData = new FormData(refs.orderForm);
  const company = companyById(formData.get("companyId"));
  const recordId = String(formData.get("recordId") || "");
  const existingRecord = recordId ? state.records.find((item) => item.id === recordId && item.kind === "order") : null;
  if (recordId && !existingRecord) {
    window.alert("Order existing tak jumpa. Refresh sistem dan cuba semula.");
    return;
  }
  const details = collectDetails(formData);
  details.paymentMethod = String(formData.get("detail:paymentMethod") || details.paymentMethod || "").trim();
  if (company.id === "salam-land") {
    details.lotNo = canonicalSalamLotNo(details.lotNo);
    delete details.depositAmount;
    const lotEntry = salamLotCatalogEntry(details.lotNo);
    if (lotEntry) {
      details.projectLocation = details.projectLocation || cleanSalamProjectLabel(lotEntry.project) || inferSalamProjectLabel(lotEntry.lotNo, lotEntry.project, lotEntry.location);
      details.location = details.location || cleanSalamProjectLabel(lotEntry.location) || details.projectLocation;
      details.landPrice = details.landPrice || lotEntry.price || "";
      details.buyerSegment = details.buyerSegment || (lotEntry.buyerSegment === "Mixed" ? "Tidak pasti" : lotEntry.buyerSegment);
    }
  }
  const duplicate = findDuplicateOrder({
    companyId: company.id,
    phone: formData.get("phone"),
    product: formData.get("product"),
    staff: formData.get("staff"),
    details,
    excludeId: recordId
  });
  if (duplicate) {
    renderOrderDuplicateState(duplicate);
    window.alert("Order yang sama sudah wujud. Tekan Edit order existing supaya data tak duplicate.");
    return;
  }

  let attachments = [];
  try {
    const orderFiles = orderAttachmentFiles();
    attachments = state.runtime.backendReady && state.session.authenticated
      ? await uploadAttachments(orderFiles, company.id, "order")
      : await readAttachments(orderFiles);
  } catch (error) {
    pushRuntimeError(error.message || "Lampiran order gagal diproses.");
    saveState();
    window.alert(error.message || "Lampiran order gagal diproses.");
    return;
  }
  const orderUnits = numeric(formData.get("units")) || numeric(details.quantity || details.grams || 0);
  const detailOrderValue = orderGrossValue(details, 0);
  const discountValue = orderDiscountValue(details, detailOrderValue);
  const netOrderValue = Math.max(0, detailOrderValue - discountValue);
  const orderValue = company.id === "salam-land" ? netOrderValue : numeric(formData.get("value")) || netOrderValue;
  if (detailOrderValue || discountValue) {
    details.grossValue = detailOrderValue;
    details.discountAmount = discountValue;
    details.netValue = orderValue;
  }

  if (company.id === "salam-land") {
    if (!String(details.lotNo || "").trim()) {
      window.alert("Untuk Salam Land, lot tanah wajib diisi supaya tak duplicate dan senang semak lot booking.");
      return;
    }
    if (!String(details.projectLocation || details.location || "").trim()) {
      window.alert("Untuk Salam Land, nama projek wajib dipilih supaya booking board jelas lot itu projek mana.");
      return;
    }
    if (!orderValue) {
      window.alert("Harga lot / value wajib diisi supaya payment fasa dan report sales tepat.");
      return;
    }
  }

  const legacyPaid = numeric(details.paidAmount)
    || numeric(details.designDeposit)
      + numeric(details.bookingAmount)
      + (company.id !== "salam-land" && numeric(details.depositAmount) && numeric(details.depositAmount) !== numeric(details.bookingAmount) ? numeric(details.depositAmount) : 0)
      + numeric(details.installmentAmount)
      + numeric(details.finalPaymentAmount);
  let paymentSchedule = collectPaymentSchedule();

  if (!paymentSchedule.length && legacyPaid) {
    paymentSchedule = normalizePaymentSchedule([
      {
        id: createId("pay"),
        label: details.designDeposit ? "Design deposit" : details.bookingAmount ? "Booking" : details.depositAmount ? "Deposit" : details.finalPaymentAmount ? "Final payment" : "Paid amount",
        amount: legacyPaid,
        paymentDate: existingRecord?.createdAt || todayIso(),
        method: details.paymentMethod || "Bank transfer",
        reference: details.paymentReference || "",
        remark: "Auto from paid amount"
      }
    ]);
  }

  if (paymentSchedule.some((phase) => numeric(phase.amount) <= 0)) {
    window.alert("Setiap payment phase mesti ada amount lebih daripada RM0.");
    return;
  }
  if (paymentSchedule.some((phase) => !phase.paymentDate)) {
    window.alert("Setiap payment phase mesti ada Payment date sebenar. Kalau client belum bayar, jangan tambah phase itu dulu.");
    return;
  }

  const paymentSummary = summarizePaymentSchedule(paymentSchedule, orderValue);
  if (paymentSchedule.length) {
    details.paymentSchedule = paymentSummary.schedule;
    details.totalPaid = paymentSummary.totalPaid;
    details.balanceDue = paymentSummary.balance;
    details.lastPaymentDate = paymentSummary.lastPaymentDate;
    details.lastPaymentAmount = paymentSummary.lastPaymentAmount;
    details.lastPaymentLabel = paymentSummary.lastPaymentLabel;
    details.paymentCount = paymentSummary.paymentCount;
    details.paymentStatus = paymentSummary.paymentStatus;
    delete details.nextPaymentDate;
    delete details.nextPaymentAmount;
    delete details.nextPaymentLabel;
    delete details.overdueCount;
  } else {
    details.totalPaid = legacyPaid;
    details.balanceDue = Math.max(0, orderValue - legacyPaid);
    details.paymentStatus = orderValue && details.balanceDue <= 0 ? "Paid" : legacyPaid > 0 ? "Partial" : (details.paymentStatus || "Unpaid");
  }
  delete details.nextPaymentDate;
  delete details.nextPaymentAmount;
  delete details.nextPaymentLabel;
  delete details.overdueCount;

  if (company.id === "salam-land") {
    const icFrontName = refs.orderIcFrontInput?.files?.[0]?.name || "";
    const icBackName = refs.orderIcBackInput?.files?.[0]?.name || "";
    if (icFrontName) details.icFrontRef = `Camera upload: ${icFrontName}`;
    if (icBackName) details.icBackRef = `Camera upload: ${icBackName}`;
  }

  const order = {
    ...(existingRecord || {}),
    id: existingRecord?.id || createId("rec"),
    kind: "order",
    companyId: company.id,
    customerName: String(formData.get("customerName")).trim(),
    phone: String(formData.get("phone")).trim(),
    source: existingRecord?.source || "CRM Manual",
    campaignId: existingRecord?.campaignId || "",
    staff: formData.get("staff"),
    product: formData.get("product"),
    status: formData.get("status"),
    createdAt: existingRecord?.createdAt || todayIso(),
    updatedAt: new Date().toISOString(),
    nextFollowUp: "",
    value: orderValue,
    units: orderUnits,
    details,
    attachments: [...(existingRecord?.attachments || []), ...attachments],
    notes: cleanOrderNoteText(formData.get("notes") || "")
  };

  state.records = existingRecord
    ? state.records.map((record) => (record.id === existingRecord.id ? order : record))
    : [order, ...state.records];
  logActivity({
    action: existingRecord ? "Order updated" : "Order saved",
    companyId: company.id,
    detail: `${order.customerName} / ${order.product} / ${formatCurrency(order.value)} / ${details.paymentStatus || "No payment status"} / paid ${formatCurrency(details.totalPaid || 0)}`
  });
  await persistState();
  refs.orderDialog.close();
  render();
}

async function cancelOrderForRefund(recordId = "") {
  const record = state.records.find((item) => item.id === recordId && item.kind === "order");
  if (!record || !canEditRecord(record)) return;
  if (isCancelledRefund(record)) {
    window.alert("Order ini sudah berada dalam status Cancelled / Refund.");
    return;
  }

  const payment = paymentSnapshot(record);
  const suggestedRefund = payment.paid || numeric(record.details?.bookingAmount) || 0;
  const confirmed = window.confirm(
    `Cancel / refund order ini?\n\n${record.customerName || record.phone || "Customer"}\n${record.product || "Order"}\nRefund cadangan: ${formatCurrency(suggestedRefund)}\n\nRekod tidak akan dipadam terus. Sistem akan archive supaya audit payment masih selamat.`
  );
  if (!confirmed) return;

  const refundInput = window.prompt("Masukkan refund amount (RM). Boleh ubah kalau refund bukan full amount.", String(suggestedRefund || ""));
  if (refundInput === null) return;
  const refundAmount = numeric(refundInput);
  const reason = window.prompt("Remark ringkas sebab cancel/refund:", "Customer cancel booking") || "Customer cancel booking";
  const now = new Date().toISOString();
  const details = {
    ...(record.details || {}),
    refundStatus: REFUNDED_PAYMENT_STATUS,
    refundAmount,
    refundDate: todayIso(),
    cancelReason: reason.trim(),
    cancelledAt: now,
    cancelledBy: activeProfile().name || state.session.user?.name || "CRM user",
    previousStatus: record.status,
    paymentStatus: REFUNDED_PAYMENT_STATUS,
    balanceDue: 0
  };

  const noteLine = `Cancel/refund ${todayIso()}: ${reason.trim()}${refundAmount ? ` / refund ${formatCurrency(refundAmount)}` : ""}`;
  const existingNotes = cleanOrderNoteText(record.notes || "");
  const updatedRecord = {
    ...record,
    status: CANCELLED_REFUND_STATUS,
    nextFollowUp: "",
    updatedAt: now,
    details,
    notes: cleanOrderNoteText(existingNotes ? `${existingNotes}\n${noteLine}` : noteLine)
  };

  state.records = state.records.map((item) => (item.id === record.id ? updatedRecord : item));
  logActivity({
    action: "Order cancelled / refund archived",
    companyId: record.companyId,
    detail: `${record.customerName || record.phone || "Order"} / ${record.staff || "-"} / ${formatCurrency(refundAmount)} / ${reason.trim()}`
  });
  await persistState();
  refs.detailDialog?.close();
  render();
}

async function saveCampaign() {
  if (!refs.campaignForm.reportValidity()) return;
  const formData = new FormData(refs.campaignForm);
  const adsManagerLeadsInput = String(formData.get("adsManagerLeads") || "").trim();
  const campaign = {
    id: createId("camp"),
    companyId: formData.get("companyId"),
    platform: formData.get("platform"),
    name: String(formData.get("name")).trim(),
    spend: numeric(formData.get("spend")),
    ...(adsManagerLeadsInput ? { adsManagerLeads: numeric(adsManagerLeadsInput) } : {}),
    createdAt: todayIso()
  };

  state.campaigns = [campaign, ...state.campaigns];
  logActivity({
    action: "Campaign spend saved",
    companyId: campaign.companyId,
    detail: `${campaign.platform} / ${campaign.name} / ${formatCurrency(campaign.spend)}`
  });
  await persistState();
  refs.campaignDialog.close();
  render();
}

async function saveIntegrationSettings() {
  if (!refs.integrationForm.reportValidity()) return;
  const formData = new FormData(refs.integrationForm);
  const companyId = String(formData.get("companyId"));
  const company = companyById(companyId);
  const nextConnections = state.integrations.connections.map((connection) => {
    if (connection.companyId !== companyId) return connection;
    return {
      ...connection,
      metaEnabled: String(formData.get("metaEnabled")) === "true",
      metaPageId: String(formData.get("metaPageId") || "").trim(),
      metaAdAccountId: String(formData.get("metaAdAccountId") || "").replace(/^act_/i, "").replace(/[^\d]/g, "").trim(),
      metaFormIds: String(formData.get("metaFormIds") || "").trim(),
      metaCampaignId: String(formData.get("metaCampaignId") || "").trim(),
      metaSpendSyncEnabled: String(formData.get("metaSpendSyncEnabled")) === "true",
      metaAccessToken: String(formData.get("metaAccessToken") || "").trim(),
      metaSpendAccessToken: String(formData.get("metaSpendAccessToken") || "").trim(),
      metaDefaultStaff: String(formData.get("metaDefaultStaff") || company.staff[0] || "").trim(),
      metaLeadStatus: String(formData.get("metaLeadStatus") || "New Lead"),
      tiktokEnabled: String(formData.get("tiktokEnabled")) === "true",
      tiktokAdvertiserId: String(formData.get("tiktokAdvertiserId") || "").trim(),
      tiktokFormIds: String(formData.get("tiktokFormIds") || "").trim(),
      tiktokCampaignId: String(formData.get("tiktokCampaignId") || "").trim(),
      tiktokSpendSyncEnabled: String(formData.get("tiktokSpendSyncEnabled")) === "true",
      tiktokLeadMode: String(formData.get("tiktokLeadMode") || "instant-form"),
      tiktokCallbackToken: String(formData.get("tiktokCallbackToken") || "").trim(),
      tiktokAccessToken: String(formData.get("tiktokAccessToken") || "").trim(),
      tiktokDefaultStaff: String(formData.get("tiktokDefaultStaff") || company.staff[0] || "").trim(),
      tiktokLeadStatus: String(formData.get("tiktokLeadStatus") || "New Lead"),
      notes: String(formData.get("notes") || "").trim()
    };
  });

  state.integrations = mergeIntegrations({
    ...state.integrations,
    publicBaseUrl: String(formData.get("publicBaseUrl") || "").trim(),
    meta: {
      ...state.integrations.meta,
      verifyToken: String(formData.get("metaVerifyToken") || "").trim() || state.integrations.meta.verifyToken,
      apiVersion: String(formData.get("metaApiVersion") || "").trim() || "v22.0"
    },
    tiktok: {
      ...state.integrations.tiktok,
      callbackToken: String(formData.get("tiktokCallbackToken") || "").trim() || state.integrations.tiktok.callbackToken
    },
    connections: nextConnections
  });

  logActivity({
    action: "Integration settings updated",
    companyId,
    detail: `${company.name} / Meta ${String(formData.get("metaEnabled")) === "true" ? "On" : "Off"} / TikTok ${String(formData.get("tiktokEnabled")) === "true" ? "On" : "Off"}`
  });
  await persistIntegrations();
  refs.integrationDialog.close();
  render();
}

function exportBackup() {
  const payload = createBackupPayload();
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `crm-salam-fortress-${todayIso()}.json`;
  link.click();
  URL.revokeObjectURL(url);
  state.control.lastBackupAt = new Date().toISOString();
  logActivity({
    action: "Manual backup exported",
    detail: `Backup JSON dimuat turun untuk ${activeCompany().name}.`
  });
  saveState();
}

async function saveControlSettings() {
  if (!refs.controlForm.reportValidity()) return;
  const nextProfileId = state.runtime.backendReady && !hasGlobalAccess(state.session.user)
    ? state.session.user.profileId
    : refs.controlProfileInput.value;
  state.control = mergeControl({
    ...state.control,
    activeProfileId: nextProfileId,
    settings: {
      ...state.control.settings,
      defaultFollowUpDays: numeric(refs.controlFollowUpDaysInput.value) || 1,
      dedupeWindowDays: numeric(refs.controlDedupeDaysInput.value) || 45,
      reminderAheadDays: numeric(refs.controlReminderDaysInput.value) || 7,
      autoBackupEnabled: refs.controlAutoBackupInput.value === "true",
      backupRetentionDays: numeric(refs.controlBackupRetentionInput.value) || 14
    }
  });
  ensureAccessibleActiveCompany();
  logActivity({
    action: "Control centre updated",
    companyId: state.activeCompanyId,
    detail: `${activeProfile().name} aktif / dedupe ${state.control.settings.dedupeWindowDays} hari / follow-up +${state.control.settings.defaultFollowUpDays}`
  });
  await persistState();
  refs.controlDialog.close();
  render();
}

function applyRecordAction(record, actionId, value) {
  if (!record || !LEAD_ACTIONS.some((action) => action.id === actionId)) return false;
  const nextFlags = normalizeActionFlags(record.actionFlags, record);
  nextFlags[actionId] = Boolean(value);
  record.actionFlags = nextFlags;
  record.updatedAt = new Date().toISOString();

  if (nextFlags[actionId]) {
    const nextStatus = resolveStatusForAction(record, actionId);
    if (nextStatus) record.status = nextStatus;
    if (actionId === "followUpSet" && record.kind === "lead") {
      record.nextFollowUp = record.nextFollowUp || isoOffsetFromDate(recordDateKey(record), FOLLOW_UP_DAYS);
    }
    if (["booking", "closed", "rejected"].includes(actionId)) {
      record.nextFollowUp = "";
    }
  }

  return true;
}

async function toggleRecordAction(recordId, actionId) {
  const record = state.records.find((item) => item.id === recordId);
  if (!record) return;
  if (!canEditRecord(record)) return;
  const flags = normalizeActionFlags(record.actionFlags, record);
  if (!applyRecordAction(record, actionId, !flags[actionId])) return;
  await persistRecordStatus(record);
  render();
}

async function updateRecordStatus(recordId, nextStatus) {
  const record = state.records.find((item) => item.id === recordId);
  if (!record || !canEditRecord(record)) return;
  const company = companyById(record.companyId);
  if (!company.statuses.includes(nextStatus) || record.status === nextStatus) return;
  if (record.kind === "order" && nextStatus === CANCELLED_REFUND_STATUS) {
    await cancelOrderForRefund(recordId);
    render();
    return;
  }

  const previousRecord = JSON.parse(JSON.stringify(record));
  const previousStatus = record.status;
  record.status = nextStatus;
  record.actionFlags = normalizeActionFlags(record.actionFlags, record);
  if (nextStatus === "WS Sent" || nextStatus === "Dihubungi") record.actionFlags.wsSent = true;
  if (nextStatus === "Reply") record.actionFlags.reply = true;
  if (nextStatus === "Tak Jawab") {
    record.actionFlags.wsSent = true;
    record.actionFlags.noAnswer = true;
  }
  if (nextStatus === "Site Visit") record.actionFlags.siteVisit = true;
  if (nextStatus === "Booking" || nextStatus === "Deposit") record.actionFlags.booking = true;
  if (company.closedStatuses.includes(nextStatus)) {
    record.actionFlags.closed = true;
    record.nextFollowUp = "";
  }
  if (company.lostStatuses.includes(nextStatus)) {
    record.actionFlags.rejected = true;
    record.nextFollowUp = "";
  }
  if (record.kind === "lead" && isOpen(record) && !record.nextFollowUp) {
    record.nextFollowUp = isoOffsetFromDate(recordDateKey(record), FOLLOW_UP_DAYS);
  }

  logActivity({
    action: "Status updated",
    companyId: record.companyId,
    detail: `${record.customerName || record.phone || "Record"} / ${record.staff} / ${previousStatus} -> ${nextStatus}`
  });
  renderRecordTable();

  try {
    await persistRecordStatus(record);
    render();
  } catch (error) {
    Object.assign(record, previousRecord);
    pushRuntimeError(`Status gagal disimpan: ${error.message || "Server update failed"}`);
    window.alert("Status tak berjaya disimpan ke server. Saya dah kekalkan data asal supaya tak nampak palsu. Refresh dan cuba semula.");
    render();
  }
}

function openWhatsApp(recordId, type) {
  const record = state.records.find((item) => item.id === recordId);
  if (!record) return;
  const company = companyById(record.companyId);
  const staffTemplates = company.staffFollowUpMessages || {};
  const template = type === "blast" ? company.blastMessage : (staffTemplates[record.staff] || company.followUpMessage);
  window.open(whatsappUrl(record, replaceTokens(template, record)), "_blank", "noopener,noreferrer");
  const previousRecord = JSON.parse(JSON.stringify(record));
  if (applyRecordAction(record, "wsSent", true)) {
    if (company.statuses.includes("WS Sent") && ["New Lead", "Bluetick"].includes(record.status)) {
      record.status = "WS Sent";
      record.updatedAt = new Date().toISOString();
    }
    persistRecordStatus(record)
      .then(() => render())
      .catch((error) => {
        Object.assign(record, previousRecord);
        pushRuntimeError(`WS Sent gagal disimpan: ${error.message || "Server update failed"}`);
        window.alert("WhatsApp sudah dibuka, tapi status WS Sent gagal disimpan ke server. Sila refresh dan cuba tukar status semula.");
        renderRecordTable();
      });
  }
}

refs.companyRail.addEventListener("click", (event) => {
  const button = event.target.closest("[data-company-id]");
  if (!button) return;
  state.activeCompanyId = button.dataset.companyId;
  state.activeSectionId = "overviewSection";
  state.statusFilter = "all";
  state.kindFilter = "all";
  state.staffFilter = "all";
  state.sourceFilter = "all";
  state.actionFilter = "all";
  state.dateFilter = "all";
  state.search = "";
  state.leadMonthFilter = currentMonthValue();
  state.leadDateFilter = todayIso();
  state.lotStatusFilter = "all";
  state.lotSearch = "";
  state.lotFocusLotNo = "";
  refs.kindFilter.value = "all";
  if (refs.actionFilter) refs.actionFilter.value = "all";
  refs.searchInput.value = "";
  if (refs.leadMonthInput) refs.leadMonthInput.value = state.leadMonthFilter;
  if (refs.leadDateInput) refs.leadDateInput.value = state.leadDateFilter;
  if (refs.lotStatusFilter) refs.lotStatusFilter.value = "all";
  if (refs.lotSearchInput) refs.lotSearchInput.value = "";
  render();
  if (state.activeCompanyId === "barakah-emas") {
    fetchGoldRates();
  }
});

document.querySelectorAll("[data-period]").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll("[data-period]").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    state.period = button.dataset.period;
    renderStaffBoard();
    renderOrderBoard();
  });
});

refs.kindFilter.addEventListener("change", (event) => {
  state.kindFilter = event.target.value;
  renderRecordTable();
});

refs.statusFilter.addEventListener("change", (event) => {
  state.statusFilter = event.target.value;
  renderDateDrilldown();
  renderRecordTable();
});

refs.staffFilter.addEventListener("change", (event) => {
  state.staffFilter = event.target.value;
  renderDateDrilldown();
  renderPaymentBoard();
  renderRecordTable();
});

refs.sourceFilter.addEventListener("change", (event) => {
  state.sourceFilter = event.target.value;
  renderRecordTable();
});

refs.actionFilter?.addEventListener("change", (event) => {
  state.actionFilter = event.target.value;
  renderRecordTable();
});

refs.dateFilter.addEventListener("change", (event) => {
  state.dateFilter = event.target.value;
  renderRecordTable();
});

refs.searchInput.addEventListener("input", (event) => {
  state.search = event.target.value;
  window.clearTimeout(searchRenderTimer);
  searchRenderTimer = window.setTimeout(() => {
    renderRecordTable();
  }, 140);
});

refs.leadMonthInput?.addEventListener("change", (event) => {
  state.leadMonthFilter = event.target.value || currentMonthValue();
  state.leadDateFilter = state.leadMonthFilter === currentMonthValue() ? todayIso() : `${state.leadMonthFilter}-01`;
  renderDateDrilldown();
});

refs.leadDateInput?.addEventListener("change", (event) => {
  state.leadDateFilter = event.target.value || todayIso();
  state.leadMonthFilter = state.leadDateFilter.slice(0, 7);
  renderDateDrilldown();
});

refs.lotStatusFilter?.addEventListener("change", (event) => {
  state.lotStatusFilter = event.target.value;
  renderSalamLotBoard();
});

refs.lotSearchInput?.addEventListener("input", (event) => {
  state.lotSearch = event.target.value;
  if (!state.lotSearch.trim()) {
    state.lotFocusLotNo = "";
  } else {
    const exactMatch = buildSalamLotBoardEntries().find((entry) => entry.lotNo.toLowerCase() === state.lotSearch.trim().toLowerCase());
    state.lotFocusLotNo = exactMatch?.lotNo || state.lotFocusLotNo;
  }
  window.clearTimeout(searchRenderTimer);
  searchRenderTimer = window.setTimeout(() => {
    renderSalamLotBoard();
  }, 140);
});

refs.leadCompanyInput.addEventListener("change", updateLeadForm);
refs.leadPhoneInput.addEventListener("input", renderLeadDuplicateState);
refs.orderCompanyInput.addEventListener("change", updateOrderForm);
refs.orderProductInput.addEventListener("change", () => {
  const detailProduct = refs.orderQuickFields.querySelector('[name="detail:product"]');
  if (detailProduct) {
    detailProduct.value = refs.orderProductInput.value;
  }
  syncBarakahOrderRate();
  renderPaymentScheduleSummary();
  checkCurrentOrderDuplicate();
});
refs.orderQuickFields.addEventListener("change", (event) => {
  if (event.target.name === "detail:product") {
    refs.orderProductInput.value = event.target.value;
  }
  if (event.target.name === "detail:lotNo") {
    syncSalamLotSelection();
  }
  syncBarakahOrderRate();
  renderPaymentScheduleSummary();
  checkCurrentOrderDuplicate();
});
refs.orderForm.addEventListener("input", (event) => {
  if (event.target.closest("#paymentScheduleRows") || event.target.name === "value" || event.target.name?.startsWith("detail:")) {
    renderPaymentScheduleSummary();
  }
  if (["phone", "product", "staff"].includes(event.target.name) || event.target.name?.startsWith("detail:")) {
    window.clearTimeout(searchRenderTimer);
    searchRenderTimer = window.setTimeout(checkCurrentOrderDuplicate, 180);
  }
});
refs.paymentScheduleRows?.addEventListener("change", (event) => {
  renderPaymentScheduleSummary();
});
refs.paymentScheduleRows?.addEventListener("click", (event) => {
  const removeButton = event.target.closest("[data-remove-payment-phase]");
  if (!removeButton) return;
  renderPaymentScheduleRows(collectPaymentSchedule().filter((phase) => phase.id !== removeButton.dataset.removePaymentPhase));
});
refs.addPaymentPhaseButton?.addEventListener("click", () => addPaymentPhase());
refs.importPaymentScheduleButton?.addEventListener("click", autoSetupPaymentSchedule);
refs.pastePaymentScheduleButton?.addEventListener("click", importPaymentScheduleFromText);
refs.reportCompanyInput.addEventListener("change", updateReportForm);
refs.reportScopeInput.addEventListener("change", updateReportForm);
refs.reportMonthInput.addEventListener("change", updateReportForm);
refs.reportDateFromInput.addEventListener("change", updateReportForm);
refs.reportDateToInput.addEventListener("change", updateReportForm);
refs.reportStaffInput.addEventListener("change", updateReportForm);
refs.controlProfileInput.addEventListener("change", updateControlDialogPreview);
refs.controlFollowUpDaysInput.addEventListener("input", updateControlDialogPreview);
refs.controlDedupeDaysInput.addEventListener("input", updateControlDialogPreview);
refs.controlReminderDaysInput.addEventListener("input", updateControlDialogPreview);
refs.integrationCompanyInput.addEventListener("change", () => {
  fillIntegrationConnectionFields(refs.integrationCompanyInput.value);
  updateIntegrationForm();
});
refs.integrationBaseUrlInput.addEventListener("input", updateIntegrationForm);
refs.whatsappForm?.addEventListener("input", updateWhatsAppSettingsPreview);

document.querySelector("#authButton").addEventListener("click", () => {
  if (state.session.authenticated) {
    signOut();
    return;
  }
  openLoginDialog();
});
refs.entryLoginButton?.addEventListener("click", () => openLoginDialog());
document.querySelector("#controlButton").addEventListener("click", openControlDialog);
document.querySelector("#leadButton").addEventListener("click", openLeadDialog);
document.querySelector("#orderButton").addEventListener("click", openOrderDialog);
document.querySelector("#campaignButton").addEventListener("click", openCampaignDialog);
document.querySelector("#reportButton").addEventListener("click", openReportDialog);
refs.reportInlineButton?.addEventListener("click", openReportDialog);
document.querySelector("#integrationButton").addEventListener("click", openIntegrationDialog);
refs.notificationButton?.addEventListener("click", () => {
  requestLeadNotificationPermission().catch((error) => {
    window.alert(error.message || "Notification gagal diaktifkan.");
    syncNotificationButton();
  });
});
refs.themeToggleButton?.addEventListener("click", () => {
  if (!canUsePremiumTheme()) return;
  const nextMode = currentThemeMode() === "dark" ? "light" : "dark";
  state.control = mergeControl({
    ...state.control,
    settings: {
      ...state.control.settings,
      themeMode: nextMode
    }
  });
  persistState().then(() => render()).catch(() => render());
});
refs.notificationStaffOptions?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-notification-staff]");
  if (!button) return;
  closeNotificationStaffDialog(button.dataset.notificationStaff || "");
  syncNotificationButton();
});
document.querySelectorAll("[data-close-notification-staff]").forEach((button) => {
  button.addEventListener("click", () => {
    closeNotificationStaffDialog("");
    syncNotificationButton();
  });
});
refs.notificationStaffDialog?.addEventListener("close", () => {
  if (!notificationStaffResolve) return;
  const resolver = notificationStaffResolve;
  notificationStaffResolve = null;
  resolver(refs.notificationStaffDialog.returnValue || "");
});
refs.loginForm.addEventListener("submit", (event) => {
  event.preventDefault();
  signIn();
});
document.querySelectorAll("[data-close-login]").forEach((button) => {
  button.addEventListener("click", () => {
    refs.loginDialog.close();
  });
});
document.querySelectorAll("[data-close-detail]").forEach((button) => {
  button.addEventListener("click", () => {
    refs.detailDialog?.close();
  });
});
document.querySelector("#saveControlButton").addEventListener("click", saveControlSettings);
document.querySelector("#saveLeadButton").addEventListener("click", saveLead);
document.querySelector("#saveOrderButton").addEventListener("click", saveOrder);
document.querySelector("#saveCampaignButton").addEventListener("click", saveCampaign);
document.querySelector("#downloadReportButton").addEventListener("click", downloadReportPdf);
document.querySelector("#saveIntegrationButton").addEventListener("click", saveIntegrationSettings);
document.querySelector("#saveWhatsAppButton")?.addEventListener("click", saveWhatsAppSettings);
document.querySelector("#sendWhatsAppTestButton")?.addEventListener("click", sendWhatsAppTestMessage);
document.querySelector("#registerWhatsAppNumberButton")?.addEventListener("click", registerWhatsAppCloudNumber);
document.querySelector("#exportButton").addEventListener("click", exportBackup);

document.body.addEventListener("click", (event) => {
  const closeDetailButton = event.target.closest("[data-close-detail]");
  if (closeDetailButton) {
    refs.detailDialog?.close();
    return;
  }
  const editOrderButton = event.target.closest("[data-edit-order-id]");
  if (editOrderButton) {
    refs.detailDialog?.close();
    openOrderEditor(editOrderButton.dataset.editOrderId);
    return;
  }
  const cancelOrderButton = event.target.closest("[data-cancel-order-id]");
  if (cancelOrderButton) {
    cancelOrderForRefund(cancelOrderButton.dataset.cancelOrderId || "");
    return;
  }
  const viewRecordButton = event.target.closest("[data-view-record-id]");
  if (viewRecordButton) {
    openRecordDetail(viewRecordButton.dataset.viewRecordId || "");
    return;
  }
  const lotDetailButton = event.target.closest("[data-lot-detail]");
  if (lotDetailButton) {
    openLotDetail(lotDetailButton.dataset.lotDetail || "");
    return;
  }
  const reportDialogButton = event.target.closest("[data-open-report-dialog]");
  if (reportDialogButton) {
    openReportDialog();
    return;
  }
  const teamSpendDownloadButton = event.target.closest("[data-download-team-spend-daily]");
  if (teamSpendDownloadButton) {
    downloadTeamSpendDailySpend();
    return;
  }
  const teamSpendSyncButton = event.target.closest("[data-sync-team-spend]");
  if (teamSpendSyncButton) {
    teamSpendSyncButton.disabled = true;
    const originalText = teamSpendSyncButton.textContent;
    teamSpendSyncButton.textContent = "Syncing...";
    syncCurrentTeamSpendReport()
      .catch((error) => {
        pushRuntimeError(`Ads spend sync gagal: ${error.message}`);
        renderReportCenter();
      })
      .finally(() => {
        teamSpendSyncButton.disabled = false;
        teamSpendSyncButton.textContent = originalText || "Sync Ads Manager spend";
      });
    return;
  }
  const sectionButton = event.target.closest("[data-section-target]");
  if (sectionButton) {
    const sectionId = sectionButton.dataset.sectionTarget;
    if (WORKSPACE_SECTIONS.some((section) => section.id === sectionId)) {
      state.activeSectionId = sectionId;
      render();
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
    return;
  }
  const calendarButton = event.target.closest("[data-calendar-date]");
  if (calendarButton) {
    state.leadDateFilter = calendarButton.dataset.calendarDate;
    state.leadMonthFilter = state.leadDateFilter.slice(0, 7);
    renderDateDrilldown();
    return;
  }
  const dateRecordFilterButton = event.target.closest("[data-date-record-filter]");
  if (dateRecordFilterButton) {
    applySelectedDateRecordFilter(dateRecordFilterButton.dataset.dateRecordFilter || "all");
    return;
  }
  const goldRefreshButton = event.target.closest("[data-gold-refresh]");
  if (goldRefreshButton) {
    fetchGoldRates(true);
    return;
  }
  const controlButton = event.target.closest("[data-open-control]");
  if (controlButton) {
    openControlDialog();
    return;
  }
  const whatsappSettingsButton = event.target.closest("[data-open-whatsapp-settings]");
  if (whatsappSettingsButton) {
    openWhatsAppSettingsDialog();
    return;
  }
  const lotActionButton = event.target.closest("[data-lot-action][data-lot-no]");
  if (lotActionButton) {
    refs.detailDialog?.close();
    openSalamLotTemplate(lotActionButton.dataset.lotNo || "", lotActionButton.dataset.lotAction || "booking");
    return;
  }
  const actionButton = event.target.closest("[data-action-record-id]");
  if (actionButton) {
    toggleRecordAction(actionButton.dataset.actionRecordId, actionButton.dataset.actionId)
      .catch((error) => {
        pushRuntimeError(`Action gagal disimpan: ${error.message || "Server update failed"}`);
        window.alert("Update action tak berjaya disimpan ke server. Refresh dan cuba semula.");
        renderRecordTable();
      });
    return;
  }
  const button = event.target.closest("[data-wa-id]");
  if (!button) return;
  openWhatsApp(button.dataset.waId, button.dataset.waType);
});

document.body.addEventListener("change", (event) => {
  const teamSpendFilter = event.target.closest("[data-team-spend-filter]");
  if (teamSpendFilter) {
    const key = teamSpendFilter.dataset.teamSpendFilter;
    state.teamSpendReport = {
      ...state.teamSpendReport,
      [key]: teamSpendFilter.value,
      showDetails: key === "showDetails" ? state.teamSpendReport.showDetails : false
    };
    if (key === "scope" && teamSpendFilter.value === "month") {
      state.teamSpendReport.month = state.teamSpendReport.month || currentMonthValue();
    }
    if (key === "scope" && teamSpendFilter.value !== "month") {
      state.teamSpendReport.dateFrom = state.teamSpendReport.dateFrom || todayIso();
      state.teamSpendReport.dateTo = state.teamSpendReport.dateTo || todayIso();
    }
    renderReportCenter();
    return;
  }
  const statusSelect = event.target.closest("[data-status-record-id]");
  if (!statusSelect) return;
  updateRecordStatus(statusSelect.dataset.statusRecordId, statusSelect.value);
});

window.addEventListener("resize", syncPreviewMode);
window.addEventListener("scroll", queueSectionSync, { passive: true });

async function initApp() {
  syncPreviewMode();
  loadState();
  loadSessionState();
  await hydrateFromApi();
  ensureAccessibleActiveCompany();
  scheduleGoldRatesRefresh();
  startLiveStatePolling();
  render();
  if (state.runtime.backendReady && !state.session.authenticated) {
    openLoginDialog();
  }
  if (state.activeCompanyId === "barakah-emas" || state.runtime.backendReady) {
    fetchGoldRates();
  }
}

initApp();

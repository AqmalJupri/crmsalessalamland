const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const BACKUP_DIR = path.join(DATA_DIR, "backups");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const AUTH_FILE = path.join(DATA_DIR, "auth.json");
const STATE_FILE = path.join(DATA_DIR, "runtime.json");
const PUSH_SUBSCRIPTIONS_FILE = path.join(DATA_DIR, "push-subscriptions.json");
const PUSH_VAPID_FILE = path.join(DATA_DIR, "push-vapid.json");
const PORT = Number(process.env.PORT || 8765);
const HOST = process.env.HOST || "127.0.0.1";
const REQUEST_BODY_LIMITS = Object.freeze({
  json: 1024 * 1024,
  metaWebhook: 512 * 1024,
  tiktokWebhook: 2 * 1024 * 1024,
  whatsappWebhook: 2 * 1024 * 1024,
  state: 25 * 1024 * 1024,
  backfill: 25 * 1024 * 1024,
  uploads: 10 * 1024 * 1024
});
const GOLD_RATE_CACHE_MS = Number(process.env.GOLD_RATE_CACHE_MS || 30 * 60 * 1000);
const AUTO_BACKUP_INTERVAL_MS = Number(process.env.AUTO_BACKUP_INTERVAL_MS || 30 * 60 * 1000);
const META_LEAD_SYNC_INTERVAL_MS = Number(process.env.META_LEAD_SYNC_INTERVAL_MS || 3 * 60 * 1000);
const META_LEAD_SYNC_MAX_PAGES = Math.max(1, Number(process.env.META_LEAD_SYNC_MAX_PAGES || 20));
const META_GRAPH_API_BASE = String(process.env.META_GRAPH_API_BASE || "https://graph.facebook.com").replace(/\/+$/, "");
const META_APP_SECRET = String(process.env.META_APP_SECRET || "").trim();
const CRM_REQUIRE_WEBHOOK_SIGNATURES =
  String(process.env.CRM_REQUIRE_WEBHOOK_SIGNATURES || "").trim().toLowerCase() === "true";
const META_ALLOW_UNSIGNED_WEBHOOKS =
  process.env.NODE_ENV !== "production" &&
  !CRM_REQUIRE_WEBHOOK_SIGNATURES &&
  String(process.env.META_ALLOW_UNSIGNED_WEBHOOKS || "").trim().toLowerCase() === "true";
const TIKTOK_ALLOW_UNSIGNED_WEBHOOKS =
  process.env.NODE_ENV !== "production" &&
  !CRM_REQUIRE_WEBHOOK_SIGNATURES &&
  String(process.env.TIKTOK_ALLOW_UNSIGNED_WEBHOOKS || "").trim().toLowerCase() === "true";
const TIKTOK_DEFAULT_CALLBACK_TOKEN = "crm-salam-fortress-tiktok";
const ADS_SPEND_SYNC_INTERVAL_MS = Number(process.env.ADS_SPEND_SYNC_INTERVAL_MS || 30 * 60 * 1000);
const TIKTOK_BUSINESS_API_BASE = process.env.TIKTOK_BUSINESS_API_BASE || "https://business-api.tiktok.com";
const TIKTOK_REPORT_PAGE_SIZE = Math.min(1000, Math.max(50, Number(process.env.TIKTOK_REPORT_PAGE_SIZE || 1000)));
const TIKTOK_REPORT_MAX_PAGES = Math.max(1, Number(process.env.TIKTOK_REPORT_MAX_PAGES || 20));
const WHATSAPP_GRAPH_API_VERSION = process.env.WHATSAPP_GRAPH_API_VERSION || "v22.0";
const WHATSAPP_DEFAULT_ACCESS_TOKEN_ENV_KEY = "WHATSAPP_ACCESS_TOKEN";
const WHATSAPP_ALLOWED_STAFF = String(process.env.WHATSAPP_ALLOWED_STAFF || "Nureen")
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean);
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 30 * 24 * 60 * 60 * 1000);
const LOGIN_RATE_LIMIT_WINDOW_MS = Number(process.env.LOGIN_RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000);
const LOGIN_RATE_LIMIT_MAX_FAILS = Number(process.env.LOGIN_RATE_LIMIT_MAX_FAILS || 8);
const APP_TIME_ZONE = process.env.APP_TIME_ZONE || "Asia/Kuala_Lumpur";
const GLOBAL_ACCESS_ROLES = new Set(["admin", "boss"]);
const NOTIFICATION_ALL_STAFF = "__all__";
const TROY_OUNCE_IN_GRAMS = 31.1034768;
const GOLD_PURITY = {
  "999": 0.999,
  "916": 0.916
};
const goldRateCache = {
  data: null,
  fetchedAt: 0,
  promise: null
};

const COMPANY_DEFAULTS = {
  "salam-land": {
    defaultProduct: "Tanah Lot Semi D",
    defaultStaff: "Nureen",
    defaultStatus: "New Lead"
  },
  "bumi-hayat": {
    defaultProduct: "Futsal",
    defaultStaff: "Amy",
    defaultStatus: "New Lead"
  },
  "barakah-emas": {
    defaultProduct: "Emas 916",
    defaultStaff: "Nabilah",
    defaultStatus: "New Lead"
  }
};

const VALID_RECORD_STATUSES = new Set([
  "New Lead",
  "Bluetick",
  "WS Sent",
  "Reply",
  "Tak Jawab",
  "Dihubungi",
  "Qualified",
  "Site Visit",
  "Quotation",
  "Deposit",
  "Production",
  "Delivered",
  "Product Suggested",
  "Appointment",
  "Payment",
  "Booking",
  "Closed",
  "Cancelled / Refund",
  "Duplicate Lead",
  "Lost"
]);

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

const ACCESS_COMPANIES = [
  { id: "salam-land", name: "Salam Land Development", staff: COMPANY_TEAM_DIRECTORY["salam-land"].staff.slice() },
  { id: "bumi-hayat", name: "Bumi Hayat Printing", staff: COMPANY_TEAM_DIRECTORY["bumi-hayat"].staff.slice() },
  { id: "barakah-emas", name: "Barakah Emas", staff: COMPANY_TEAM_DIRECTORY["barakah-emas"].staff.slice() }
];

const DEFAULT_LOGIN_PASSWORD = "Fortress@123";
const authSessions = new Map();
const loginFailures = new Map();
let metaLeadSyncRunning = false;
let adsSpendSyncRunning = false;

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml"
};

function securityHeaders(extra = {}) {
  return {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "SAMEORIGIN",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(self), microphone=(), geolocation=(), payment=()",
    "X-Robots-Tag": "noindex, nofollow",
    ...extra
  };
}

function clientIp(req) {
  return String(req.headers["x-forwarded-for"] || "")
    .split(",")[0]
    .trim() || req.socket?.remoteAddress || "local";
}

function loginFailureKey(req, username) {
  return `${clientIp(req)}:${String(username || "").toLowerCase()}`;
}

function pruneLoginFailures(now = Date.now()) {
  for (const [key, entry] of loginFailures.entries()) {
    if (!entry?.firstAt || now - entry.firstAt > LOGIN_RATE_LIMIT_WINDOW_MS) {
      loginFailures.delete(key);
    }
  }
}

function isLoginRateLimited(req, username) {
  pruneLoginFailures();
  const entry = loginFailures.get(loginFailureKey(req, username));
  return Boolean(entry && entry.count >= LOGIN_RATE_LIMIT_MAX_FAILS);
}

function recordLoginFailure(req, username) {
  const now = Date.now();
  const key = loginFailureKey(req, username);
  const entry = loginFailures.get(key);
  if (!entry || now - entry.firstAt > LOGIN_RATE_LIMIT_WINDOW_MS) {
    loginFailures.set(key, { count: 1, firstAt: now });
    return;
  }
  entry.count += 1;
}

function clearLoginFailures(req, username) {
  loginFailures.delete(loginFailureKey(req, username));
}

function createId(prefix = "id") {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
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
  if (role === "company") return COMPANY_TEAM_DIRECTORY[companyId]?.loginUsername || slugify(companyId);
  return slugify(staffName);
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

const FOLLOW_UP_DAYS = 14;
const LEAD_ACTION_IDS = ["wsSent", "bluetick", "reply", "callDone", "noAnswer", "interested", "followUpSet", "siteVisit", "booking", "closed", "rejected"];
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

function normalizeSalamProductName(companyId, value = "", ...hints) {
  if (companyId !== "salam-land") return value;
  const text = [value, ...hints].filter(Boolean).join(" ").toLowerCase();
  if (/kedai|shop|commercial/.test(text)) return "Lot Kedai";
  if (/banglo|bungalow/.test(text)) return "Tanah Banglo";
  return "Tanah Lot Semi D";
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

function normalizeActionFlags(flags = {}, record = {}) {
  const source = flags && typeof flags === "object" ? flags : {};
  const status = String(record.status || "");
  return Object.fromEntries(LEAD_ACTION_IDS.map((id) => {
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
  if (record.companyId === "salam-land" && currentFollowUp === legacyOneDay) return expectedFourteenDay;
  return currentFollowUp;
}

function normalizeRecordDateCandidate(value = "") {
  if (value === undefined || value === null || value === "") return "";
  const textValue = String(value).trim();
  const hasTime = /\d{1,2}:\d{2}/.test(textValue);
  const hasTimezone = /\b(?:UTC|GMT)\b|Z$|[+-]\d{2}:?\d{2}\)?$/.test(textValue);
  if (hasTime && hasTimezone) {
    const normalizedTimestamp = textValue
      .replace(/\((?:UTC|GMT)([+-]\d{2}:?\d{2})\)/i, "$1")
      .replace(/\s*(?:UTC|GMT)\s*([+-]\d{2}:?\d{2})\b/i, "$1")
      .replace(/\s+/, "T")
      .replace(/\s+/g, "")
      .replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
    const parsedTimestamp = new Date(normalizedTimestamp);
    if (Number.isFinite(parsedTimestamp.getTime())) {
      return localIsoDate(parsedTimestamp);
    }
  }
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
    const isoDate = normalizeRecordDateCandidate(candidate);
    if (isoDate) return isoDate;
  }
  return localIsoDate(new Date());
}

function normalizeRecordList(records = []) {
  return (Array.isArray(records) ? records : []).map((record) => ({
    ...record,
    createdAt: String(record.createdAt || localIsoDate(new Date())).slice(0, 10),
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

function buildAccessProfiles() {
  const profiles = [
    {
      profileId: "admin-root",
      username: profileUsername("admin"),
      name: "Afiq Admin",
      role: "admin",
      companyIds: ACCESS_COMPANIES.map((company) => company.id),
      companyId: "",
      staffName: "",
      title: "Super admin",
      note: "Akses semua company, publish layer dan settings."
    },
    {
      profileId: "boss-root",
      username: profileUsername("boss"),
      name: "Management Boss",
      role: "boss",
      companyIds: ACCESS_COMPANIES.map((company) => company.id),
      companyId: "",
      staffName: "",
      title: "Executive overview",
      note: "Akses semua company untuk tengok total leads, total sales dan dashboard executive."
    }
  ];

  ACCESS_COMPANIES.forEach((company) => {
    profiles.push({
      profileId: `company-${company.id}`,
      username: profileUsername("company", company.id),
      name: COMPANY_TEAM_DIRECTORY[company.id]?.accessName || company.name,
      role: "company",
      companyIds: [company.id],
      companyId: company.id,
      staffName: "",
      title: "Company workspace access",
      note: `Login terus ke workspace ${company.name} sambil kekalkan semua nama team sales dan assignment dalam company ini.`
    });
  });

  return profiles;
}

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 120000, 32, "sha256").toString("hex");
}

function createPasswordRecord(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  return {
    passwordSalt: salt,
    passwordHash: hashPassword(password, salt)
  };
}

function localIsoDate(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: APP_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function safeLocalIsoDate(value = new Date()) {
  if (value === undefined || value === null || value === "") return localIsoDate(new Date());
  const textValue = String(value || "").trim();
  const hasExplicitTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(textValue);
  if (hasExplicitTimezone) {
    let normalizedTimestamp = textValue
      .replace(/\s+/, "T")
      .replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
    const dmyTimestamp = normalizedTimestamp.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})T(.+)$/);
    if (dmyTimestamp) {
      const [, day, month, rawYear, timeAndTimezone] = dmyTimestamp;
      const year = rawYear.length === 2 ? `20${rawYear}` : rawYear;
      normalizedTimestamp = `${year.padStart(4, "0")}-${month.padStart(2, "0")}-${day.padStart(2, "0")}T${timeAndTimezone}`;
    }
    const parsedTimestamp = new Date(normalizedTimestamp);
    if (Number.isFinite(parsedTimestamp.getTime())) return localIsoDate(parsedTimestamp);
  }
  const dmyMatch = textValue.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (dmyMatch) {
    const [, day, month, rawYear, hour = "0", minute = "0", second = "0"] = dmyMatch;
    const year = rawYear.length === 2 ? `20${rawYear}` : rawYear;
    const parsed = new Date(`${year.padStart(4, "0")}-${month.padStart(2, "0")}-${day.padStart(2, "0")}T${hour.padStart(2, "0")}:${minute}:${second.padStart(2, "0")}+08:00`);
    if (Number.isFinite(parsed.getTime())) return localIsoDate(parsed);
  }
  const ymdMatch = textValue.match(/^(\d{4})[\/.-](\d{1,2})[\/.-](\d{1,2})(?:[T\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (ymdMatch) {
    const [, year, month, day, hour = "0", minute = "0", second = "0"] = ymdMatch;
    const parsed = new Date(`${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}T${hour.padStart(2, "0")}:${minute}:${second.padStart(2, "0")}+08:00`);
    if (Number.isFinite(parsed.getTime())) return localIsoDate(parsed);
  }
  const numericValue = typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value.trim()) : value;
  const date = typeof numericValue === "number" && Number.isFinite(numericValue)
    ? new Date(numericValue > 1000000000000 ? numericValue : numericValue * 1000)
    : new Date(numericValue);
  return Number.isFinite(date.getTime()) ? localIsoDate(date) : localIsoDate(new Date());
}

function isoOffset(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return localIsoDate(date);
}

function isoOffsetFromDate(value, days) {
  const date = new Date(`${String(value || localIsoDate(new Date())).slice(0, 10)}T00:00:00`);
  date.setDate(date.getDate() + days);
  return localIsoDate(date);
}

function defaultConnection(companyId) {
  const template = COMPANY_DEFAULTS[companyId];
  return {
    companyId,
    metaEnabled: false,
    metaPageId: "",
    metaAdAccountId: "",
    metaFormIds: "",
    metaCampaignId: "",
    metaSpendSyncEnabled: false,
    metaAccessToken: "",
    metaSpendAccessToken: "",
    metaDefaultStaff: template.defaultStaff,
    metaLeadStatus: template.defaultStatus,
    tiktokEnabled: false,
    tiktokAdvertiserId: "",
    tiktokFormIds: "",
    tiktokCampaignId: "",
    tiktokSpendSyncEnabled: false,
    tiktokLeadMode: "instant-form",
    tiktokCallbackToken: "",
    tiktokAccessToken: "",
    tiktokDefaultStaff: template.defaultStaff,
    tiktokLeadStatus: template.defaultStatus,
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
      callbackToken: TIKTOK_DEFAULT_CALLBACK_TOKEN,
      leadRetentionDays: 90
    },
    connections: Object.keys(COMPANY_DEFAULTS).map(defaultConnection),
    assignmentCursor: {
      meta: {},
      tiktok: {}
    },
    inboundEvents: []
  };
}

function defaultWhatsAppSettings() {
  return {
    id: "whatsapp-salam-land",
    companyId: "salam-land",
    waba_id: process.env.WHATSAPP_WABA_ID || "",
    phone_number_id: process.env.WHATSAPP_PHONE_NUMBER_ID || "",
    access_token_env_key: WHATSAPP_DEFAULT_ACCESS_TOKEN_ENV_KEY,
    webhook_verify_token: process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN ? "__env__" : "",
    default_template_name: process.env.WHATSAPP_DEFAULT_TEMPLATE_NAME || "",
    default_language_code: process.env.WHATSAPP_DEFAULT_LANGUAGE_CODE || "ms",
    test_recipient_number: "",
    is_active: false,
    created_at: new Date().toISOString(),
    updated_at: ""
  };
}

function normalizeWhatsAppMessage(message = {}) {
  const now = new Date().toISOString();
  return {
    id: message.id || createId("wa-msg"),
    lead_id: String(message.lead_id || ""),
    phone_number: formatMalaysiaPhoneNumber(message.phone_number || ""),
    direction: ["inbound", "outbound"].includes(message.direction) ? message.direction : "system",
    message_type: message.message_type || "system",
    template_name: String(message.template_name || ""),
    message_body: String(message.message_body || ""),
    meta_message_id: String(message.meta_message_id || ""),
    status: message.status || (message.direction === "inbound" ? "received" : "queued"),
    error_code: String(message.error_code || ""),
    error_message: String(message.error_message || ""),
    raw_payload_json: message.raw_payload_json || null,
    created_at: message.created_at || now,
    updated_at: message.updated_at || message.created_at || now
  };
}

function normalizeWhatsAppOptOut(optOut = {}) {
  return {
    id: optOut.id || createId("wa-opt"),
    phone_number: formatMalaysiaPhoneNumber(optOut.phone_number || ""),
    lead_id: String(optOut.lead_id || ""),
    opt_out_reason: String(optOut.opt_out_reason || ""),
    created_at: optOut.created_at || new Date().toISOString()
  };
}

function defaultWhatsAppRuntime() {
  return {
    settings: defaultWhatsAppSettings(),
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
      ...((incoming.settings && typeof incoming.settings === "object") ? incoming.settings : {}),
      access_token_env_key: String(incoming.settings?.access_token_env_key || WHATSAPP_DEFAULT_ACCESS_TOKEN_ENV_KEY),
      default_language_code: String(incoming.settings?.default_language_code || process.env.WHATSAPP_DEFAULT_LANGUAGE_CODE || "ms")
    },
    messages: Array.isArray(incoming.messages) ? incoming.messages.map(normalizeWhatsAppMessage).slice(0, 2000) : [],
    optOuts: Array.isArray(incoming.optOuts) ? incoming.optOuts.map(normalizeWhatsAppOptOut).slice(0, 1000) : [],
    inboundEvents: Array.isArray(incoming.inboundEvents) ? incoming.inboundEvents.slice(0, 120) : []
  };
}

function defaultGoldRates() {
  return {
    status: "idle",
    sourceMode: "server",
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
      backupRetentionDays: 14
    },
    activity: [],
    errors: [],
    lastBackupAt: ""
  };
}

function mergeProfilesWithDefaults(incomingProfiles = []) {
  const defaults = buildAccessProfiles();
  const incomingMap = new Map((Array.isArray(incomingProfiles) ? incomingProfiles : []).map((profile) => [profile.profileId, profile]));
  return defaults.map((profile) => ({
    ...profile,
    ...(incomingMap.get(profile.profileId) || {})
  }));
}

function mergeControl(raw) {
  const defaults = defaultControl();
  const incoming = raw && typeof raw === "object" ? raw : {};
  const profiles = mergeProfilesWithDefaults(incoming.profiles);
  const nextActiveProfileId = profiles.some((profile) => profile.profileId === incoming.activeProfileId)
    ? incoming.activeProfileId
    : profiles[0]?.profileId || defaults.activeProfileId;
  return {
    ...defaults,
    ...incoming,
    activeProfileId: nextActiveProfileId,
    settings: {
      ...defaults.settings,
      ...((incoming.settings && typeof incoming.settings === "object") ? incoming.settings : {})
    },
    profiles,
    activity: normalizeActivityList(Array.isArray(incoming.activity) ? incoming.activity.slice(0, 80) : []),
    errors: Array.isArray(incoming.errors) ? incoming.errors.slice(0, 20) : [],
    lastBackupAt: typeof incoming.lastBackupAt === "string" ? incoming.lastBackupAt : ""
  };
}

function sanitizeProfile(profile) {
  return {
    profileId: profile.profileId,
    username: profile.username,
    name: profile.name,
    role: profile.role,
    companyIds: profile.companyIds,
    companyId: profile.companyId,
    staffName: profile.staffName,
    title: profile.title,
    note: profile.note,
    mustChangePassword: Boolean(profile.mustChangePassword)
  };
}

function defaultAuthStore() {
  return {
    version: 1,
    users: buildAccessProfiles().map((profile) => ({
      ...profile,
      ...createPasswordRecord(DEFAULT_LOGIN_PASSWORD),
      mustChangePassword: !GLOBAL_ACCESS_ROLES.has(profile.role)
    }))
  };
}

function mergeAuthStore(raw) {
  const defaults = defaultAuthStore();
  const incomingUsers = Array.isArray(raw?.users) ? raw.users : [];
  const userMap = new Map(incomingUsers.map((user) => [user.profileId, user]));
  return {
    version: 1,
    users: buildAccessProfiles().map((profile) => {
      const incoming = userMap.get(profile.profileId);
      if (!incoming) {
        return defaults.users.find((user) => user.profileId === profile.profileId);
      }
      return {
        ...profile,
        passwordSalt: incoming.passwordSalt,
        passwordHash: incoming.passwordHash,
        mustChangePassword: incoming.mustChangePassword !== false
      };
    })
  };
}

function mergeGoldRates(raw) {
  return {
    ...defaultGoldRates(),
    ...(raw && typeof raw === "object" ? raw : {})
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
    connections: Object.keys(COMPANY_DEFAULTS).map((companyId) => ({
      ...defaultConnection(companyId),
      ...(connectionMap.get(companyId) || {}),
      metaAdAccountId: String(connectionMap.get(companyId)?.metaAdAccountId || "").trim(),
      metaDefaultStaff: normalizeStaffName(companyId, connectionMap.get(companyId)?.metaDefaultStaff || COMPANY_DEFAULTS[companyId].defaultStaff),
      tiktokDefaultStaff: normalizeStaffName(companyId, connectionMap.get(companyId)?.tiktokDefaultStaff || COMPANY_DEFAULTS[companyId].defaultStaff),
      notes: replaceLegacyStaffText(connectionMap.get(companyId)?.notes || "")
    })),
    assignmentCursor: {
      meta: Object.fromEntries(Object.entries(assignmentCursor.meta || {}).map(([key, value]) => [key, Number(value) || 0])),
      tiktok: Object.fromEntries(Object.entries(assignmentCursor.tiktok || {}).map(([key, value]) => [key, Number(value) || 0]))
    },
    inboundEvents: Array.isArray(incoming.inboundEvents) ? incoming.inboundEvents.slice(0, 50) : []
  };
}

function normalizeRuntime(input = {}) {
  const runtime = {
    version: 1,
    updatedAt: input.updatedAt || new Date().toISOString(),
    records: normalizeRecordList(Array.isArray(input.records) ? input.records : []),
    campaigns: Array.isArray(input.campaigns) ? input.campaigns : [],
    integrations: mergeIntegrations(input.integrations),
    whatsapp: mergeWhatsApp(input.whatsapp),
    goldRates: mergeGoldRates(input.goldRates),
    control: mergeControl(input.control)
  };
  return repairSalamStaffAssignments(runtime);
}

let quarantinedRuntimeFingerprint = "";
let quarantinedRuntimePath = "";

async function quarantineCorruptRuntime(raw) {
  const fingerprint = crypto.createHash("sha256").update(raw).digest("hex");
  if (fingerprint === quarantinedRuntimeFingerprint && quarantinedRuntimePath) {
    return quarantinedRuntimePath;
  }
  await fs.mkdir(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const quarantinePath = path.join(BACKUP_DIR, `runtime-corrupt-${stamp}-${fingerprint.slice(0, 12)}.json`);
  await fs.writeFile(quarantinePath, raw, { flag: "wx", mode: 0o600 });
  quarantinedRuntimeFingerprint = fingerprint;
  quarantinedRuntimePath = quarantinePath;
  return quarantinePath;
}

async function corruptRuntimeError(raw) {
  await quarantineCorruptRuntime(raw);
  const error = new Error("Runtime state is invalid JSON. Original file preserved and quarantined.");
  error.statusCode = 503;
  return error;
}

async function ensureRuntimeState() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  let raw;
  try {
    raw = await fs.readFile(STATE_FILE, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const next = normalizeRuntime();
    await writeRuntimeState(next);
    return next;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw await corruptRuntimeError(raw);
  }
  const normalized = normalizeRuntime(parsed);
  if (JSON.stringify(parsed) !== JSON.stringify(normalized)) {
    await writeRuntimeState(normalized);
  }
  return normalized;
}

async function ensureAuthStore() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    const raw = await fs.readFile(AUTH_FILE, "utf8");
    const merged = mergeAuthStore(JSON.parse(raw));
    await fs.writeFile(AUTH_FILE, JSON.stringify(merged, null, 2));
    return merged;
  } catch {
    const seed = defaultAuthStore();
    await fs.writeFile(AUTH_FILE, JSON.stringify(seed, null, 2));
    return seed;
  }
}

async function writeAuthStore(store) {
  const next = mergeAuthStore(store);
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(AUTH_FILE, JSON.stringify(next, null, 2));
  return next;
}

function authTokenFromRequest(req) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) return "";
  return header.slice(7).trim();
}

async function authenticatedUser(req) {
  const token = authTokenFromRequest(req);
  if (!token) return null;
  const session = authSessions.get(token);
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    authSessions.delete(token);
    return null;
  }
  const store = await ensureAuthStore();
  const user = store.users.find((item) => item.profileId === session.profileId);
  if (!user) {
    authSessions.delete(token);
    return null;
  }
  return sanitizeProfile(user);
}

async function requireAuth(req, res) {
  const user = await authenticatedUser(req);
  if (!user) {
    sendJson(res, 401, { ok: false, error: "Authentication required" });
    return null;
  }
  return user;
}

async function pruneBackupDirectory(retentionDays = 14) {
  const cutoff = Date.now() - (Number(retentionDays || 14) * 86400000);
  try {
    const files = await fs.readdir(BACKUP_DIR, { withFileTypes: true });
    await Promise.all(files.map(async (entry) => {
      if (!entry.isFile() || !entry.name.endsWith(".json")) return;
      const fullPath = path.join(BACKUP_DIR, entry.name);
      const stat = await fs.stat(fullPath);
      if (stat.mtimeMs < cutoff) {
        await fs.unlink(fullPath);
      }
    }));
  } catch {
    // Ignore backup prune issues in lightweight runtime mode.
  }
}

async function latestBackupTimestamp() {
  try {
    const files = await fs.readdir(BACKUP_DIR, { withFileTypes: true });
    let latest = 0;
    for (const entry of files) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const stat = await fs.stat(path.join(BACKUP_DIR, entry.name));
      latest = Math.max(latest, stat.mtimeMs);
    }
    return latest;
  } catch {
    return 0;
  }
}

async function maybeWriteAutoBackup(state) {
  const control = mergeControl(state.control);
  if (!control.settings.autoBackupEnabled) {
    return {
      ...state,
      control
    };
  }

  const now = Date.now();
  const lastServerBackupAt = await latestBackupTimestamp();
  if (lastServerBackupAt && now - lastServerBackupAt < AUTO_BACKUP_INTERVAL_MS) {
    return {
      ...state,
      control
    };
  }

  await fs.mkdir(BACKUP_DIR, { recursive: true });
  const backupAt = new Date(now).toISOString();
  const stamp = backupAt.replace(/[:.]/g, "-");
  const payload = {
    ...state,
    control: {
      ...control,
      lastBackupAt: backupAt
    }
  };
  await fs.writeFile(path.join(BACKUP_DIR, `runtime-${stamp}.json`), JSON.stringify(payload, null, 2));
  await pruneBackupDirectory(control.settings.backupRetentionDays);

  return {
    ...state,
    control: {
      ...control,
      lastBackupAt: backupAt
    }
  };
}

async function backupStats() {
  try {
    const files = await fs.readdir(BACKUP_DIR);
    return files.filter((name) => name.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

async function readCurrentRuntimeForWriteGuard() {
  let raw;
  try {
    raw = await fs.readFile(STATE_FILE, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return normalizeRuntime();
  }
  try {
    return normalizeRuntime(JSON.parse(raw));
  } catch {
    throw await corruptRuntimeError(raw);
  }
}

async function backupRuntimeBeforeWrite(currentState) {
  await fs.mkdir(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(BACKUP_DIR, `runtime-before-write-${stamp}.json`);
  await fs.writeFile(backupPath, JSON.stringify(currentState, null, 2), { mode: 0o600 });
  return backupPath;
}

async function logRejectedRuntimeWrite(reason, details = {}) {
  const entry = {
    at: new Date().toISOString(),
    reason,
    ...details
  };
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.appendFile(path.join(DATA_DIR, "runtime-write-rejections.log"), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

function isDangerousRuntimeRecordDrop(currentState, nextState) {
  const currentCount = Array.isArray(currentState.records) ? currentState.records.length : 0;
  const nextCount = Array.isArray(nextState.records) ? nextState.records.length : 0;
  if (currentCount > 0 && nextCount === 0) return true;
  if (currentCount >= 20 && nextCount < Math.floor(currentCount * 0.6)) return true;
  return false;
}

function ensureRuntimeRecordsArray(state) {
  if (!state || !Array.isArray(state.records)) {
    const error = new Error("Runtime write rejected: records must be an array.");
    error.statusCode = 400;
    throw error;
  }
}

function canUserAccessCompany(user, companyId) {
  return GLOBAL_ACCESS_ROLES.has(user.role) || user.companyIds.includes(companyId);
}

function canUserAccessRecord(user, record) {
  if (!user || !record || !canUserAccessCompany(user, record.companyId)) return false;
  return user.role !== "staff" || record.staff === user.staffName;
}

function canUserEditCompanySettings(user) {
  return GLOBAL_ACCESS_ROLES.has(user.role) || user.role === "company";
}

function recordRevisionTime(record = {}) {
  const updated = Date.parse(record.updatedAt || record.details?.lastPaymentDate || "");
  if (Number.isFinite(updated)) return updated;
  const created = Date.parse(record.createdAt ? `${String(record.createdAt).slice(0, 10)}T00:00:00.000Z` : "");
  return Number.isFinite(created) ? created : 0;
}

function newestRecord(currentRecord, incomingRecord) {
  if (!currentRecord) return incomingRecord;
  if (!incomingRecord) return currentRecord;
  return recordRevisionTime(currentRecord) > recordRevisionTime(incomingRecord) ? currentRecord : incomingRecord;
}

function mergeRecordsByFreshness(currentRecords = [], incomingRecords = [], canMergeRecord = () => true) {
  const currentList = Array.isArray(currentRecords) ? currentRecords : [];
  const incomingList = Array.isArray(incomingRecords) ? incomingRecords : [];
  const mergedMap = new Map(currentList.map((record) => [record.id, record]));

  incomingList.forEach((incomingRecord) => {
    if (!incomingRecord?.id || !canMergeRecord(incomingRecord)) return;
    mergedMap.set(incomingRecord.id, newestRecord(mergedMap.get(incomingRecord.id), incomingRecord));
  });

  return Array.from(mergedMap.values());
}

function mergeScopedRecords(currentRecords = [], incomingRecords = [], user) {
  if (GLOBAL_ACCESS_ROLES.has(user.role)) {
    return mergeRecordsByFreshness(currentRecords, incomingRecords);
  }

  const nextIncoming = Array.isArray(incomingRecords) ? incomingRecords.filter((record) => canUserAccessRecord(user, record)) : [];
  const incomingMap = new Map(nextIncoming.map((record) => [record.id, record]));
  const currentIds = new Set((Array.isArray(currentRecords) ? currentRecords : []).map((record) => record.id));
  const merged = (Array.isArray(currentRecords) ? currentRecords : []).map((record) => {
    if (!canUserAccessRecord(user, record)) return record;
    return newestRecord(record, incomingMap.get(record.id));
  });

  nextIncoming.forEach((record) => {
    if (!currentIds.has(record.id)) merged.unshift(record);
  });

  return merged;
}

function mergeScopedCampaigns(currentCampaigns = [], incomingCampaigns = [], user) {
  if (GLOBAL_ACCESS_ROLES.has(user.role)) {
    return Array.isArray(incomingCampaigns) ? incomingCampaigns : currentCampaigns;
  }
  if (!canUserEditCompanySettings(user)) {
    return Array.isArray(currentCampaigns) ? currentCampaigns : [];
  }

  const nextIncoming = Array.isArray(incomingCampaigns)
    ? incomingCampaigns.filter((campaign) => canUserAccessCompany(user, campaign.companyId))
    : [];
  const incomingMap = new Map(nextIncoming.map((campaign) => [campaign.id, campaign]));
  const currentIds = new Set((Array.isArray(currentCampaigns) ? currentCampaigns : []).map((campaign) => campaign.id));
  const merged = (Array.isArray(currentCampaigns) ? currentCampaigns : []).map((campaign) => {
    if (!canUserAccessCompany(user, campaign.companyId)) return campaign;
    return incomingMap.get(campaign.id) || campaign;
  });

  nextIncoming.forEach((campaign) => {
    if (!currentIds.has(campaign.id)) merged.unshift(campaign);
  });

  return merged;
}

function mergeRecentItems(currentItems = [], incomingItems = [], limit = 80) {
  const itemMap = new Map();
  [...(Array.isArray(currentItems) ? currentItems : []), ...(Array.isArray(incomingItems) ? incomingItems : [])]
    .filter((item) => item && item.id)
    .forEach((item) => {
      itemMap.set(item.id, {
        ...(itemMap.get(item.id) || {}),
        ...item
      });
    });

  return Array.from(itemMap.values())
    .sort((left, right) => String(right.at || right.createdAt || "").localeCompare(String(left.at || left.createdAt || "")))
    .slice(0, limit);
}

function mergeScopedControl(currentControl, incomingControl, user) {
  const base = mergeControl(currentControl);
  const incoming = incomingControl && typeof incomingControl === "object" ? incomingControl : {};

  const next = {
    ...base,
    activity: mergeRecentItems(base.activity, incoming.activity, 80),
    errors: mergeRecentItems(base.errors, incoming.errors, 20),
    lastBackupAt: typeof incoming.lastBackupAt === "string" ? incoming.lastBackupAt : base.lastBackupAt
  };

  if (GLOBAL_ACCESS_ROLES.has(user.role)) {
    return mergeControl({
      ...next,
      activeProfileId: incoming.activeProfileId || next.activeProfileId,
      profiles: Array.isArray(incoming.profiles) ? incoming.profiles : next.profiles,
      settings: {
        ...base.settings,
        ...((incoming.settings && typeof incoming.settings === "object") ? incoming.settings : {})
      }
    });
  }

  return {
    ...next,
    profiles: buildAccessProfiles().filter((profile) => profile.profileId === user.profileId),
    activeProfileId: user.profileId
  };
}

function mergeScopedIntegrations(currentIntegrations, incomingIntegrations, user) {
  const current = mergeIntegrations(currentIntegrations);
  if (GLOBAL_ACCESS_ROLES.has(user.role)) {
    return mergeIntegrations(incomingIntegrations);
  }
  if (!canUserEditCompanySettings(user)) {
    return current;
  }

  const incoming = mergeIntegrations(incomingIntegrations);
  const connectionMap = new Map(incoming.connections.map((connection) => [connection.companyId, connection]));
  return {
    ...current,
    connections: current.connections.map((connection) => (
      canUserAccessCompany(user, connection.companyId)
        ? {
          ...connection,
          ...(connectionMap.get(connection.companyId) || {})
        }
        : connection
    ))
  };
}

function sanitizeWhatsAppForUser(whatsapp, user, visibleRecords = []) {
  const base = mergeWhatsApp(whatsapp);
  const visibleLeadIds = new Set(visibleRecords.map((record) => record.id));
  const visiblePhones = new Set(visibleRecords.map((record) => formatMalaysiaPhoneNumber(record.phone || "")).filter(Boolean));
  const hasDebugAccess = user && GLOBAL_ACCESS_ROLES.has(user.role);
  const hasSettingsAccess = hasDebugAccess;
  const messages = base.messages
    .filter((message) => (
      !user
        ? false
        : hasDebugAccess
          || (message.lead_id && visibleLeadIds.has(message.lead_id))
          || (message.phone_number && visiblePhones.has(message.phone_number))
    ))
    .map((message) => ({
      ...message,
      raw_payload_json: hasDebugAccess ? message.raw_payload_json : null
    }));

  return {
    ...base,
    settings: hasSettingsAccess
      ? {
        ...base.settings,
        env_status: whatsappConfigStatus(base.settings)
      }
      : {
        id: base.settings.id,
        companyId: base.settings.companyId,
        is_active: base.settings.is_active,
        default_template_name: base.settings.default_template_name,
        default_language_code: base.settings.default_language_code,
        env_status: whatsappConfigStatus(base.settings)
      },
    messages,
    optOuts: base.optOuts.filter((optOut) => hasDebugAccess || visiblePhones.has(optOut.phone_number)),
    inboundEvents: hasDebugAccess ? base.inboundEvents : []
  };
}

function sanitizeRuntimeForUser(runtime, user) {
  if (!user) return runtime;
  const records = runtime.records
    .filter((record) => canUserAccessRecord(user, record));
  const visibleCampaignIds = new Set(records.map((record) => record.campaignId).filter(Boolean));
  const campaigns = runtime.campaigns.filter((campaign) => canUserAccessCompany(user, campaign.companyId));
  const integrations = mergeIntegrations(runtime.integrations);
  const control = mergeControl(runtime.control);

  integrations.connections = integrations.connections
    .filter((connection) => canUserAccessCompany(user, connection.companyId))
    .map((connection) => ({
      ...connection,
      metaAccessToken: GLOBAL_ACCESS_ROLES.has(user.role) || user.role === "company" ? connection.metaAccessToken : "",
      metaSpendAccessToken: GLOBAL_ACCESS_ROLES.has(user.role) || user.role === "company" ? connection.metaSpendAccessToken : "",
      tiktokCallbackToken: GLOBAL_ACCESS_ROLES.has(user.role) || user.role === "company" ? connection.tiktokCallbackToken : "",
      tiktokAccessToken: GLOBAL_ACCESS_ROLES.has(user.role) || user.role === "company" ? connection.tiktokAccessToken : ""
    }));
  if (!GLOBAL_ACCESS_ROLES.has(user.role)) {
    integrations.inboundEvents = [];
  }

  return {
      ...runtime,
      records,
      campaigns: user.role === "staff"
        ? campaigns.filter((campaign) => !visibleCampaignIds.size || visibleCampaignIds.has(campaign.id))
        : campaigns,
      integrations,
      whatsapp: sanitizeWhatsAppForUser(runtime.whatsapp, user, records),
      control: {
        ...control,
        activity: control.activity.filter((item) => !item.companyId || canUserAccessCompany(user, item.companyId)),
        profiles: GLOBAL_ACCESS_ROLES.has(user.role)
          ? buildAccessProfiles().map(sanitizeProfile)
          : buildAccessProfiles().filter((profile) => profile.profileId === user.profileId).map(sanitizeProfile),
        activeProfileId: user.profileId
      }
    };
}

async function storeUploads(companyId, recordKind, files = []) {
  const safeCompany = slugify(companyId);
  const safeKind = slugify(recordKind);
  const destination = path.join(UPLOAD_DIR, safeCompany, safeKind);
  await fs.mkdir(destination, { recursive: true });

  const stored = [];
  for (const file of files) {
    const match = String(file.dataUrl || "").match(/^data:(.+?);base64,(.+)$/);
    if (!match) continue;
    const mimeType = match[1];
    const buffer = Buffer.from(match[2], "base64");
    const extension = path.extname(file.name || "") || (
      mimeType === "application/pdf" ? ".pdf"
        : mimeType === "image/png" ? ".png"
          : mimeType === "image/jpeg" ? ".jpg"
            : ".bin"
    );
    const filename = `${Date.now()}-${createId("file").slice(0, 8)}${extension}`;
    await fs.writeFile(path.join(destination, filename), buffer);
    stored.push({
      id: createId("upload"),
      name: file.name || filename,
      type: file.type || mimeType,
      size: Number(file.size || buffer.length),
      uploadedAt: new Date().toISOString(),
      url: `/uploads/${safeCompany}/${safeKind}/${filename}`,
      serverStored: true
    });
  }
  return stored;
}

async function writeRuntimeFileAtomically(state) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tempPath = path.join(DATA_DIR, `.runtime.json.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`);
  let handle;
  try {
    handle = await fs.open(tempPath, "wx", 0o600);
    await handle.writeFile(JSON.stringify(state, null, 2), "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(tempPath, STATE_FILE);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function writeRuntimeState(state, options = {}) {
  ensureRuntimeRecordsArray(state);
  const current = await readCurrentRuntimeForWriteGuard();
  let normalized = normalizeRuntime(state);
  const forceWrite = Boolean(options.force || state.__forceRuntimeWrite);
  if (!forceWrite && isDangerousRuntimeRecordDrop(current, normalized)) {
    await logRejectedRuntimeWrite("dangerous-record-drop", {
      currentRecords: current.records.length,
      nextRecords: normalized.records.length
    });
    const error = new Error("Dangerous runtime write rejected to protect CRM data.");
    error.statusCode = 409;
    throw error;
  }
  await backupRuntimeBeforeWrite(current);
  normalized = await maybeWriteAutoBackup(normalized);
  normalized.updatedAt = new Date().toISOString();
  await writeRuntimeFileAtomically(normalized);
  return normalized;
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    ...securityHeaders(),
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function sendText(res, statusCode, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(statusCode, {
    ...securityHeaders(),
    "Content-Type": contentType,
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function payloadTooLargeError(maxBytes) {
  const error = new Error(`Payload exceeds the ${maxBytes}-byte request limit.`);
  error.statusCode = 413;
  return error;
}

async function readBody(req, { maxBytes = REQUEST_BODY_LIMITS.json } = {}) {
  const limit = Number.isFinite(Number(maxBytes)) && Number(maxBytes) > 0
    ? Math.floor(Number(maxBytes))
    : REQUEST_BODY_LIMITS.json;
  const declaredLength = Number(req.headers["content-length"] || 0);
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    req.resume();
    throw payloadTooLargeError(limit);
  }

  const chunks = [];
  let totalBytes = 0;
  let tooLarge = false;
  for await (const chunk of req) {
    totalBytes += chunk.length;
    if (totalBytes > limit) {
      tooLarge = true;
      chunks.length = 0;
      continue;
    }
    if (tooLarge) continue;
    chunks.push(chunk);
  }
  if (tooLarge) throw payloadTooLargeError(limit);
  return Buffer.concat(chunks, totalBytes).toString("utf8");
}

function formatMalaysiaPhoneNumber(value = "") {
  const digits = String(value || "").replace(/[^\d]/g, "");
  if (!digits) return "";
  if (digits.startsWith("60")) return digits;
  if (digits.startsWith("0")) return `6${digits}`;
  if (digits.startsWith("1")) return `60${digits}`;
  return digits;
}

function validatePhoneNumber(value = "") {
  return /^60\d{8,11}$/.test(formatMalaysiaPhoneNumber(value));
}

function whatsappConfigFromSettings(settings = {}) {
  const accessTokenEnvKey = String(settings.access_token_env_key || WHATSAPP_DEFAULT_ACCESS_TOKEN_ENV_KEY);
  const verifyTokenFromEnv = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || "";
  const webhookVerifyToken = verifyTokenFromEnv || (settings.webhook_verify_token === "__env__" ? "" : String(settings.webhook_verify_token || ""));
  return {
    wabaId: process.env.WHATSAPP_WABA_ID || String(settings.waba_id || ""),
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || String(settings.phone_number_id || ""),
    accessTokenEnvKey,
    accessToken: process.env[accessTokenEnvKey] || "",
    webhookVerifyToken,
    defaultTemplateName: process.env.WHATSAPP_DEFAULT_TEMPLATE_NAME || String(settings.default_template_name || ""),
    defaultLanguageCode: process.env.WHATSAPP_DEFAULT_LANGUAGE_CODE || String(settings.default_language_code || "ms"),
    isActive: Boolean(settings.is_active)
  };
}

function whatsappConfigStatus(settings = {}) {
  const config = whatsappConfigFromSettings(settings);
  const missing = [];
  if (!config.phoneNumberId) missing.push("phone_number_id");
  if (!config.accessToken) missing.push(config.accessTokenEnvKey);
  if (!config.webhookVerifyToken) missing.push("webhook_verify_token");
  if (!config.defaultTemplateName) missing.push("default_template_name");
  return {
    status: missing.length ? "missing_config" : config.isActive ? "connected" : "configured_inactive",
    missing,
    access_token_env_key: config.accessTokenEnvKey,
    has_access_token: Boolean(config.accessToken),
    has_webhook_verify_token: Boolean(config.webhookVerifyToken),
    allowed_staff: WHATSAPP_ALLOWED_STAFF,
    graph_api_version: WHATSAPP_GRAPH_API_VERSION
  };
}

function activeWhatsAppConfig(runtime) {
  const whatsapp = mergeWhatsApp(runtime.whatsapp);
  return {
    whatsapp,
    settings: whatsapp.settings,
    config: whatsappConfigFromSettings(whatsapp.settings)
  };
}

function logWhatsAppRequest(runtime, message) {
  runtime.whatsapp = mergeWhatsApp(runtime.whatsapp);
  const nextMessage = normalizeWhatsAppMessage(message);
  runtime.whatsapp.messages = [nextMessage, ...runtime.whatsapp.messages].slice(0, 2000);
  return nextMessage;
}

function updateWhatsAppMessage(runtime, messageId, patch = {}) {
  runtime.whatsapp = mergeWhatsApp(runtime.whatsapp);
  let updated = null;
  runtime.whatsapp.messages = runtime.whatsapp.messages.map((message) => {
    if (message.id !== messageId && (!patch.meta_message_id || message.meta_message_id !== patch.meta_message_id)) return message;
    updated = normalizeWhatsAppMessage({
      ...message,
      ...patch,
      updated_at: new Date().toISOString()
    });
    return updated;
  });
  return updated;
}

function findWhatsAppLeadByPhone(runtime, phoneNumber = "") {
  const normalizedPhone = formatMalaysiaPhoneNumber(phoneNumber);
  return sortRecordsByRecency(runtime.records || []).find((record) => (
    record.kind === "lead"
      && formatMalaysiaPhoneNumber(record.phone || "") === normalizedPhone
      && !record.details?.archivedDuplicate
  ));
}

function isWhatsAppOptOut(runtime, phoneNumber = "") {
  const normalizedPhone = formatMalaysiaPhoneNumber(phoneNumber);
  return mergeWhatsApp(runtime.whatsapp).optOuts.some((item) => item.phone_number === normalizedPhone);
}

function isOptOutReply(text = "") {
  const normalized = String(text || "").trim().toUpperCase();
  return ["STOP", "TAK NAK", "TIDAK BERMINAT", "JANGAN MESEJ", "CANCEL"].includes(normalized);
}

function markWhatsAppOptOut(runtime, phoneNumber = "", leadId = "", reason = "") {
  runtime.whatsapp = mergeWhatsApp(runtime.whatsapp);
  const normalizedPhone = formatMalaysiaPhoneNumber(phoneNumber);
  if (!normalizedPhone) return null;
  const existing = runtime.whatsapp.optOuts.find((item) => item.phone_number === normalizedPhone);
  if (existing) return existing;
  const optOut = normalizeWhatsAppOptOut({
    phone_number: normalizedPhone,
    lead_id: leadId,
    opt_out_reason: reason || "Customer requested opt-out"
  });
  runtime.whatsapp.optOuts = [optOut, ...runtime.whatsapp.optOuts].slice(0, 1000);
  return optOut;
}

function whatsappPayloadText(message = {}) {
  if (message.type === "text") return message.text?.body || "";
  if (message.type === "button") return message.button?.text || message.button?.payload || "";
  if (message.type === "interactive") {
    return message.interactive?.button_reply?.title || message.interactive?.list_reply?.title || "";
  }
  if (message.type === "image") return message.image?.caption || "[image]";
  if (message.type === "document") return message.document?.caption || message.document?.filename || "[document]";
  return message.type ? `[${message.type}]` : "";
}

async function callWhatsAppCloudApi(config, payload) {
  if (!config.accessToken) {
    const error = new Error(`Missing ${config.accessTokenEnvKey}`);
    error.code = "missing_token";
    throw error;
  }
  if (!config.phoneNumberId) {
    const error = new Error("Missing WhatsApp Phone Number ID");
    error.code = "missing_phone_number_id";
    throw error;
  }

  const response = await fetch(`https://graph.facebook.com/${WHATSAPP_GRAPH_API_VERSION}/${config.phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  let body;
  try {
    body = await response.json();
  } catch {
    body = { raw: await response.text().catch(() => "") };
  }

  if (!response.ok) {
    const error = new Error(body?.error?.message || `WhatsApp API failed with HTTP ${response.status}`);
    error.code = body?.error?.code || response.status;
    error.raw = body;
    throw error;
  }

  return body;
}

async function callWhatsAppCloudRegisterApi(config, pin, phoneNumberId = "") {
  const targetPhoneNumberId = String(phoneNumberId || config.phoneNumberId || "").trim();
  if (!config.accessToken) {
    const error = new Error(`Missing ${config.accessTokenEnvKey}`);
    error.code = "missing_token";
    throw error;
  }
  if (!targetPhoneNumberId) {
    const error = new Error("Missing WhatsApp Phone Number ID");
    error.code = "missing_phone_number_id";
    throw error;
  }
  const normalizedPin = String(pin || "").trim();
  if (normalizedPin && !/^\d{6}$/.test(normalizedPin)) {
    const error = new Error("Cloud API registration PIN must be 6 digits when provided");
    error.code = "invalid_pin";
    throw error;
  }

  const response = await fetch(`https://graph.facebook.com/${WHATSAPP_GRAPH_API_VERSION}/${targetPhoneNumberId}/register`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      ...(normalizedPin ? { pin: normalizedPin } : {})
    })
  });

  let body;
  try {
    body = await response.json();
  } catch {
    body = { raw: await response.text().catch(() => "") };
  }

  if (!response.ok) {
    const error = new Error(body?.error?.message || `WhatsApp register failed with HTTP ${response.status}`);
    error.code = body?.error?.code || response.status;
    error.raw = body;
    throw error;
  }

  return body;
}

function handleWhatsAppError(error) {
  return {
    error_code: String(error?.code || "unknown"),
    error_message: String(error?.message || error || "Unknown WhatsApp API error").slice(0, 500),
    raw_payload_json: error?.raw || null
  };
}

async function sendTemplateMessage(runtime, leadOrPayload, options = {}) {
  const { whatsapp, config } = activeWhatsAppConfig(runtime);
  const lead = leadOrPayload && leadOrPayload.kind === "lead" ? leadOrPayload : null;
  const phoneNumber = formatMalaysiaPhoneNumber(options.phoneNumber || leadOrPayload?.phone || "");
  const templateName = options.templateName || config.defaultTemplateName;
  const languageCode = options.languageCode || config.defaultLanguageCode || "ms";

  const log = logWhatsAppRequest(runtime, {
    lead_id: lead?.id || options.leadId || "",
    phone_number: phoneNumber,
    direction: "outbound",
    message_type: "template",
    template_name: templateName,
    message_body: templateName ? `Template: ${templateName}` : "",
    status: "queued"
  });

  if (!validatePhoneNumber(phoneNumber)) {
    return updateWhatsAppMessage(runtime, log.id, {
      status: "failed",
      error_code: "invalid_phone_number",
      error_message: "Invalid Malaysia phone number format"
    });
  }

  if (isWhatsAppOptOut(runtime, phoneNumber)) {
    return updateWhatsAppMessage(runtime, log.id, {
      status: "failed",
      error_code: "customer_opt_out",
      error_message: "Customer opted out from WhatsApp follow-up"
    });
  }

  if (!templateName) {
    return updateWhatsAppMessage(runtime, log.id, {
      status: "failed",
      error_code: "missing_template",
      error_message: "Missing default WhatsApp template name"
    });
  }

  try {
    const payload = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: phoneNumber,
      type: "template",
      template: {
        name: templateName,
        language: { code: languageCode }
      }
    };
    const response = await callWhatsAppCloudApi(config, payload);
    return updateWhatsAppMessage(runtime, log.id, {
      status: "sent",
      meta_message_id: response?.messages?.[0]?.id || "",
      raw_payload_json: response
    });
  } catch (error) {
    return updateWhatsAppMessage(runtime, log.id, {
      status: "failed",
      ...handleWhatsAppError(error)
    });
  }
}

async function sendTextMessageWithin24Hour(runtime, phoneNumber, messageBody, leadId = "") {
  const { config } = activeWhatsAppConfig(runtime);
  const normalizedPhone = formatMalaysiaPhoneNumber(phoneNumber);
  const log = logWhatsAppRequest(runtime, {
    lead_id: leadId,
    phone_number: normalizedPhone,
    direction: "outbound",
    message_type: "text",
    message_body: messageBody,
    status: "queued"
  });

  if (!validatePhoneNumber(normalizedPhone)) {
    return updateWhatsAppMessage(runtime, log.id, {
      status: "failed",
      error_code: "invalid_phone_number",
      error_message: "Invalid Malaysia phone number format"
    });
  }

  if (isWhatsAppOptOut(runtime, normalizedPhone)) {
    return updateWhatsAppMessage(runtime, log.id, {
      status: "failed",
      error_code: "customer_opt_out",
      error_message: "Customer opted out from WhatsApp follow-up"
    });
  }

  try {
    const response = await callWhatsAppCloudApi(config, {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: normalizedPhone,
      type: "text",
      text: { preview_url: false, body: messageBody }
    });
    return updateWhatsAppMessage(runtime, log.id, {
      status: "sent",
      meta_message_id: response?.messages?.[0]?.id || "",
      raw_payload_json: response
    });
  } catch (error) {
    return updateWhatsAppMessage(runtime, log.id, {
      status: "failed",
      ...handleWhatsAppError(error)
    });
  }
}

async function retryFailedMessage(runtime, messageId) {
  const message = mergeWhatsApp(runtime.whatsapp).messages.find((item) => item.id === messageId);
  if (!message || message.status !== "failed") return null;
  if (message.message_type === "template") {
    return sendTemplateMessage(runtime, {
      id: message.lead_id,
      phone: message.phone_number,
      kind: "lead"
    }, {
      leadId: message.lead_id,
      phoneNumber: message.phone_number,
      templateName: message.template_name
    });
  }
  if (message.message_type === "text") {
    return sendTextMessageWithin24Hour(runtime, message.phone_number, message.message_body, message.lead_id);
  }
  return null;
}

function hasWhatsAppIntroMessage(runtime, lead) {
  return mergeWhatsApp(runtime.whatsapp).messages.some((message) => (
    message.lead_id === lead.id
      && message.direction === "outbound"
      && message.message_type === "template"
  ));
}

function isWhatsAppAutoIntroAllowedForLead(lead) {
  if (!WHATSAPP_ALLOWED_STAFF.length) return true;
  const staffName = normalizeStaffName(lead.companyId, lead.staff, lead);
  return WHATSAPP_ALLOWED_STAFF.includes(staffName);
}

async function sendWhatsAppIntroForLeadSafely(runtime, lead, eventSource = "lead-create") {
  const { settings, config } = activeWhatsAppConfig(runtime);
  if (!settings.is_active) return { status: "disabled" };
  if (!lead || lead.kind !== "lead" || lead.companyId !== settings.companyId) return { status: "skipped" };
  if (!isWhatsAppAutoIntroAllowedForLead(lead)) return { status: "staff-skipped" };
  if (lead.details?.whatsapp_intro_attempted || hasWhatsAppIntroMessage(runtime, lead)) return { status: "duplicate-skipped" };

  lead.details = {
    ...(lead.details || {}),
    whatsapp_intro_attempted: true,
    whatsapp_intro_source: eventSource,
    whatsapp_intro_attempted_at: new Date().toISOString()
  };

  const message = await sendTemplateMessage(runtime, lead, {
    templateName: config.defaultTemplateName,
    languageCode: config.defaultLanguageCode
  });

  lead.details.whatsapp_intro_sent = message?.status === "sent";
  lead.details.whatsapp_intro_status = message?.status || "failed";
  lead.details.whatsapp_intro_message_id = message?.id || "";
  return { status: message?.status || "failed", message };
}

async function autoSendWhatsAppForNewLeads(runtime, previousRecords = [], eventSource = "crm-form") {
  const previousIds = new Set((Array.isArray(previousRecords) ? previousRecords : []).map((record) => record.id));
  const newLeads = (runtime.records || [])
    .filter((record) => record.kind === "lead" && !previousIds.has(record.id));
  const results = [];
  for (const lead of newLeads) {
    try {
      results.push(await sendWhatsAppIntroForLeadSafely(runtime, lead, eventSource));
    } catch (error) {
      logWhatsAppRequest(runtime, {
        lead_id: lead.id,
        phone_number: lead.phone,
        direction: "outbound",
        message_type: "system",
        message_body: "WhatsApp intro trigger failed",
        status: "failed",
        ...handleWhatsAppError(error)
      });
      results.push({ status: "error", error: error.message });
    }
  }
  return results;
}

function base64UrlEncode(value) {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlDecode(value = "") {
  const normalized = String(value).replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(`${normalized}${"=".repeat((4 - (normalized.length % 4)) % 4)}`, "base64");
}

async function ensureVapidKeys() {
  try {
    const raw = await fs.readFile(PUSH_VAPID_FILE, "utf8");
    const keys = JSON.parse(raw);
    if (keys.publicKey && keys.privateKey) return keys;
  } catch {
    // Generate once and persist below.
  }
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  const keys = {
    publicKey: base64UrlEncode(ecdh.getPublicKey()),
    privateKey: base64UrlEncode(ecdh.getPrivateKey()),
    createdAt: new Date().toISOString()
  };
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(PUSH_VAPID_FILE, JSON.stringify(keys, null, 2));
  return keys;
}

function vapidPrivateKey(keys) {
  const publicKey = base64UrlDecode(keys.publicKey);
  const privateKey = base64UrlDecode(keys.privateKey);
  const jwk = {
    kty: "EC",
    crv: "P-256",
    x: base64UrlEncode(publicKey.slice(1, 33)),
    y: base64UrlEncode(publicKey.slice(33, 65)),
    d: base64UrlEncode(privateKey)
  };
  return crypto.createPrivateKey({ key: jwk, format: "jwk" });
}

async function vapidAuthorization(endpoint) {
  const keys = await ensureVapidKeys();
  const header = base64UrlEncode(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const payload = base64UrlEncode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + (12 * 60 * 60),
    sub: "mailto:admin@salamland.my"
  }));
  const signed = `${header}.${payload}`;
  const signature = crypto.sign("sha256", Buffer.from(signed), {
    key: vapidPrivateKey(keys),
    dsaEncoding: "ieee-p1363"
  });
  return `vapid t=${signed}.${base64UrlEncode(signature)}, k=${keys.publicKey}`;
}

async function readPushSubscriptions() {
  try {
    const raw = await fs.readFile(PUSH_SUBSCRIPTIONS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return {
      subscriptions: Array.isArray(parsed.subscriptions) ? parsed.subscriptions : []
    };
  } catch {
    return { subscriptions: [] };
  }
}

async function writePushSubscriptions(store) {
  const next = {
    subscriptions: (Array.isArray(store.subscriptions) ? store.subscriptions : []).filter((item) => item?.endpoint)
  };
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(PUSH_SUBSCRIPTIONS_FILE, JSON.stringify(next, null, 2));
  return next;
}

async function savePushSubscription(user, payload) {
  const subscription = payload.subscription || {};
  const endpoint = String(subscription.endpoint || "");
  const companyId = String(payload.companyId || user.companyId || "");
  const directory = COMPANY_TEAM_DIRECTORY[companyId];
  const rawStaffName = String(payload.staffName || "").trim();
  const wantsAllStaff = ["__all__", "all", "all team", "semua"].includes(rawStaffName.toLowerCase());
  const staffName = wantsAllStaff && user.role !== "staff"
    ? NOTIFICATION_ALL_STAFF
    : normalizeStaffName(companyId, rawStaffName);
  if (!endpoint || !subscription.keys?.p256dh || !subscription.keys?.auth) {
    throw new Error("Invalid push subscription");
  }
  if (!canUserAccessCompany(user, companyId)) {
    throw new Error("Forbidden company scope");
  }
  if (staffName !== NOTIFICATION_ALL_STAFF && !directory?.staff.includes(staffName)) {
    throw new Error("Invalid team sales for push notification");
  }
  const store = await readPushSubscriptions();
  const now = new Date().toISOString();
  const existingIndex = store.subscriptions.findIndex((item) => item.endpoint === endpoint);
  const record = {
    endpoint,
    keys: {
      p256dh: String(subscription.keys.p256dh || ""),
      auth: String(subscription.keys.auth || "")
    },
    companyId,
    staffName,
    profileId: user.profileId,
    username: user.username,
    role: user.role,
    device: payload.device && typeof payload.device === "object" ? payload.device : {},
    active: true,
    createdAt: existingIndex >= 0 ? store.subscriptions[existingIndex].createdAt : now,
    updatedAt: now
  };
  if (existingIndex >= 0) {
    store.subscriptions[existingIndex] = record;
  } else {
    store.subscriptions.push(record);
  }
  return writePushSubscriptions(store);
}

async function removePushSubscription(endpoint) {
  const store = await readPushSubscriptions();
  const next = {
    subscriptions: store.subscriptions.filter((item) => item.endpoint !== endpoint)
  };
  return writePushSubscriptions(next);
}

function subscriptionMatchesRecord(subscription, record) {
  if (!subscription?.active || !record || record.kind !== "lead") return false;
  if (subscription.companyId !== record.companyId) return false;
  if (subscription.staffName === NOTIFICATION_ALL_STAFF) return true;
  const targetStaff = normalizeStaffName(record.companyId, record.staff);
  return Boolean(targetStaff) && subscription.staffName === targetStaff;
}

async function sendPushPing(subscription) {
  const response = await fetch(subscription.endpoint, {
    method: "POST",
    headers: {
      Authorization: await vapidAuthorization(subscription.endpoint),
      TTL: "86400",
      Urgency: "high"
    }
  });
  if ([404, 410].includes(response.status)) {
    await removePushSubscription(subscription.endpoint);
    return { ok: false, removed: true, status: response.status };
  }
  return { ok: response.ok, status: response.status };
}

async function notifyTeamsalesLeadSubscribers(record) {
  const store = await readPushSubscriptions();
  const subscriptions = store.subscriptions.filter((subscription) => subscriptionMatchesRecord(subscription, record));
  if (!subscriptions.length) return;
  const results = await Promise.allSettled(subscriptions.map(sendPushPing));
  const failed = results.filter((result) => result.status === "rejected" || !result.value?.ok);
  if (failed.length) {
    console.warn(`Push notification partial failure: ${failed.length}/${subscriptions.length}`);
  }
}

function parseDelimitedIds(value) {
  return String(value || "")
    .split(/[,\n]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function safeNumber(value) {
  if (typeof value === "string") {
    const cleaned = value.replace(/[^0-9.-]+/g, "");
    if (!cleaned) return 0;
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function goldRatesFromPayloads(gold, fx) {
  const ounceUsd = safeNumber(gold?.price);
  const usdMyr = safeNumber(fx?.rates?.MYR);
  const baseMyrPerGram = ounceUsd && usdMyr ? (ounceUsd / TROY_OUNCE_IN_GRAMS) * usdMyr : 0;
  return {
    status: "live",
    sourceMode: "server",
    fetchedAt: new Date().toISOString(),
    updatedAt: gold?.updatedAt || "",
    fxDate: fx?.date || "",
    ounceUsd,
    usdMyr,
    gram999: baseMyrPerGram * GOLD_PURITY["999"],
    gram916: baseMyrPerGram * GOLD_PURITY["916"],
    error: ""
  };
}

async function fetchRemoteJson(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Remote fetch failed: ${response.status} ${errorText.slice(0, 160)}`);
  }
  return response.json();
}

async function loadGoldRates(runtime, force = false) {
  const cached = goldRateCache.data;
  const cacheFresh = cached && (Date.now() - goldRateCache.fetchedAt < GOLD_RATE_CACHE_MS);
  if (!force && cacheFresh) {
    return cached;
  }
  if (goldRateCache.promise && !force) {
    return goldRateCache.promise;
  }

  goldRateCache.promise = (async () => {
    try {
      const [gold, fx] = await Promise.all([
        fetchRemoteJson("https://api.gold-api.com/price/XAU"),
        fetchRemoteJson("https://api.frankfurter.dev/v1/latest?base=USD&symbols=MYR")
      ]);
      const next = mergeGoldRates(goldRatesFromPayloads(gold, fx));
      goldRateCache.data = next;
      goldRateCache.fetchedAt = Date.now();
      runtime.goldRates = next;
      await writeRuntimeState(runtime);
      return next;
    } catch (error) {
      const fallback = mergeGoldRates(runtime.goldRates);
      if (fallback.fetchedAt) {
        const stale = {
          ...fallback,
          status: "stale",
          error: error.message
        };
        goldRateCache.data = stale;
        goldRateCache.fetchedAt = Date.now();
        runtime.goldRates = stale;
        await writeRuntimeState(runtime);
        return stale;
      }
      throw error;
    } finally {
      goldRateCache.promise = null;
    }
  })();

  return goldRateCache.promise;
}

function primitiveLeadValue(item) {
  if (Array.isArray(item)) {
    const primitive = item.find((entry) => entry === null || typeof entry !== "object");
    return primitive === undefined ? "" : primitive;
  }
  if (item && typeof item === "object") {
    if (Array.isArray(item.values)) return primitiveLeadValue(item.values);
    for (const key of ["value", "answer", "text", "label", "name"]) {
      if (item[key] !== undefined && item[key] !== null && item[key] !== "") return primitiveLeadValue(item[key]);
    }
    return "";
  }
  return item;
}

function fieldMapFromArray(fieldData) {
  const entries = Array.isArray(fieldData) ? fieldData : [];
  return entries.reduce((map, item) => {
    const key = String(item.name || item.key || item.label || item.title || "").trim().toLowerCase();
    if (!key) return map;
    const rawValue = primitiveLeadValue(item.values ?? item.value ?? item.answer ?? item.text);
    map[key] = typeof rawValue === "string" ? rawValue.trim() : rawValue;
    map[normalizeLeadFieldKey(key)] = map[key];
    return map;
  }, {});
}

function fieldMapFromObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.entries(value).reduce((map, [key, item]) => {
    const normalizedKey = normalizeLeadFieldKey(key);
    const primitive = primitiveLeadValue(item);
    const rawValue = typeof primitive === "string" ? primitive.trim() : primitive;
    if (rawValue === undefined || rawValue === null || rawValue === "") return map;
    map[String(key).toLowerCase()] = rawValue;
    if (normalizedKey) map[normalizedKey] = rawValue;
    return map;
  }, {});
}

function pickField(fieldMap, aliases) {
  for (const alias of aliases) {
    const value = fieldMap[alias] ?? fieldMap[normalizeLeadFieldKey(alias)];
    if (value !== undefined && value !== null && String(value).trim()) {
      return String(value).trim();
    }
  }
  return "";
}

function normalizePhone(value) {
  return String(value || "").replace(/[^\d]/g, "");
}

function parseTikTokSignature(header) {
  const parts = String(header || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const result = {};
  for (const part of parts) {
    const [prefix, value] = part.split("=");
    if (prefix && value) result[prefix] = value;
  }
  return result;
}

function timingSafeStringEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ""), "utf8");
  const rightBuffer = Buffer.from(String(right || ""), "utf8");
  if (!leftBuffer.length || leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function verifyMetaWebhookSignature(rawBody, signatureHeader) {
  const match = String(signatureHeader || "").trim().match(/^sha256=([a-f0-9]{64})$/i);
  if (!META_APP_SECRET || !match) return false;
  const expected = crypto.createHmac("sha256", META_APP_SECRET).update(rawBody).digest("hex");
  return timingSafeStringEqual(match[1].toLowerCase(), expected);
}

function verifyTikTokSignature(header, rawBody, secret) {
  if (!secret) return true;
  const parsed = parseTikTokSignature(header);
  if (!parsed.t || !parsed.s) return false;
  const signedPayload = `${parsed.t}.${rawBody}`;
  const expected = crypto.createHmac("sha256", secret).update(signedPayload).digest("hex");
  const actualBuffer = Buffer.from(parsed.s, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  if (actualBuffer.length !== expectedBuffer.length) return false;
  return crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function tiktokTokenFromRequest(req, url) {
  const authorization = String(req.headers.authorization || "");
  const bearer = authorization.toLowerCase().startsWith("bearer ") ? authorization.slice(7).trim() : "";
  return firstNonEmptyString(
    bearer,
    req.headers["x-crm-token"],
    req.headers["x-tiktok-token"],
    url.searchParams.get("token"),
    url.searchParams.get("secret")
  );
}

function verifyTikTokRequest(req, url, rawBody, secret) {
  if (!secret) return false;
  const signatureHeader = firstNonEmptyString(
    req.headers["tiktok-signature"],
    req.headers["x-tiktok-signature"],
    req.headers["x-tt-signature"]
  );
  if (signatureHeader && verifyTikTokSignature(signatureHeader, rawBody, secret)) return true;
  return timingSafeStringEqual(tiktokTokenFromRequest(req, url), secret);
}

function parseWebhookPayload(rawBody = "", contentType = "") {
  const text = String(rawBody || "").trim();
  if (!text) return {};

  const normalizedContentType = String(contentType || "").toLowerCase();
  if (normalizedContentType.includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(text));
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    if (!text.startsWith("{") && !text.startsWith("[") && text.includes("=")) {
      return Object.fromEntries(new URLSearchParams(text));
    }
    throw error;
  }
}

function normalizeLeadFieldKey(value = "") {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function flattenLeadObject(value, prefix = "", out = {}) {
  if (!value || typeof value !== "object") return out;
  if (Array.isArray(value)) {
    value.forEach((item, index) => flattenLeadObject(item, `${prefix}${prefix ? "." : ""}${index}`, out));
    return out;
  }

  for (const [key, raw] of Object.entries(value)) {
    const pathKey = `${prefix}${prefix ? "." : ""}${key}`;
    const normalizedPath = normalizeLeadFieldKey(pathKey);
    const normalizedLeaf = normalizeLeadFieldKey(key);
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      flattenLeadObject(raw, pathKey, out);
      continue;
    }
    if (Array.isArray(raw)) {
      const primitive = raw.find((item) => item === null || typeof item !== "object");
      if (primitive !== undefined) {
        if (normalizedPath) out[normalizedPath] = primitive;
        if (normalizedLeaf && out[normalizedLeaf] === undefined) out[normalizedLeaf] = primitive;
      }
      raw.forEach((item, index) => flattenLeadObject(item, `${pathKey}.${index}`, out));
      continue;
    }
    if (normalizedPath) out[normalizedPath] = raw;
    if (normalizedLeaf && out[normalizedLeaf] === undefined) out[normalizedLeaf] = raw;
  }
  return out;
}

function pickFlattenedField(source, aliases = []) {
  const flat = flattenLeadObject(source);
  const normalizedAliases = aliases.map(normalizeLeadFieldKey).filter(Boolean);
  for (const alias of normalizedAliases) {
    if (flat[alias] !== undefined && flat[alias] !== null && String(flat[alias]).trim()) {
      return String(flat[alias]).trim();
    }
  }
  for (const [key, value] of Object.entries(flat)) {
    if (value === undefined || value === null || !String(value).trim()) continue;
    if (normalizedAliases.some((alias) => key.endsWith(` ${alias}`) || key.includes(alias))) {
      return String(value).trim();
    }
  }
  return "";
}

function fieldMapFromLeadSource(source = {}) {
  const arrayMaps = [
    source.field_data,
    source.fieldData,
    source.questions,
    source.answers
  ].filter(Array.isArray).map(fieldMapFromArray);
  const objectMaps = [
    source,
    source.field_data,
    source.fieldData,
    source.form_data,
    source.formData,
    source.answers,
    source.fields,
    source.profile
  ].filter((item) => item && typeof item === "object" && !Array.isArray(item)).map(fieldMapFromObject);
  return Object.assign({}, flattenLeadObject(source), ...arrayMaps, ...objectMaps);
}

function enrichTikTokLeadSource(source = {}, container = {}) {
  const merged = { ...(container && typeof container === "object" && !Array.isArray(container) ? container : {}), ...(source || {}) };
  const canonical = { ...merged };
  const pick = (aliases) => firstNonEmptyString(
    pickField(fieldMapFromLeadSource(source), aliases),
    pickField(fieldMapFromLeadSource(container), aliases),
    pickFlattenedField(source, aliases),
    pickFlattenedField(container, aliases)
  );

  canonical.lead_id = firstNonEmptyString(canonical.lead_id, canonical.leadId, canonical.id, canonical.submission_id, pick([
    "lead_id", "lead id", "leadid", "tiktok lead id", "external lead id", "submission id", "submission_id", "event id", "event_id", "uuid", "prospect id", "leadsbridge id", "leadbridge id", "bridge id", "contact id"
  ]));
  canonical.phone_number = firstNonEmptyString(canonical.phone_number, canonical.phoneNumber, canonical.phone, canonical.mobile_number, canonical.mobileNumber, pick([
    "phone_number", "phone number", "phone", "mobile", "mobile_number", "mobile number", "whatsapp", "whatsapp number", "no telefon", "nombor telefon", "no hp", "no phone", "nombor", "number"
  ]));
  canonical.full_name = firstNonEmptyString(canonical.full_name, canonical.fullName, canonical.name, canonical.customer_name, canonical.customerName, pick([
    "full_name", "full name", "name", "customer_name", "customer name", "contact name", "client name", "nama", "nama penuh"
  ]));
  if (!canonical.full_name) {
    const joinedName = [pick(["first name", "first_name", "firstname", "given name"]), pick(["last name", "last_name", "lastname", "surname"])].filter(Boolean).join(" ").trim();
    if (joinedName) canonical.full_name = joinedName;
  }
  canonical.created_at = firstNonEmptyString(canonical.created_at, canonical.createdAt, canonical.created_time, canonical.createdTime, canonical.create_time, canonical.createTime, canonical.submit_time, canonical.submitTime, pick([
    "created_at", "created at", "created time", "create time", "submit time", "submitted at", "submission time", "lead date", "date created", "created date", "created", "date", "time"
  ]));
  canonical.campaign_name = firstNonEmptyString(canonical.campaign_name, canonical.campaignName, canonical.campaign, canonical.campaign_title, pick([
    "campaign_name", "campaign name", "campaign", "campaign title", "source campaign", "ad group", "ad group name", "adgroup", "adgroup name", "ad_group_name"
  ]));
  canonical.ad_name = firstNonEmptyString(canonical.ad_name, canonical.adName, canonical.creative_name, pick([
    "ad_name", "ad name", "creative name", "creative_name"
  ]));
  canonical.adgroup_name = firstNonEmptyString(canonical.adgroup_name, canonical.adgroupName, canonical.ad_group_name, canonical.adGroupName, pick([
    "adgroup_name", "adgroup name", "ad group", "ad group name", "ad_group_name"
  ]));
  canonical.form_id = firstNonEmptyString(canonical.form_id, canonical.formId, canonical.instant_form_id, canonical.instantFormId, pick([
    "form_id", "form id", "instant form id", "instant_form_id"
  ]));
  canonical.advertiser_id = firstNonEmptyString(canonical.advertiser_id, canonical.advertiserId, pick([
    "advertiser_id", "advertiser id", "advertiser"
  ]));
  return canonical;
}

function extractTikTokLeadSources(payload = {}) {
  const containers = Array.isArray(payload) ? payload : [payload];
  const leads = [];

  for (const container of containers) {
    if (!container || typeof container !== "object") continue;
    const top = container.data || container.lead || container.payload || container.event || container;
    const leadArrays = [
      top?.leads,
      top?.lead_data,
      top?.leadData,
      top?.items,
      top?.data,
      top?.submissions,
      top?.contacts,
      top?.records,
      container.leads,
      container.items,
      container.submissions,
      container.contacts,
      container.records
    ].filter(Array.isArray);

    if (leadArrays.length) {
      for (const list of leadArrays) {
        for (const lead of list) {
          if (!lead || typeof lead !== "object") continue;
          leads.push(enrichTikTokLeadSource(lead, Array.isArray(top) ? container : top));
        }
      }
      continue;
    }

    leads.push(enrichTikTokLeadSource(top, container));
  }

  const seen = new Set();
  return leads.filter((lead) => {
    if (!lead || typeof lead !== "object") return false;
    const key = firstNonEmptyString(lead.lead_id, lead.leadId, lead.id, normalizePhone(lead.phone_number), JSON.stringify(lead).slice(0, 200));
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function findConnection(runtime, companyId) {
  return runtime.integrations.connections.find((item) => item.companyId === companyId);
}

function isMetaFormConfigured(connection, formId) {
  if (!formId) return false;
  return parseDelimitedIds(connection.metaFormIds).includes(String(formId));
}

function rememberMetaFormId(connection, formId) {
  const nextFormId = String(formId || "").trim();
  if (!nextFormId || isMetaFormConfigured(connection, nextFormId)) return false;
  const formIds = parseDelimitedIds(connection.metaFormIds);
  connection.metaFormIds = [...formIds, nextFormId].join(", ");
  return true;
}

function findMetaConnection(runtime, pageId, formId, options = {}) {
  const allowPageFallback = options.allowPageFallback !== false;
  const connections = runtime.integrations.connections || [];
  const exactMatch = connections.find((connection) => {
    if (!connection.metaEnabled) return false;
    const hasPageMapping = Boolean(String(connection.metaPageId || "").trim());
    const formIds = parseDelimitedIds(connection.metaFormIds);
    if (!hasPageMapping && !formIds.length) return false;
    const pageMatch = !hasPageMapping || String(connection.metaPageId) === String(pageId || "");
    const formMatch = !formIds.length || formIds.includes(String(formId || ""));
    return pageMatch && formMatch;
  });
  if (exactMatch || !allowPageFallback || !pageId) return exactMatch;

  const pageMatches = connections.filter((connection) => {
    if (!connection.metaEnabled) return false;
    const mappedPageId = String(connection.metaPageId || "").trim();
    return mappedPageId && mappedPageId === String(pageId);
  });

  // If Meta sends a new form ID under the same Page, keep capturing instead of silently dropping it.
  return pageMatches.length === 1 ? pageMatches[0] : null;
}

function findTikTokConnection(runtime, advertiserId, formId) {
  const enabledConnections = (runtime.integrations.connections || []).filter((connection) => connection.tiktokEnabled);
  const exact = enabledConnections.find((connection) => {
    if (!connection.tiktokEnabled) return false;
    const hasAdvertiserMapping = Boolean(String(connection.tiktokAdvertiserId || "").trim());
    const formIds = parseDelimitedIds(connection.tiktokFormIds);
    if (!hasAdvertiserMapping && !formIds.length) return false;
    const advertiserMatch = !hasAdvertiserMapping || String(connection.tiktokAdvertiserId) === String(advertiserId || "");
    const formMatch = !formIds.length || formIds.includes(String(formId || ""));
    return advertiserMatch && formMatch;
  });
  if (exact) return exact;

  const advertiserOnly = String(advertiserId || "").trim()
    ? enabledConnections.filter((connection) => String(connection.tiktokAdvertiserId || "") === String(advertiserId))
    : [];
  if (!formId && advertiserOnly.length === 1) return advertiserOnly[0];

  const formOnly = String(formId || "").trim()
    ? enabledConnections.filter((connection) => parseDelimitedIds(connection.tiktokFormIds).includes(String(formId)))
    : [];
  // Some third-party connectors send an ad group/campaign id in the advertiser field.
  // A uniquely mapped instant form is safer than dropping a real lead as unmapped.
  if (formOnly.length === 1) return formOnly[0];

  // LeadsBridge can post only lead fields, or send campaign/ad group ids in place of
  // advertiser/form ids. If only one TikTok connection is enabled, keep operations moving.
  if (enabledConnections.length === 1) return enabledConnections[0];

  return !advertiserId && !formId && enabledConnections.length === 1 ? enabledConnections[0] : null;
}

function rememberTikTokFormId(connection, formId) {
  const nextFormId = String(formId || "").trim();
  if (!nextFormId) return false;
  const formIds = parseDelimitedIds(connection.tiktokFormIds);
  if (formIds.includes(nextFormId)) return false;
  connection.tiktokFormIds = [...formIds, nextFormId].join(", ");
  return true;
}

function hasExternalLead(runtime, platform, externalLeadId) {
  return runtime.records.some((record) => {
    const details = record.details || {};
    return details.externalPlatform === platform && String(details.externalLeadId || "") === String(externalLeadId || "");
  });
}

function hasSimilarExternalLead(runtime, record) {
  const details = record.details || {};
  const phone = normalizePhone(record.phone);
  const createdAt = recordSourceDate(record);
  const campaignName = firstNonEmptyString(details.tiktokCampaignName, details.metaCampaignName);
  if (!phone || !createdAt) return false;
  return runtime.records.some((existing) => {
    if (existing.id === record.id) return false;
    if (existing.source !== record.source) return false;
    if (normalizePhone(existing.phone) !== phone) return false;
    if (recordSourceDate(existing) !== createdAt) return false;
    const existingCampaignName = firstNonEmptyString(existing.details?.tiktokCampaignName, existing.details?.metaCampaignName);
    return !campaignName || !existingCampaignName || campaignName === existingCampaignName;
  });
}

function buildStableTikTokLeadId(source = {}, map = {}) {
  const explicitId = firstNonEmptyString(
    source.lead_id,
    source.leadId,
    source.id,
    source.leadgen_id,
    source.leadgenId,
    source.submission_id,
    source.submissionId,
    source.uuid,
    pickField(map, ["lead_id", "lead id", "leadid", "tiktok lead id", "external lead id", "submission id", "submission_id", "event id", "event_id", "uuid", "prospect id", "leadsbridge id", "leadbridge id", "bridge id", "contact id"])
  );
  if (explicitId) return String(explicitId);

  const phone = normalizePhone(firstNonEmptyString(
    source.phone_number,
    source.phoneNumber,
    source.phone,
    source.mobile_number,
    source.mobileNumber,
    pickField(map, ["phone_number", "phone number", "phone", "mobile", "mobile number", "whatsapp", "whatsapp number", "no telefon", "nombor telefon", "no hp", "no phone", "nombor", "number"])
  ));
  const createdAt = safeLocalIsoDate(firstNonEmptyString(
    source.created_at,
    source.createdAt,
    source.created_time,
    source.createdTime,
    source.create_time,
    source.createTime,
    source.submit_time,
    source.submitTime,
    pickField(map, ["created_at", "created at", "created time", "create time", "submit time", "submitted at", "submission time", "lead date", "date created", "created date", "created", "date", "time"])
  ));
  const campaignText = firstNonEmptyString(
    source.campaign_name,
    source.campaignName,
    source.campaign,
    source.adgroup_name,
    source.adgroupName,
    source.ad_group_name,
    source.ad_name,
    source.adName,
    pickField(map, ["campaign_name", "campaign name", "campaign", "ad_name", "ad name", "adgroup_name", "adgroup name", "ad group", "ad group name"])
  );
  const customerName = firstNonEmptyString(
    source.full_name,
    source.fullName,
    source.name,
    source.customer_name,
    source.customerName,
    pickField(map, ["full_name", "full name", "name", "customer_name", "customer name", "contact name", "client name", "nama", "nama penuh"])
  );
  const stableKey = [phone, createdAt, campaignText, customerName].map((item) => String(item || "").trim().toLowerCase()).filter(Boolean).join("|");
  if (stableKey) return `lb-${crypto.createHash("sha1").update(stableKey).digest("hex").slice(0, 18)}`;

  const rawKey = JSON.stringify(source, Object.keys(source || {}).sort());
  return `lb-raw-${crypto.createHash("sha1").update(rawKey || "empty-tiktok-lead").digest("hex").slice(0, 18)}`;
}

function findExistingCustomerRecord(runtime, record) {
  const phone = normalizePhone(record.phone);
  if (!phone) return null;
  return (runtime.records || []).find((existing) => {
    if (!existing || existing.id === record.id || existing.archived) return false;
    if (existing.companyId !== record.companyId) return false;
    if (!["lead", "order"].includes(existing.kind)) return false;
    return normalizePhone(existing.phone) === phone;
  }) || null;
}

function applyDuplicateLeadStatus(runtime, record) {
  if (!record || record.kind !== "lead") return record;
  const existing = findExistingCustomerRecord(runtime, record);
  if (!existing) return record;
  record.status = "Duplicate Lead";
  record.nextFollowUp = "";
  record.details = {
    ...(record.details || {}),
    duplicateCustomer: true,
    duplicateOf: existing.id,
    duplicateMatchedAt: new Date().toISOString(),
    duplicateOriginalKind: existing.kind || "",
    duplicateOriginalStatus: existing.status || "",
    duplicateOriginalCreatedAt: existing.createdAt || "",
    duplicateOriginalStaff: existing.staff || ""
  };
  record.actionFlags = normalizeActionFlags(record.actionFlags, record);
  const note = `Duplicate customer detected: phone already exists in CRM under ${existing.customerName || existing.phone || "existing record"}.`;
  record.notes = record.notes ? `${record.notes} ${note}` : note;
  return record;
}

function normalizeRecordStatusPatch(record = {}, patch = {}) {
  const nextStatus = String(patch.status || record.status || "").trim();
  if (nextStatus && !VALID_RECORD_STATUSES.has(nextStatus)) {
    const error = new Error("Invalid record status");
    error.statusCode = 400;
    throw error;
  }

  const nextRecord = {
    ...record,
    status: nextStatus || record.status || "New Lead",
    actionFlags: normalizeActionFlags(patch.actionFlags || record.actionFlags, {
      ...record,
      status: nextStatus || record.status
    }),
    updatedAt: patch.updatedAt || new Date().toISOString()
  };

  if (typeof patch.nextFollowUp === "string") {
    nextRecord.nextFollowUp = patch.nextFollowUp.slice(0, 10);
  }

  if (nextRecord.status === "WS Sent" || nextRecord.status === "Dihubungi") nextRecord.actionFlags.wsSent = true;
  if (nextRecord.status === "Reply") nextRecord.actionFlags.reply = true;
  if (nextRecord.status === "Tak Jawab") {
    nextRecord.actionFlags.wsSent = true;
    nextRecord.actionFlags.noAnswer = true;
  }
  if (nextRecord.status === "Site Visit") nextRecord.actionFlags.siteVisit = true;
  if (nextRecord.status === "Booking" || nextRecord.status === "Deposit") nextRecord.actionFlags.booking = true;
  if (["Closed", "Delivered", "Payment"].includes(nextRecord.status)) {
    nextRecord.actionFlags.closed = true;
    nextRecord.nextFollowUp = "";
  }
  if (["Lost", "Duplicate Lead", "Cancelled / Refund"].includes(nextRecord.status)) {
    nextRecord.actionFlags.rejected = true;
    nextRecord.nextFollowUp = "";
  }

  return nextRecord;
}

function isMetaTestLead(lead) {
  const map = fieldMapFromArray(lead.field_data);
  const haystack = Object.values(map).join(" ").toLowerCase();
  return haystack.includes("<test lead:") || haystack.includes("dummy data for");
}

function recordSortTimestamp(record) {
  const exactTime = firstNonEmptyString(
    record.details?.metaCreatedTime,
    record.details?.tiktokCreatedTime
  );
  if (exactTime) {
    const exact = new Date(exactTime).getTime();
    if (Number.isFinite(exact)) return exact;
  }
  const dateOnly = recordSourceDate(record);
  const date = new Date(`${dateOnly || "1970-01-01"}T00:00:00+08:00`).getTime();
  return Number.isFinite(date) ? date : 0;
}

function sortRecordsByRecency(records = []) {
  return [...records].sort((a, b) => recordSortTimestamp(b) - recordSortTimestamp(a));
}

function pushInboundEvent(runtime, event) {
  runtime.integrations.inboundEvents = [
    {
      id: createId("evt"),
      receivedAt: new Date().toISOString(),
      ...event
    },
    ...runtime.integrations.inboundEvents
  ].slice(0, 50);
}

function nextAssignedStaff(runtime, companyId, platform, fallbackStaff = "") {
  const staffList = ACCESS_COMPANIES.find((company) => company.id === companyId)?.staff || [];
  const normalizedFallback = normalizeStaffName(companyId, fallbackStaff);
  if (!staffList.length) return normalizedFallback;

  runtime.integrations.assignmentCursor = runtime.integrations.assignmentCursor || { meta: {}, tiktok: {} };
  runtime.integrations.assignmentCursor[platform] = runtime.integrations.assignmentCursor[platform] || {};

  if (staffList.length === 1) {
    runtime.integrations.assignmentCursor[platform][companyId] = 0;
    return normalizedFallback || staffList[0];
  }

  const currentIndex = Number(runtime.integrations.assignmentCursor[platform][companyId]);
  const nextIndex = Number.isFinite(currentIndex) ? (currentIndex + 1) % staffList.length : 0;
  runtime.integrations.assignmentCursor[platform][companyId] = nextIndex;
  return staffList[nextIndex] || normalizedFallback || staffList[0];
}

function inferStaffFromMarketingText(companyId, ...values) {
  const text = values
    .map((value) => String(value || "").toLowerCase())
    .join(" ")
    .replace(/[^a-z0-9]+/g, " ");

  const salamRules = [
    { staff: "Nureen", patterns: [/\bnurin\b/, /\bnureen\b/, /\bnureen\b/] },
    { staff: "Wafi", patterns: [/\bwafi\b/] },
    { staff: "Tasha", patterns: [/\btasha\b/, /\bnatasha\b/] },
    { staff: "Sabrina", patterns: [/\bsabrina\b/, /\bsabrin\b/] },
    { staff: "Ain", patterns: [/\bain\b/] }
  ];

  if (companyId === "salam-land") {
    const match = salamRules.find((rule) => rule.patterns.some((pattern) => pattern.test(text)));
    if (match) return match.staff;
  }

  const directory = COMPANY_TEAM_DIRECTORY[companyId];
  if (!directory) return "";

  const aliases = Object.entries(directory.legacyToStaff || {})
    .map(([alias, staff]) => ({ alias: String(alias || "").trim(), staff }))
    .filter((item) => item.alias && directory.staff.includes(item.staff));

  const genericMatch = aliases.find((item) => {
    const normalizedAlias = item.alias.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (!normalizedAlias) return false;
    return new RegExp(`\\b${normalizedAlias.replace(/\s+/g, "\\s+")}\\b`).test(text);
  });

  return genericMatch ? genericMatch.staff : "";
}

function marketingTextForRecord(runtime, record = {}) {
  const campaign = runtime.campaigns.find((item) => item.id === record.campaignId) || {};
  const details = record.details || {};
  return [
    details.metaCampaignName,
    details.tiktokCampaignName,
    details.metaAdName,
    details.metaAdsetName,
    details.tiktokCampaignId,
    campaign.name,
    campaign.externalCampaignId,
    campaign.externalAdId,
    record.product,
    record.notes
  ];
}

function platformForAssignment(record = {}) {
  const source = String(record.source || record.details?.externalPlatform || "").toLowerCase();
  if (source.includes("tiktok")) return "tiktok";
  return "meta";
}

function assignMarketingStaff(runtime, companyId, platform, fallbackStaff = "", ...values) {
  const staffFromCampaign = inferStaffFromMarketingText(companyId, ...values);
  if (staffFromCampaign) {
    return {
      staff: staffFromCampaign,
      method: "campaign"
    };
  }
  return {
    staff: nextAssignedStaff(runtime, companyId, platform, fallbackStaff),
    method: "round-robin"
  };
}

function repairSalamStaffAssignments(runtime) {
  if (!runtime?.records?.length) return runtime;
  const staffList = COMPANY_TEAM_DIRECTORY["salam-land"].staff;
  let repairedCount = 0;

  runtime.records = runtime.records.map((record) => {
    if (record.companyId !== "salam-land") return record;
    const normalizedStaff = normalizeStaffName(record.companyId, record.staff, record);
    const marketingText = marketingTextForRecord(runtime, record);
    const staffFromCampaign = inferStaffFromMarketingText(record.companyId, ...marketingText);
    if (staffList.includes(normalizedStaff)) {
      if (staffFromCampaign && staffFromCampaign !== normalizedStaff) {
        repairedCount += 1;
        const details = {
          ...(record.details || {}),
          assignmentMethod: "auto-repair-campaign-corrected",
          assignmentUpdatedAt: new Date().toISOString(),
          previousStaff: normalizedStaff
        };
        const notes = String(record.notes || "").includes("Auto corrected by campaign")
          ? record.notes
          : [record.notes, `Auto corrected by campaign to ${staffFromCampaign}.`].filter(Boolean).join(" ");
        return {
          ...record,
          staff: staffFromCampaign,
          details,
          notes
        };
      }
      return normalizedStaff === record.staff ? record : { ...record, staff: normalizedStaff };
    }

    const platform = platformForAssignment(record);
    const assignment = assignMarketingStaff(
      runtime,
      record.companyId,
      platform,
      COMPANY_DEFAULTS["salam-land"].defaultStaff,
      ...marketingText
    );
    if (!assignment.staff) return { ...record, staff: "" };
    repairedCount += 1;
    const previousAssignment = String(record.details?.assignmentMethod || "");
    const details = {
      ...(record.details || {}),
      assignmentMethod: previousAssignment || `auto-repair-${assignment.method}`,
      assignmentUpdatedAt: record.details?.assignmentUpdatedAt || new Date().toISOString()
    };
    const autoNote = assignment.method === "campaign"
      ? `Auto assigned by campaign to ${assignment.staff}.`
      : `Auto assigned by round-robin to ${assignment.staff}.`;
    const notes = String(record.notes || "").includes("Auto assigned by")
      ? record.notes
      : [record.notes, autoNote].filter(Boolean).join(" ");
    return {
      ...record,
      staff: assignment.staff,
      details,
      notes
    };
  });

  if (repairedCount) {
    runtime.control = mergeControl(runtime.control);
    runtime.control.activity = [
      {
        id: createId("act"),
        at: new Date().toISOString(),
        action: "Auto assign repaired",
        companyId: "salam-land",
        detail: `${repairedCount} Salam Land record assigned to team sales.`
      },
      ...runtime.control.activity
    ].slice(0, 100);
  }
  return runtime;
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}

function firstNonZeroNumber(...values) {
  for (const value of values) {
    if (value === undefined || value === null || value === "") continue;
    const number = safeNumber(value);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return 0;
}

function leadActionCount(actions = []) {
  if (!Array.isArray(actions)) return 0;
  return actions.reduce((sum, action) => {
    const type = String(action.action_type || "").toLowerCase();
    const normalizedType = type.replace(/[^a-z0-9]+/g, " ");
    const isLeadAction = type === "lead"
      || type.includes("leadgen")
      || type.includes("lead_grouped")
      || type.includes("lead_form")
      || type.includes("fb_pixel_lead")
      || type.includes("messaging_conversation")
      || type.includes("onsite_conversion.messaging")
      || type.includes("messenger")
      || type.endsWith(".lead")
      || normalizedType.split(/\s+/).includes("messaging")
      || normalizedType.split(/\s+/).includes("conversation")
      || normalizedType.split(/\s+/).includes("lead");
    return isLeadAction ? sum + safeNumber(action.value) : sum;
  }, 0);
}

function normalizeDailyInsights(rows = []) {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => ({
    date: String(row.date_start || row.dateStart || row.date || "").slice(0, 10),
    spend: safeNumber(row.spend),
    adsManagerLeads: firstNonZeroNumber(
      row.leads,
      row.results,
      row.total_results,
      leadActionCount(row.actions),
      leadActionCount(row.conversions),
      leadActionCount(row.action_values)
    )
  })).filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.date));
}

function mergeDailyInsights(existingRows = [], incomingRows = []) {
  const map = new Map();
  [...(Array.isArray(existingRows) ? existingRows : []), ...(Array.isArray(incomingRows) ? incomingRows : [])].forEach((row) => {
    const normalized = normalizeDailyInsights([row])[0];
    if (!normalized) return;
    map.set(normalized.date, normalized);
  });
  return Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
}

function buildExternalCampaignKey(externalPlatform, externalCampaignId = "", externalAdId = "") {
  return [externalPlatform, externalCampaignId || externalAdId].filter(Boolean).join(":");
}

function normalizeMetaAdAccountId(value = "") {
  return String(value || "").trim().replace(/^act_/i, "").replace(/[^\d]/g, "");
}

function upsertCampaign(runtime, payload) {
  const {
    companyId,
    platform,
    internalCampaignId = "",
    externalPlatform = "",
    externalCampaignId = "",
    externalAdId = "",
    name = "",
    spend,
    adsManagerLeads,
    dailyInsights,
    createdAt = localIsoDate(new Date()),
    spendUpdatedAt = new Date().toISOString()
  } = payload;

  let existing = null;
  if (internalCampaignId) {
    existing = runtime.campaigns.find((campaign) => campaign.id === internalCampaignId && campaign.companyId === companyId) || null;
  }
  if (!existing && externalPlatform && (externalCampaignId || externalAdId)) {
    const externalKey = buildExternalCampaignKey(externalPlatform, externalCampaignId, externalAdId);
    existing = runtime.campaigns.find((campaign) => campaign.companyId === companyId && buildExternalCampaignKey(campaign.externalPlatform, campaign.externalCampaignId, campaign.externalAdId) === externalKey) || null;
  }
  if (!existing && name) {
    existing = runtime.campaigns.find((campaign) => campaign.companyId === companyId && campaign.platform === platform && campaign.name === name) || null;
  }

  const nextCampaign = {
    id: existing?.id || internalCampaignId || createId("camp"),
    companyId,
    platform,
    name: firstNonEmptyString(name, existing?.name, `${platform} auto campaign`),
    spend: Number.isFinite(safeNumber(spend)) ? safeNumber(spend) : safeNumber(existing?.spend),
    createdAt: existing?.createdAt || createdAt,
    externalPlatform: firstNonEmptyString(externalPlatform, existing?.externalPlatform),
    externalCampaignId: firstNonEmptyString(externalCampaignId, existing?.externalCampaignId),
    externalAdId: firstNonEmptyString(externalAdId, existing?.externalAdId),
    ...([adsManagerLeads, existing?.adsManagerLeads].some((value) => value !== undefined && value !== null && value !== "")
      ? { adsManagerLeads: safeNumber(adsManagerLeads !== undefined && adsManagerLeads !== null && adsManagerLeads !== "" ? adsManagerLeads : existing?.adsManagerLeads) }
      : {}),
    dailyInsights: mergeDailyInsights(existing?.dailyInsights, dailyInsights),
    spendUpdatedAt
  };

  if (existing) {
    runtime.campaigns = runtime.campaigns.map((campaign) => (campaign.id === existing.id ? nextCampaign : campaign));
  } else {
    runtime.campaigns.unshift(nextCampaign);
  }

  return nextCampaign;
}

function applyMetaInsightDateParams(url, options = {}) {
  const since = String(options.dateFrom || "").slice(0, 10);
  const until = String(options.dateTo || "").slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(since) && /^\d{4}-\d{2}-\d{2}$/.test(until)) {
    url.searchParams.set("time_range", JSON.stringify({ since, until }));
  } else {
    url.searchParams.set("date_preset", "this_month");
  }
  url.searchParams.set("time_increment", "1");
}

async function fetchMetaCampaignInsightsSnapshot(connection, runtime, campaignId = "", options = {}) {
  const token = String(connection.metaSpendAccessToken || connection.metaAccessToken || "").trim();
  if (!connection.metaSpendSyncEnabled || !token || !campaignId) return null;

  const apiVersion = runtime.integrations.meta.apiVersion || "v22.0";
  const campaignUrl = new URL(`https://graph.facebook.com/${apiVersion}/${campaignId}`);
  campaignUrl.searchParams.set("fields", "name");
  campaignUrl.searchParams.set("access_token", token);

  const insightsUrl = new URL(`https://graph.facebook.com/${apiVersion}/${campaignId}/insights`);
  insightsUrl.searchParams.set("fields", "spend,campaign_id,campaign_name,actions,conversions,date_start,date_stop");
  applyMetaInsightDateParams(insightsUrl, options);
  insightsUrl.searchParams.set("access_token", token);

  const [campaignMeta, campaignInsights] = await Promise.all([
    fetchRemoteJson(campaignUrl.toString()).catch(() => null),
    fetchRemoteJson(insightsUrl.toString())
  ]);

  const insightRows = Array.isArray(campaignInsights?.data) ? campaignInsights.data : [];
  const insightRow = insightRows[0] || {};
  const dailyInsights = normalizeDailyInsights(insightRows);
  const externalCampaignId = firstNonEmptyString(insightRow?.campaign_id, campaignId);
  const campaignName = firstNonEmptyString(insightRow?.campaign_name, campaignMeta?.name, `Meta ${campaignId}`);
  const spend = dailyInsights.reduce((sum, row) => sum + safeNumber(row.spend), 0);
  const adsManagerLeads = dailyInsights.reduce((sum, row) => sum + safeNumber(row.adsManagerLeads), 0);

  if (!externalCampaignId && !campaignName && !spend && !adsManagerLeads) return null;

  return {
    externalPlatform: "meta",
    externalCampaignId,
    externalAdId: "",
    name: campaignName,
    spend,
    adsManagerLeads,
    dailyInsights,
    spendUpdatedAt: new Date().toISOString()
  };
}

async function fetchMetaAdAccountCampaignSnapshots(connection, runtime, options = {}) {
  const token = String(connection.metaSpendAccessToken || connection.metaAccessToken || "").trim();
  const adAccountId = normalizeMetaAdAccountId(connection.metaAdAccountId || "");
  if (!connection.metaSpendSyncEnabled || !token || !adAccountId) return [];

  const apiVersion = runtime.integrations.meta.apiVersion || "v22.0";
  let nextUrl = new URL(`https://graph.facebook.com/${apiVersion}/act_${adAccountId}/insights`);
  nextUrl.searchParams.set("level", "campaign");
  nextUrl.searchParams.set("fields", "spend,campaign_id,campaign_name,actions,conversions,date_start,date_stop");
  applyMetaInsightDateParams(nextUrl, options);
  nextUrl.searchParams.set("limit", "500");
  nextUrl.searchParams.set("access_token", token);

  const rows = [];
  for (let page = 0; nextUrl && page < 10; page += 1) {
    const response = await fetchRemoteJson(nextUrl.toString());
    rows.push(...(Array.isArray(response?.data) ? response.data : []));
    nextUrl = response?.paging?.next ? new URL(response.paging.next) : null;
  }

  const campaignMap = new Map();
  for (const row of rows) {
    const externalCampaignId = firstNonEmptyString(row.campaign_id, row.campaignId);
    const campaignName = firstNonEmptyString(row.campaign_name, row.campaignName, externalCampaignId ? `Meta ${externalCampaignId}` : "Meta account campaign");
    const key = externalCampaignId || campaignName;
    if (!key) continue;

    const current = campaignMap.get(key) || {
      externalPlatform: "meta",
      externalCampaignId,
      externalAdId: "",
      name: campaignName,
      spend: 0,
      adsManagerLeads: 0,
      dailyInsights: [],
      spendUpdatedAt: new Date().toISOString()
    };
    const dailyRows = normalizeDailyInsights([row]);
    current.dailyInsights = mergeDailyInsights(current.dailyInsights, dailyRows);
    current.spend = current.dailyInsights.reduce((sum, item) => sum + safeNumber(item.spend), 0);
    current.adsManagerLeads = current.dailyInsights.reduce((sum, item) => sum + safeNumber(item.adsManagerLeads), 0);
    campaignMap.set(key, current);
  }

  return Array.from(campaignMap.values()).filter((snapshot) => snapshot.name || snapshot.externalCampaignId || snapshot.spend || snapshot.adsManagerLeads);
}

async function fetchMetaCampaignSnapshot(connection, runtime, adId = "", options = {}) {
  const token = String(connection.metaSpendAccessToken || connection.metaAccessToken || "").trim();
  if (!connection.metaSpendSyncEnabled || !token || !adId) return null;

  const apiVersion = runtime.integrations.meta.apiVersion || "v22.0";
  const adMetaUrl = new URL(`https://graph.facebook.com/${apiVersion}/${adId}`);
  adMetaUrl.searchParams.set("fields", "name,campaign{id,name}");
  adMetaUrl.searchParams.set("access_token", token);

  const adMeta = await fetchRemoteJson(adMetaUrl.toString());
  const insightNodeId = firstNonEmptyString(adMeta?.campaign?.id, adId);
  const adInsightsUrl = new URL(`https://graph.facebook.com/${apiVersion}/${insightNodeId}/insights`);
  adInsightsUrl.searchParams.set("fields", "spend,campaign_id,campaign_name,actions,conversions,date_start,date_stop");
  applyMetaInsightDateParams(adInsightsUrl, options);
  adInsightsUrl.searchParams.set("access_token", token);

  const adInsights = await fetchRemoteJson(adInsightsUrl.toString());

  const insightRows = Array.isArray(adInsights?.data) ? adInsights.data : [];
  const insightRow = insightRows[0] || {};
  const dailyInsights = normalizeDailyInsights(insightRows);
  const externalCampaignId = firstNonEmptyString(adMeta?.campaign?.id, insightRow?.campaign_id);
  const campaignName = firstNonEmptyString(adMeta?.campaign?.name, insightRow?.campaign_name, adMeta?.name, `Meta ${adId}`);
  const spend = dailyInsights.length
    ? dailyInsights.reduce((sum, row) => sum + safeNumber(row.spend), 0)
    : firstNonZeroNumber(insightRow?.spend);
  const adsManagerLeads = dailyInsights.length
    ? dailyInsights.reduce((sum, row) => sum + safeNumber(row.adsManagerLeads), 0)
    : firstNonZeroNumber(insightRow?.leads, insightRow?.results, leadActionCount(insightRow?.actions), leadActionCount(insightRow?.conversions));

  if (!externalCampaignId && !campaignName && !spend && !adsManagerLeads) return null;

  return {
    externalPlatform: "meta",
    externalCampaignId,
    externalAdId: String(adId || ""),
    name: campaignName,
    spend,
    adsManagerLeads,
    dailyInsights,
    spendUpdatedAt: new Date().toISOString()
  };
}

function extractTikTokCampaignSnapshot(connection, payload) {
  if (!connection.tiktokSpendSyncEnabled) return null;
  const source = payload.data || payload.lead || payload || {};
  const map = fieldMapFromLeadSource(source);
  const externalCampaignId = firstNonEmptyString(
    source.campaign_id,
    source.campaignId,
    source.adgroup_campaign_id,
    source.adgroupCampaignId,
    source.ad_group_id,
    source.adgroup_id,
    source.adGroupId,
    pickField(map, ["campaign_id", "campaign id", "campaignid", "tt_campaign_id", "ad group id", "adgroup id", "ad_group_id"])
  );
  const externalAdId = firstNonEmptyString(
    source.ad_id,
    source.adId,
    source.creative_id,
    source.adgroup_id,
    source.adGroupId,
    source.ad_group_id,
    pickField(map, ["ad_id", "ad id", "adid", "tt_ad_id", "creative id", "ad group id", "adgroup id", "ad_group_id"])
  );
  const campaignName = firstNonEmptyString(
    source.campaign_name,
    source.campaignName,
    source.campaign,
    source.adgroup_name,
    source.adgroupName,
    source.ad_group_name,
    source.ad_name,
    source.adName,
    pickField(map, ["campaign_name", "campaign name", "campaign", "tt_campaign_name", "ad group", "ad group name", "adgroup", "adgroup name", "ad name", "ad_name"])
  );
  const spend = firstNonZeroNumber(
    source.spend,
    source.cost,
    source.total_spend,
    source.amount_spent,
    pickField(map, ["spend", "cost", "total_spend", "amount_spent", "ad_spend"])
  );
  const adsManagerLeads = firstNonZeroNumber(
    source.leads,
    source.lead_count,
    source.leadCount,
    source.results,
    pickField(map, ["leads", "lead_count", "leadcount", "results"])
  );

  if (!externalCampaignId && !campaignName && !spend && !adsManagerLeads && !connection.tiktokCampaignId) return null;

  return {
    externalPlatform: "tiktok",
    externalCampaignId,
    externalAdId,
    name: firstNonEmptyString(campaignName, externalCampaignId ? `TikTok ${externalCampaignId}` : ""),
    spend,
    adsManagerLeads,
    dailyInsights: normalizeDailyInsights(source.daily_insights || source.dailyInsights || source.insights),
    spendUpdatedAt: new Date().toISOString()
  };
}

function tiktokMetricValue(metrics = {}, keys = []) {
  for (const key of keys) {
    if (metrics[key] !== undefined && metrics[key] !== null && metrics[key] !== "") {
      return metrics[key];
    }
  }
  return "";
}

function normalizeTikTokReportRows(rows = []) {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => {
    const dimensions = row.dimensions || row.dimension || {};
    const metrics = row.metrics || row.metric || {};
    const campaignId = firstNonEmptyString(
      dimensions.campaign_id,
      dimensions.campaignId,
      metrics.campaign_id,
      metrics.campaignId
    );
    const campaignName = firstNonEmptyString(
      metrics.campaign_name,
      metrics.campaignName,
      dimensions.campaign_name,
      dimensions.campaignName,
      campaignId ? `TikTok ${campaignId}` : "TikTok campaign"
    );
    return {
      date: String(firstNonEmptyString(dimensions.stat_time_day, dimensions.statTimeDay, metrics.stat_time_day, metrics.statTimeDay)).slice(0, 10),
      externalCampaignId: campaignId,
      name: campaignName,
      spend: safeNumber(tiktokMetricValue(metrics, ["spend", "real_time_spend", "cost"])),
      adsManagerLeads: firstNonZeroNumber(
        tiktokMetricValue(metrics, ["conversion", "conversions"]),
        tiktokMetricValue(metrics, ["real_time_conversion", "realTimeConversion"]),
        tiktokMetricValue(metrics, ["total_conversion", "totalConversions"]),
        tiktokMetricValue(metrics, ["lead", "leads", "result", "results"])
      )
    };
  }).filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.date));
}

function resolveTikTokCampaignName(runtime, connection, campaignId = "", campaignName = "") {
  const existingCampaign = (runtime.campaigns || []).find((campaign) => (
    campaign.companyId === connection.companyId
    && String(campaign.platform || "").toLowerCase().includes("tiktok")
    && (
      String(campaign.externalCampaignId || "") === String(campaignId || "")
      || (campaignName && String(campaign.name || "").toLowerCase() === String(campaignName).toLowerCase())
    )
  ));
  const existingRecord = (runtime.records || []).find((record) => (
    record.companyId === connection.companyId
    && String(record.source || "").toLowerCase().includes("tiktok")
    && (
      String(record.details?.tiktokCampaignId || "") === String(campaignId || "")
      || (campaignName && String(record.details?.tiktokCampaignName || "").toLowerCase() === String(campaignName).toLowerCase())
    )
  ));
  return firstNonEmptyString(existingCampaign?.name, existingRecord?.details?.tiktokCampaignName, campaignName, campaignId ? `TikTok ${campaignId}` : "");
}

function tiktokReportRowMatchesStaff(runtime, connection, row, staff = "all", dateFrom = "", dateTo = "") {
  if (staff === "all") return true;
  const resolvedName = resolveTikTokCampaignName(runtime, connection, row.externalCampaignId, row.name);
  const hintedStaff = inferStaffFromMarketingText(connection.companyId, resolvedName, row.externalCampaignId);
  if (hintedStaff) return hintedStaff === staff;
  return (runtime.records || []).some((record) => (
    record.companyId === connection.companyId
    && String(record.source || "").toLowerCase().includes("tiktok")
    && normalizeStaffName(record.companyId, record.staff, record) === staff
    && dateInRange(recordSourceDate(record), dateFrom, dateTo)
    && (
      String(record.details?.tiktokCampaignId || "") === String(row.externalCampaignId || "")
      || String(record.details?.tiktokCampaignName || "").toLowerCase() === String(row.name || "").toLowerCase()
    )
  ));
}

async function fetchTikTokReportPage(connection, runtime, params = {}, metrics = []) {
  const accessToken = String(connection.tiktokAccessToken || process.env.TIKTOK_ACCESS_TOKEN || "").trim();
  const advertiserId = String(connection.tiktokAdvertiserId || process.env.TIKTOK_ADVERTISER_ID || "").trim();
  if (!accessToken) throw new Error("TikTok access token belum diisi untuk tarik spend Ads Manager.");
  if (!advertiserId) throw new Error("TikTok advertiser ID belum diisi untuk tarik spend Ads Manager.");

  const url = new URL(`${TIKTOK_BUSINESS_API_BASE}/open_api/v1.3/report/integrated/get/`);
  url.searchParams.set("advertiser_id", advertiserId);
  url.searchParams.set("report_type", "BASIC");
  url.searchParams.set("data_level", "AUCTION_CAMPAIGN");
  url.searchParams.set("dimensions", JSON.stringify(["campaign_id", "stat_time_day"]));
  url.searchParams.set("metrics", JSON.stringify(metrics));
  url.searchParams.set("start_date", params.dateFrom);
  url.searchParams.set("end_date", params.dateTo);
  url.searchParams.set("page", String(params.page || 1));
  url.searchParams.set("page_size", String(TIKTOK_REPORT_PAGE_SIZE));
  url.searchParams.set("service_type", "AUCTION");

  const payload = await fetchRemoteJson(url.toString(), {
    headers: {
      "Access-Token": accessToken
    }
  });
  if (payload?.code !== undefined && String(payload.code) !== "0") {
    throw new Error(`TikTok report failed: ${payload.message || payload.msg || payload.code}`);
  }
  return payload;
}

async function fetchTikTokCampaignInsightsSnapshots(connection, runtime, options = {}) {
  if (!connection.tiktokEnabled || !connection.tiktokSpendSyncEnabled) return [];
  const dateFrom = String(options.dateFrom || localIsoDate(new Date())).slice(0, 10);
  const dateTo = String(options.dateTo || dateFrom).slice(0, 10);
  const staff = String(options.staff || "all");
  const metricSets = [
    ["spend", "conversion", "real_time_conversion", "campaign_name"],
    ["spend", "conversion", "campaign_name"],
    ["spend", "conversion"]
  ];
  let lastError = null;
  for (const metrics of metricSets) {
    try {
      const reportRows = [];
      for (let page = 1; page <= TIKTOK_REPORT_MAX_PAGES; page += 1) {
        const payload = await fetchTikTokReportPage(connection, runtime, { dateFrom, dateTo, page }, metrics);
        const list = Array.isArray(payload?.data?.list) ? payload.data.list : [];
        reportRows.push(...normalizeTikTokReportRows(list));
        const pageInfo = payload?.data?.page_info || payload?.data?.pageInfo || {};
        const totalPage = Number(pageInfo.total_page || pageInfo.totalPage || 0);
        if (!list.length || (totalPage && page >= totalPage) || (!totalPage && list.length < TIKTOK_REPORT_PAGE_SIZE)) break;
      }

      const grouped = new Map();
      reportRows
        .filter((row) => dateInRange(row.date, dateFrom, dateTo))
        .filter((row) => tiktokReportRowMatchesStaff(runtime, connection, row, staff, dateFrom, dateTo))
        .forEach((row) => {
          const campaignName = resolveTikTokCampaignName(runtime, connection, row.externalCampaignId, row.name);
          const key = row.externalCampaignId || campaignName;
          if (!key) return;
          const existing = grouped.get(key) || {
            externalPlatform: "tiktok",
            externalCampaignId: row.externalCampaignId,
            externalAdId: "",
            name: campaignName,
            spend: 0,
            adsManagerLeads: 0,
            dailyInsights: [],
            spendUpdatedAt: new Date().toISOString()
          };
          existing.spend += row.spend;
          existing.adsManagerLeads += row.adsManagerLeads;
          existing.dailyInsights.push({
            date: row.date,
            spend: row.spend,
            adsManagerLeads: row.adsManagerLeads
          });
          grouped.set(key, existing);
        });

      return Array.from(grouped.values());
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  return [];
}

function recordDateFromPayload(payload) {
  const source = payload.data || payload.lead || payload || {};
  const map = fieldMapFromLeadSource(source);
  const createdTime = firstNonEmptyString(
    source.created_at,
    source.createdAt,
    source.created_time,
    source.createdTime,
    source.create_time,
    source.createTime,
    source.submit_time,
    source.submitTime,
    source.submitted_at,
    source.submittedAt,
    pickField(map, [
      "created_at",
      "created at",
      "created time",
      "create time",
      "submit time",
      "submitted at",
      "submission time",
      "lead date",
      "date created",
      "created date",
      "created",
      "date",
      "time"
    ])
  );
  return safeLocalIsoDate(createdTime);
}

function syncCampaignFromSnapshot(runtime, connection, platform, snapshot, fallbackInternalCampaignId = "", createdAt = localIsoDate(new Date())) {
  if (!snapshot) return null;
  const nextCampaign = upsertCampaign(runtime, {
    companyId: connection.companyId,
    platform,
    internalCampaignId: fallbackInternalCampaignId,
    externalPlatform: snapshot.externalPlatform,
    externalCampaignId: snapshot.externalCampaignId,
    externalAdId: snapshot.externalAdId,
    name: snapshot.name,
    spend: snapshot.spend,
    adsManagerLeads: snapshot.adsManagerLeads,
    dailyInsights: snapshot.dailyInsights,
    createdAt,
    spendUpdatedAt: snapshot.spendUpdatedAt
  });
  return {
    internalCampaignId: nextCampaign.id,
    campaignName: nextCampaign.name,
    spend: nextCampaign.spend,
    adsManagerLeads: nextCampaign.adsManagerLeads,
    spendUpdatedAt: nextCampaign.spendUpdatedAt,
    externalCampaignId: snapshot.externalCampaignId,
    externalAdId: snapshot.externalAdId,
    sourceMode: snapshot.externalPlatform === "meta" ? "api" : "payload"
  };
}

function dateInRange(value = "", dateFrom = "", dateTo = "") {
  const date = String(value || "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date)
    && (!dateFrom || date >= dateFrom)
    && (!dateTo || date <= dateTo);
}

function campaignStaffHintForSync(campaign = {}, companyId = "") {
  const directStaff = normalizeStaffName(companyId, firstNonEmptyString(campaign.staff, campaign.staffName, campaign.teamSales));
  if (directStaff) return directStaff;
  return inferStaffFromMarketingText(companyId, campaign.name, campaign.externalCampaignId, campaign.externalAdId);
}

function addMetaSpendTarget(targets, target = {}) {
  const adId = String(target.adId || "").trim();
  const campaignId = String(target.campaignId || "").trim();
  if (!adId && !campaignId) return;
  const key = adId ? `ad:${adId}` : `campaign:${campaignId}`;
  if (targets.has(key)) {
    const existing = targets.get(key);
    targets.set(key, {
      ...existing,
      internalCampaignId: existing.internalCampaignId || target.internalCampaignId || "",
      createdAt: existing.createdAt || target.createdAt || ""
    });
    return;
  }
  targets.set(key, {
    adId,
    campaignId,
    internalCampaignId: String(target.internalCampaignId || ""),
    createdAt: String(target.createdAt || "")
  });
}

function collectMetaSpendTargets(runtime, connection, options = {}) {
  const dateFrom = String(options.dateFrom || "").slice(0, 10);
  const dateTo = String(options.dateTo || "").slice(0, 10);
  const staffFilter = String(options.staff || "all");
  const targets = new Map();

  (runtime.records || []).forEach((record) => {
    if (record.companyId !== connection.companyId) return;
    if (staffFilter !== "all" && normalizeStaffName(record.companyId, record.staff, record) !== staffFilter) return;
    if (!dateInRange(recordSourceDate(record), dateFrom, dateTo)) return;
    const campaign = (runtime.campaigns || []).find((item) => item.id === record.campaignId) || {};
    const details = record.details || {};
    addMetaSpendTarget(targets, {
      adId: firstNonEmptyString(details.metaAdId, campaign.externalAdId),
      campaignId: firstNonEmptyString(details.metaCampaignId, campaign.externalCampaignId),
      internalCampaignId: record.campaignId || campaign.id || "",
      createdAt: recordSourceDate(record)
    });
  });

  (runtime.campaigns || []).forEach((campaign) => {
    if (campaign.companyId !== connection.companyId) return;
    if (String(campaign.externalPlatform || "").toLowerCase() !== "meta" && !String(campaign.platform || "").toLowerCase().includes("meta")) return;
    const hintedStaff = campaignStaffHintForSync(campaign, connection.companyId);
    if (staffFilter !== "all" && hintedStaff && hintedStaff !== staffFilter) return;
    addMetaSpendTarget(targets, {
      adId: campaign.externalAdId,
      campaignId: campaign.externalCampaignId,
      internalCampaignId: campaign.id,
      createdAt: campaign.createdAt || dateFrom
    });
  });

  return Array.from(targets.values());
}

async function syncAdsSpendForReport(runtime, options = {}) {
  const companyId = String(options.companyId || "");
  const dateFrom = String(options.dateFrom || "").slice(0, 10);
  const dateTo = String(options.dateTo || dateFrom).slice(0, 10);
  const staff = String(options.staff || "all");
  const result = {
    ok: true,
    companyId,
    dateFrom,
    dateTo,
    staff,
    metaTargets: 0,
    metaSynced: 0,
    tiktokSynced: 0,
    errors: []
  };

  for (const connection of runtime.integrations.connections || []) {
    if (connection.companyId !== companyId) continue;
    if (connection.metaEnabled && connection.metaSpendSyncEnabled && (connection.metaSpendAccessToken || connection.metaAccessToken)) {
      const targets = collectMetaSpendTargets(runtime, connection, { dateFrom, dateTo, staff });
      result.metaTargets += targets.length;
      for (const target of targets) {
        try {
          const snapshot = target.adId
            ? await fetchMetaCampaignSnapshot(connection, runtime, target.adId, { dateFrom, dateTo })
            : await fetchMetaCampaignInsightsSnapshot(connection, runtime, target.campaignId, { dateFrom, dateTo });
          if (!snapshot) continue;
          syncCampaignFromSnapshot(runtime, connection, "Meta Ads", snapshot, target.internalCampaignId, target.createdAt || dateFrom || localIsoDate(new Date()));
          result.metaSynced += 1;
        } catch (error) {
          result.errors.push({
            platform: "Meta Ads",
            target: target.adId || target.campaignId,
            message: error.message
          });
        }
      }

      try {
        const accountSnapshots = await fetchMetaAdAccountCampaignSnapshots(connection, runtime, { dateFrom, dateTo });
        result.metaTargets += accountSnapshots.length;
        for (const snapshot of accountSnapshots) {
          syncCampaignFromSnapshot(runtime, connection, "Meta Ads", snapshot, "", dateFrom || localIsoDate(new Date()));
          result.metaSynced += 1;
        }
      } catch (error) {
        result.errors.push({
          platform: "Meta Ads",
          target: normalizeMetaAdAccountId(connection.metaAdAccountId) ? `act_${normalizeMetaAdAccountId(connection.metaAdAccountId)}` : "missing-ad-account",
          message: error.message
        });
      }
    }

    if (connection.tiktokEnabled && connection.tiktokSpendSyncEnabled) {
      try {
        const snapshots = await fetchTikTokCampaignInsightsSnapshots(connection, runtime, { dateFrom, dateTo, staff });
        for (const snapshot of snapshots) {
          syncCampaignFromSnapshot(runtime, connection, "TikTok Ads", snapshot, connection.tiktokCampaignId || "", dateFrom || localIsoDate(new Date()));
          result.tiktokSynced += 1;
        }
      } catch (error) {
        result.errors.push({
          platform: "TikTok Ads",
          target: connection.tiktokAdvertiserId || "missing-advertiser",
          message: error.message
        });
      }
    }
  }

  return result;
}

async function testMetaConnection(runtime, connection) {
  const token = String(connection.metaSpendAccessToken || connection.metaAccessToken || "").trim();
  const adAccountId = normalizeMetaAdAccountId(connection.metaAdAccountId || "");
  const apiVersion = runtime.integrations.meta.apiVersion || "v22.0";

  if (!adAccountId) {
    return {
      ok: false,
      status: "missing_ad_account_id",
      message: "Meta Ad Account ID belum diisi."
    };
  }

  if (!token) {
    return {
      ok: false,
      status: "missing_token",
      adAccountId,
      message: "Meta token untuk Bumi Hayat belum diisi."
    };
  }

  const accountUrl = new URL(`https://graph.facebook.com/${apiVersion}/act_${adAccountId}`);
  accountUrl.searchParams.set("fields", "account_id,name,account_status");
  accountUrl.searchParams.set("access_token", token);

  try {
    const account = await fetchRemoteJson(accountUrl.toString());
    return {
      ok: true,
      status: "connected",
      adAccountId,
      accountName: account?.name || "",
      accountStatus: account?.account_status || "",
      spendSyncEnabled: Boolean(connection.metaSpendSyncEnabled),
      leadSyncEnabled: Boolean(connection.metaEnabled),
      hasPageId: Boolean(connection.metaPageId),
      formCount: parseDelimitedIds(connection.metaFormIds).length
    };
  } catch (error) {
    return {
      ok: false,
      status: "token_no_access",
      adAccountId,
      message: error.message
    };
  }
}

function buildMetaRecord(runtime, connection, lead, campaignSync = null) {
  const template = COMPANY_DEFAULTS[connection.companyId];
  const map = fieldMapFromArray(lead.field_data);
  const metaText = [
    campaignSync?.campaignName,
    lead.campaign_name,
    lead.adset_name,
    lead.ad_name,
    campaignSync?.externalCampaignId,
    campaignSync?.externalAdId
  ];
  const fullName = pickField(map, ["full_name", "name"]) || [pickField(map, ["first_name"]), pickField(map, ["last_name"])].filter(Boolean).join(" ").trim() || "Meta Lead";
  const phone = normalizePhone(pickField(map, ["phone_number", "phone", "mobile_number"]));
  const rawProduct = pickField(map, ["product", "produk", "jenis_tanah", "jenis_emas", "kategori", "category"]) || template.defaultProduct;
  const product = normalizeSalamProductName(connection.companyId, rawProduct, ...metaText);
  const projectLocation = connection.companyId === "salam-land"
    ? cleanSalamProjectLabel(pickField(map, ["project", "projek", "daerah", "lokasi", "lokasi_tanah", "kawasan", "area"]))
      || inferSalamProjectLabel(...metaText, rawProduct)
    : "";
  const units = safeNumber(pickField(map, ["grams", "gram", "quantity", "qty", "target gram"]));
  const staffAssignment = assignMarketingStaff(
    runtime,
    connection.companyId,
    "meta",
    connection.metaDefaultStaff || template.defaultStaff,
    ...metaText
  );
  const createdAt = lead.created_time ? localIsoDate(new Date(lead.created_time)) : localIsoDate(new Date());

  return {
    id: createId("rec"),
    kind: "lead",
    companyId: connection.companyId,
    customerName: fullName,
    phone,
    source: "Meta Ads",
    campaignId: campaignSync?.internalCampaignId || connection.metaCampaignId || "",
    staff: staffAssignment.staff,
    product,
    status: connection.metaLeadStatus || template.defaultStatus,
    createdAt,
    nextFollowUp: isoOffsetFromDate(createdAt, FOLLOW_UP_DAYS),
    value: 0,
    units,
    actionFlags: normalizeActionFlags(),
    details: {
      ...map,
      externalPlatform: "meta",
      externalLeadId: String(lead.id || ""),
      metaCreatedTime: String(lead.created_time || ""),
      metaPageId: String(lead.page_id || ""),
      metaFormId: String(lead.form_id || ""),
      metaAdId: String(lead.ad_id || ""),
      metaAdName: String(lead.ad_name || ""),
      metaAdsetName: String(lead.adset_name || ""),
      metaPlatform: String(lead.platform || ""),
      metaCampaignId: String(campaignSync?.externalCampaignId || lead.campaign_id || ""),
      metaCampaignName: String(campaignSync?.campaignName || lead.campaign_name || ""),
      metaSpendSnapshot: safeNumber(campaignSync?.spend),
      metaSpendUpdatedAt: String(campaignSync?.spendUpdatedAt || ""),
      assignmentMethod: `auto-${staffAssignment.method}`,
      assignmentUpdatedAt: new Date().toISOString(),
      ...(projectLocation ? { projectLocation, location: projectLocation } : {})
    },
    notes: `Auto captured from Meta Lead Ads webhook. ${staffAssignment.method === "campaign" ? "Auto assigned by campaign." : "Auto assigned by round-robin."}`
  };
}

function buildTikTokRecord(runtime, connection, payload, campaignSync = null) {
  const template = COMPANY_DEFAULTS[connection.companyId];
  const source = payload.data || payload.lead || payload;
  const map = fieldMapFromLeadSource(source);
  const externalLeadId = buildStableTikTokLeadId(source, map);
  const tiktokMarketingText = [
    campaignSync?.campaignName,
    source.campaign_name,
    source.campaignName,
    source.campaign,
    source.adgroup_name,
    source.adgroupName,
    source.ad_group_name,
    source.ad_name,
    source.adName,
    pickField(map, ["campaign_name", "campaign name", "campaign", "source campaign", "ad group", "ad group name", "adgroup", "adgroup name", "ad name", "ad_name"])
  ];
  const fullName = firstNonEmptyString(
    pickField(map, ["full_name", "full name", "name", "customer_name", "customer name", "contact name", "client name", "nama", "nama penuh"]),
    [pickField(map, ["first name", "first_name", "firstname", "given name"]), pickField(map, ["last name", "last_name", "lastname", "surname"])].filter(Boolean).join(" ").trim(),
    source.full_name,
    source.fullName,
    source.name,
    source.customer_name,
    source.customerName,
    "TikTok Lead"
  );
  const phone = normalizePhone(firstNonEmptyString(
    pickField(map, ["phone_number", "phone number", "phone", "mobile", "mobile_number", "mobile number", "whatsapp", "whatsapp number", "no telefon", "nombor telefon", "no hp", "no phone", "nombor", "number"]),
    source.phone_number,
    source.phoneNumber,
    source.phone,
    source.mobile_number,
    source.mobileNumber
  ));
  const rawProduct = pickField(map, ["product", "produk", "kategori", "category", "jenis_tanah", "jenis tanah", "jenis_emas", "jenis emas"]) || template.defaultProduct;
  const product = normalizeSalamProductName(connection.companyId, rawProduct, ...tiktokMarketingText);
  const projectLocation = connection.companyId === "salam-land"
    ? cleanSalamProjectLabel(pickField(map, ["project", "projek", "daerah", "lokasi", "lokasi_tanah", "lokasi tanah", "kawasan", "area"]))
      || inferSalamProjectLabel(...tiktokMarketingText, rawProduct)
    : "";
  const units = safeNumber(pickField(map, ["grams", "gram", "quantity", "qty", "kuantiti"]));
  const createdTime = firstNonEmptyString(
    source.created_at,
    source.createdAt,
    source.created_time,
    source.createdTime,
    source.create_time,
    source.createTime,
    source.submit_time,
    source.submitTime,
    pickField(map, ["created_at", "created at", "created time", "create time", "submit time", "submitted at", "submission time", "lead date", "date created", "created date", "date", "time"])
  );
  const createdAt = safeLocalIsoDate(createdTime);
  const staffAssignment = assignMarketingStaff(
    runtime,
    connection.companyId,
    "tiktok",
    connection.tiktokDefaultStaff || template.defaultStaff,
    ...tiktokMarketingText
  );

  return {
    id: createId("rec"),
    kind: "lead",
    companyId: connection.companyId,
    customerName: fullName,
    phone,
    source: "TikTok Ads",
    campaignId: campaignSync?.internalCampaignId || connection.tiktokCampaignId || "",
    staff: staffAssignment.staff,
    product,
    status: connection.tiktokLeadStatus || template.defaultStatus,
    createdAt,
    nextFollowUp: isoOffsetFromDate(createdAt, FOLLOW_UP_DAYS),
    value: 0,
    units,
    actionFlags: normalizeActionFlags(),
    details: {
      ...map,
      externalPlatform: "tiktok",
      externalLeadId,
      tiktokCreatedTime: String(createdTime || ""),
      tiktokFormId: String(source.form_id || source.formId || pickField(map, ["form_id", "form id", "instant form id"]) || ""),
      tiktokAdvertiserId: String(source.advertiser_id || source.advertiserId || pickField(map, ["advertiser_id", "advertiser id", "advertiser"]) || ""),
      tiktokCampaignId: String(campaignSync?.externalCampaignId || source.campaign_id || source.campaignId || pickField(map, ["campaign_id", "campaign id", "ad group id", "adgroup id"]) || ""),
      tiktokCampaignName: String(campaignSync?.campaignName || source.campaign_name || source.campaignName || source.campaign || source.adgroup_name || source.adgroupName || pickField(map, ["campaign_name", "campaign name", "campaign", "source campaign", "ad group", "ad group name", "adgroup name"]) || ""),
      tiktokAdGroupId: String(source.adgroup_id || source.adGroupId || source.ad_group_id || pickField(map, ["ad group id", "adgroup id", "ad_group_id"]) || ""),
      tiktokAdGroupName: String(source.adgroup_name || source.adgroupName || source.ad_group_name || pickField(map, ["ad group", "ad group name", "adgroup", "adgroup name", "ad_group_name"]) || ""),
      tiktokAdName: String(source.ad_name || source.adName || pickField(map, ["ad name", "ad_name", "creative name"]) || ""),
      tiktokSpendSnapshot: safeNumber(campaignSync?.spend),
      tiktokSpendUpdatedAt: String(campaignSync?.spendUpdatedAt || ""),
      assignmentMethod: `auto-${staffAssignment.method}`,
      assignmentUpdatedAt: new Date().toISOString(),
      ...(projectLocation ? { projectLocation, location: projectLocation } : {})
    },
    notes: `Auto captured from TikTok lead webhook. ${staffAssignment.method === "campaign" ? "Auto assigned by campaign." : "Auto assigned by round-robin."}`
  };
}

async function captureTikTokLeadSource(runtime, connection, source, payload = {}, options = {}) {
  const advertiserId = firstNonEmptyString(source.advertiser_id, source.advertiserId, payload.advertiser_id, payload.advertiserId);
  const formId = firstNonEmptyString(source.form_id, source.formId, source.instant_form_id, source.instantFormId, payload.form_id, payload.formId);

  if (rememberTikTokFormId(connection, formId)) {
    pushInboundEvent(runtime, {
      source: "tiktok",
      status: "form-auto-mapped",
      summary: `TikTok form ${formId} auto dipetakan kepada ${connection.companyId}.`,
      payload: { advertiserId, formId }
    });
  }

  const leadPayload = { data: { ...source, advertiser_id: advertiserId, form_id: formId } };
  const campaignSnapshot = extractTikTokCampaignSnapshot(connection, leadPayload);
  const campaignSync = syncCampaignFromSnapshot(runtime, connection, "TikTok Ads", campaignSnapshot, connection.tiktokCampaignId || "", recordDateFromPayload(leadPayload));
  const record = applyDuplicateLeadStatus(runtime, buildTikTokRecord(runtime, connection, leadPayload, campaignSync));
  const duplicateById = hasExternalLead(runtime, "tiktok", record.details.externalLeadId);
  const duplicateByFingerprint = hasSimilarExternalLead(runtime, record);

  if (duplicateById || duplicateByFingerprint) {
    pushInboundEvent(runtime, {
      source: "tiktok",
      status: "duplicate",
      summary: `Lead TikTok ${record.details.externalLeadId} sudah ada dalam runtime.`,
      payload: {
        leadId: record.details.externalLeadId,
        companyId: connection.companyId,
        staff: record.staff,
        duplicateBy: duplicateById ? "external-id" : "phone-date-campaign"
      }
    });
    return { status: "duplicate", leadId: record.details.externalLeadId, staff: record.staff };
  }

  runtime.records.unshift(record);
  runtime.records = sortRecordsByRecency(runtime.records);
  pushInboundEvent(runtime, {
    source: "tiktok",
    status: "captured",
    summary: `Lead TikTok ${record.details.externalLeadId} berjaya dimasukkan ke ${connection.companyId}${campaignSync?.spend ? ` dengan spend ${campaignSync.spend}` : ""}.`,
    payload: { leadId: record.details.externalLeadId, companyId: connection.companyId, campaignId: record.campaignId || "", staff: record.staff }
  });

  if (options.notify !== false) {
    notifyTeamsalesLeadSubscribers(record).catch((error) => {
      console.warn(`TikTok push notification failed: ${error.message}`);
    });
  }
  if (options.sendWhatsApp !== false) {
    try {
      await sendWhatsAppIntroForLeadSafely(runtime, record, options.eventSource || "tiktok-webhook");
    } catch (error) {
      console.warn(`TikTok WhatsApp intro failed: ${error.message}`);
    }
  }
  return { status: "captured", leadId: record.details.externalLeadId, staff: record.staff };
}

function parseCsvRows(text = "") {
  const input = String(text || "").trim();
  if (!input) return [];
  const rows = [];
  let row = [];
  let value = "";
  let quoted = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    const next = input[index + 1];
    if (char === "\"") {
      if (quoted && next === "\"") {
        value += "\"";
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (char === "," && !quoted) {
      row.push(value);
      value = "";
      continue;
    }
    if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(value);
      if (row.some((cell) => String(cell || "").trim())) rows.push(row);
      row = [];
      value = "";
      continue;
    }
    value += char;
  }
  row.push(value);
  if (row.some((cell) => String(cell || "").trim())) rows.push(row);
  if (rows.length < 2) return [];

  const headers = rows[0].map((item) => String(item || "").trim());
  return rows.slice(1).map((cells) => headers.reduce((record, header, index) => {
    if (!header) return record;
    record[header] = String(cells[index] || "").trim();
    return record;
  }, {}));
}

function tiktokBackfillLeadSources(payload = {}) {
  const sources = [];
  if (typeof payload.csv === "string" && payload.csv.trim()) {
    sources.push(...parseCsvRows(payload.csv));
  }
  for (const key of ["leads", "rows", "records", "items", "submissions"]) {
    if (Array.isArray(payload[key])) sources.push(...payload[key]);
  }
  if (Array.isArray(payload)) sources.push(...payload);
  if (!sources.length) sources.push(...extractTikTokLeadSources(payload));
  return extractTikTokLeadSources(sources.length ? sources : payload);
}

function findTikTokBackfillConnection(runtime, companyId, advertiserId, formId) {
  const scopedCompanyId = String(companyId || "").trim();
  if (scopedCompanyId) return findConnection(runtime, scopedCompanyId);
  return findTikTokConnection(runtime, advertiserId, formId);
}

function normalizeBackfillBoundary(value = "", fallback = "") {
  const raw = String(value || "").trim();
  if (!raw) return fallback;
  return safeLocalIsoDate(raw).slice(0, 10);
}

async function handleTikTokLeadsBridgeBackfill(req, res) {
  if (req.method !== "POST") {
    return sendText(res, 405, "Method not allowed");
  }
  const user = await requireAuth(req, res);
  if (!user) return;
  if (!adminOnly(user)) return sendJson(res, 403, { ok: false, error: "Admin access required" });

  const body = await readBody(req, { maxBytes: REQUEST_BODY_LIMITS.backfill });
  let payload;
  try {
    payload = JSON.parse(body || "{}");
  } catch {
    return sendJson(res, 400, { ok: false, error: "Invalid JSON" });
  }

  const companyId = String(payload.companyId || "").trim();
  if (companyId && !canUserAccessCompany(user, companyId)) {
    return sendJson(res, 403, { ok: false, error: "Forbidden company scope" });
  }

  const dryRun = payload.dryRun !== false;
  const dateFrom = normalizeBackfillBoundary(payload.dateFrom || payload.from || payload.startDate, "");
  const dateTo = normalizeBackfillBoundary(payload.dateTo || payload.to || payload.endDate, "");
  const runtime = await ensureRuntimeState();
  const workingRuntime = dryRun ? JSON.parse(JSON.stringify(runtime)) : runtime;
  const leadSources = tiktokBackfillLeadSources(payload);
  const results = [];
  const counts = { captured: 0, duplicate: 0, unmapped: 0, invalid: 0, skippedDate: 0 };

  for (const source of leadSources) {
    if (!source || typeof source !== "object") {
      counts.invalid += 1;
      continue;
    }
    const enrichedSource = enrichTikTokLeadSource(source, payload);
    const leadDate = recordDateFromPayload(enrichedSource).slice(0, 10);
    if ((dateFrom && leadDate < dateFrom) || (dateTo && leadDate > dateTo)) {
      counts.skippedDate += 1;
      results.push({ status: "skipped-date", leadDate });
      continue;
    }
    const advertiserId = firstNonEmptyString(source.advertiser_id, source.advertiserId, payload.advertiser_id, payload.advertiserId);
    const formId = firstNonEmptyString(source.form_id, source.formId, source.instant_form_id, source.instantFormId, payload.form_id, payload.formId);
    const connection = findTikTokBackfillConnection(workingRuntime, companyId, advertiserId, formId);
    if (!connection) {
      counts.unmapped += 1;
      results.push({ status: "unmapped", advertiserId, formId });
      continue;
    }
    const result = await captureTikTokLeadSource(workingRuntime, connection, enrichedSource, payload, {
      eventSource: "leadsbridge-backfill",
      notify: false,
      sendWhatsApp: false
    });
    counts[result.status] = (counts[result.status] || 0) + 1;
    results.push(result);
  }

  const next = !dryRun && counts.captured > 0 ? await writeRuntimeState(workingRuntime) : workingRuntime;
  return sendJson(res, 200, {
    ok: true,
    dryRun,
    total: leadSources.length,
    dateFrom,
    dateTo,
    counts,
    sample: results.slice(0, 30),
    updatedAt: next.updatedAt || runtime.updatedAt,
    note: dryRun
      ? "Dry run sahaja. Hantar dryRun:false untuk import sebenar."
      : "Backfill siap. WhatsApp intro dan push notification tidak dihantar untuk data lama."
  });
}

async function fetchMetaLead(leadgenId, connection, runtime) {
  const apiVersion = runtime.integrations.meta.apiVersion || "v22.0";
  const fields = [
    "id",
    "created_time",
    "ad_id",
    "ad_name",
    "adset_id",
    "adset_name",
    "campaign_id",
    "campaign_name",
    "form_id",
    "platform",
    "field_data"
  ].join(",");
  const url = new URL(`${META_GRAPH_API_BASE}/${apiVersion}/${leadgenId}`);
  url.searchParams.set("fields", fields);
  url.searchParams.set("access_token", connection.metaAccessToken);
  const response = await fetch(url);
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Meta fetch failed: ${response.status} ${errorText.slice(0, 160)}`);
  }
  return response.json();
}

async function fetchMetaFormLeads(connection, runtime, formId) {
  const apiVersion = runtime.integrations.meta.apiVersion || "v22.0";
  const fields = [
    "id",
    "created_time",
    "ad_id",
    "ad_name",
    "adset_id",
    "adset_name",
    "campaign_id",
    "campaign_name",
    "form_id",
    "platform",
    "field_data"
  ].join(",");
  const url = new URL(`https://graph.facebook.com/${apiVersion}/${formId}/leads`);
  url.searchParams.set("fields", fields);
  url.searchParams.set("limit", "100");
  url.searchParams.set("access_token", connection.metaAccessToken);
  let nextUrl = url.toString();
  const leads = [];
  const seenLeadIds = new Set();
  for (let page = 0; nextUrl && page < META_LEAD_SYNC_MAX_PAGES; page += 1) {
    const payload = await fetchRemoteJson(nextUrl);
    for (const lead of Array.isArray(payload?.data) ? payload.data : []) {
      const leadId = String(lead.id || "");
      if (leadId && seenLeadIds.has(leadId)) continue;
      if (leadId) seenLeadIds.add(leadId);
      leads.push(lead);
    }
    nextUrl = payload?.paging?.next || "";
  }
  return leads;
}

async function captureMetaLead(runtime, connection, lead, eventSource = "auto-sync") {
  const leadId = String(lead.id || "");
  if (!leadId || hasExternalLead(runtime, "meta", leadId)) return { status: "duplicate", leadId };
  if (isMetaTestLead(lead)) return { status: "test-skipped", leadId };

  let campaignSync = null;
  try {
    const snapshot = await fetchMetaCampaignSnapshot(connection, runtime, String(lead.ad_id || ""));
    campaignSync = syncCampaignFromSnapshot(
      runtime,
      connection,
      "Meta Ads",
      snapshot,
      connection.metaCampaignId || "",
      lead.created_time ? localIsoDate(new Date(lead.created_time)) : localIsoDate(new Date())
    );
  } catch (error) {
    pushInboundEvent(runtime, {
      source: "meta",
      status: "spend-sync-error",
      summary: `Meta spend sync gagal: ${error.message}`,
      payload: { leadId, adId: lead.ad_id || "", eventSource }
    });
  }

  const record = applyDuplicateLeadStatus(runtime, buildMetaRecord(runtime, connection, lead, campaignSync));
  runtime.records.unshift(record);
  runtime.records = sortRecordsByRecency(runtime.records);
  pushInboundEvent(runtime, {
    source: "meta",
    status: "captured",
    summary: `Lead Meta ${leadId} auto masuk ke ${connection.companyId}${eventSource === "auto-sync" ? " melalui background sync" : ""}.`,
    payload: { leadId, companyId: connection.companyId, campaignId: record.campaignId || "", eventSource }
  });
  notifyTeamsalesLeadSubscribers(record).catch((error) => {
    console.warn(`Meta push notification failed: ${error.message}`);
  });
  try {
    await sendWhatsAppIntroForLeadSafely(runtime, record, "meta-webhook");
  } catch (error) {
    console.warn(`Meta WhatsApp intro failed: ${error.message}`);
  }
  return { status: "captured", leadId, record };
}

async function processMetaLeadChange(runtime, change, eventSource = "webhook") {
  const connection = findMetaConnection(runtime, change.page_id, change.form_id);
  if (!connection) {
    pushInboundEvent(runtime, {
      source: "meta",
      status: "unmapped",
      summary: "Meta event diterima tetapi page/form belum dipetakan.",
      payload: change
    });
    return { status: "unmapped", leadgenId: change.leadgen_id || "" };
  }

  if (!connection.metaAccessToken) {
    pushInboundEvent(runtime, {
      source: "meta",
      status: "pending-token",
      summary: "Meta event diterima tetapi access token belum diisi.",
      payload: change
    });
    return { status: "pending-token", leadgenId: change.leadgen_id || "" };
  }

  if (rememberMetaFormId(connection, change.form_id)) {
    pushInboundEvent(runtime, {
      source: "meta",
      status: "form-auto-mapped",
      summary: `Meta form ${change.form_id} auto dipetakan kepada ${connection.companyId} melalui Page ID ${change.page_id}.`,
      payload: { pageId: change.page_id || "", formId: change.form_id || "", eventSource }
    });
  }

  try {
    const lead = {
      ...(await fetchMetaLead(change.leadgen_id, connection, runtime)),
      page_id: change.page_id || "",
      form_id: change.form_id || ""
    };
    const capture = await captureMetaLead(runtime, connection, lead, eventSource);
    if (capture.status === "duplicate") {
      pushInboundEvent(runtime, {
        source: "meta",
        status: "duplicate",
        summary: `Lead ${capture.leadId} sudah ada dalam runtime.`,
        payload: change
      });
      return { status: "duplicate", leadgenId: capture.leadId };
    }
    return { status: "captured", leadgenId: capture.leadId };
  } catch (error) {
    pushInboundEvent(runtime, {
      source: "meta",
      status: "error",
      summary: error.message,
      payload: change
    });
    return { status: "error", leadgenId: change.leadgen_id || "", message: error.message };
  }
}

async function repairMetaUnmappedInboundEvents(runtime) {
  let repairedCount = 0;
  let touched = false;
  const events = [...(runtime.integrations.inboundEvents || [])];

  for (const event of events) {
    if (event.source !== "meta" || event.status !== "unmapped" || event.repairedAt) continue;
    const change = event.payload || {};
    if (!change.leadgen_id || !change.page_id) continue;

    const connection = findMetaConnection(runtime, change.page_id, change.form_id);
    if (!connection || !connection.metaAccessToken) continue;

    try {
      if (rememberMetaFormId(connection, change.form_id)) {
        touched = true;
        pushInboundEvent(runtime, {
          source: "meta",
          status: "form-auto-mapped",
          summary: `Meta form ${change.form_id} auto dipetakan semasa repair inbound event.`,
          payload: { pageId: change.page_id || "", formId: change.form_id || "" }
        });
      }
      const lead = {
        ...(await fetchMetaLead(change.leadgen_id, connection, runtime)),
        page_id: change.page_id || "",
        form_id: change.form_id || ""
      };
      const capture = await captureMetaLead(runtime, connection, lead, "inbound-repair");
      event.repairedAt = new Date().toISOString();
      event.repairStatus = capture.status;
      touched = true;
      if (capture.status === "captured") repairedCount += 1;
    } catch (error) {
      event.repairError = String(error.message || error).slice(0, 220);
      touched = true;
    }
  }

  return { capturedCount: repairedCount, touched };
}

async function handleMetaWebhook(req, res, url) {
  if (req.method === "GET") {
    const runtime = await ensureRuntimeState();
    const mode = url.searchParams.get("hub.mode");
    const verifyToken = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge") || "";
    if (mode === "subscribe" && verifyToken === runtime.integrations.meta.verifyToken) {
      return sendText(res, 200, challenge);
    }
    return sendText(res, 403, "Invalid verify token");
  }

  if (req.method !== "POST") {
    return sendText(res, 405, "Method not allowed");
  }

  const raw = await readBody(req, { maxBytes: REQUEST_BODY_LIMITS.metaWebhook });
  if (!META_APP_SECRET && !META_ALLOW_UNSIGNED_WEBHOOKS) {
    return sendJson(res, 503, { ok: false, error: "Meta webhook signing secret is not configured" });
  }
  if (META_APP_SECRET && !verifyMetaWebhookSignature(raw, req.headers["x-hub-signature-256"])) {
    return sendJson(res, 401, { ok: false, error: "Invalid Meta webhook signature" });
  }

  const runtime = await ensureRuntimeState();
  let payload;
  try {
    payload = parseWebhookPayload(raw, req.headers["content-type"] || "");
  } catch {
    pushInboundEvent(runtime, {
      source: "tiktok",
      status: "invalid-payload",
      summary: "TikTok/connector payload diterima tetapi format tidak boleh dibaca.",
      payload: {
        contentType: String(req.headers["content-type"] || ""),
        rawLength: raw.length
      }
    });
    await writeRuntimeState(runtime);
    return sendJson(res, 400, { ok: false, error: "Invalid TikTok payload" });
  }

  const changes = [];
  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      if (change.field === "leadgen") {
        changes.push(change.value || {});
      }
    }
  }

  const results = [];

  for (const change of changes) {
    results.push(await processMetaLeadChange(runtime, change, "webhook"));
  }

  const next = await writeRuntimeState(runtime);
  return sendJson(res, 200, { ok: true, results, inboundEvents: next.integrations.inboundEvents.length });
}

async function handleTikTokWebhook(req, res, url) {
  if (req.method !== "POST") {
    return sendText(res, 405, "Method not allowed");
  }

  const raw = await readBody(req, { maxBytes: REQUEST_BODY_LIMITS.tiktokWebhook });
  const runtime = await ensureRuntimeState();
  const signingSecret = String(runtime.integrations.tiktok.callbackToken || "").trim();
  const hasSafeSigningSecret = Boolean(signingSecret) && signingSecret !== TIKTOK_DEFAULT_CALLBACK_TOKEN;
  if (!hasSafeSigningSecret && !TIKTOK_ALLOW_UNSIGNED_WEBHOOKS) {
    return sendJson(res, 503, { ok: false, error: "TikTok callback secret is not configured" });
  }
  if (hasSafeSigningSecret && !verifyTikTokRequest(req, url, raw, signingSecret)) {
    pushInboundEvent(runtime, {
      source: "tiktok",
      status: "invalid-signature",
      summary: "TikTok signature verification gagal.",
      payload: { hasSignature: Boolean(req.headers["tiktok-signature"] || req.headers["x-tiktok-signature"] || req.headers["x-tt-signature"]), hasToken: Boolean(tiktokTokenFromRequest(req, url)) }
    });
    await writeRuntimeState(runtime);
    return sendJson(res, 401, { ok: false, error: "Invalid TikTok signature" });
  }

  let payload;
  try {
    payload = parseWebhookPayload(raw, req.headers["content-type"] || "");
  } catch (error) {
    pushInboundEvent(runtime, {
      source: "tiktok",
      status: "invalid-payload",
      summary: "TikTok/connector payload diterima tetapi format tidak boleh dibaca.",
      payload: {
        contentType: String(req.headers["content-type"] || ""),
        rawLength: raw.length,
        error: String(error.message || error).slice(0, 160)
      }
    });
    await writeRuntimeState(runtime);
    return sendJson(res, 400, { ok: false, error: "Invalid JSON" });
  }

  const leadSources = extractTikTokLeadSources(payload);
  if (!leadSources.length) {
    pushInboundEvent(runtime, {
      source: "tiktok",
      status: "empty",
      summary: "TikTok event diterima tetapi tiada lead data.",
      payload
    });
    const next = await writeRuntimeState(runtime);
    return sendJson(res, 200, { ok: true, status: "empty", inboundEvents: next.integrations.inboundEvents.length });
  }

  const results = [];
  for (const source of leadSources) {
    const advertiserId = firstNonEmptyString(source.advertiser_id, source.advertiserId, payload.advertiser_id, payload.advertiserId);
    const formId = firstNonEmptyString(source.form_id, source.formId, source.instant_form_id, source.instantFormId, payload.form_id, payload.formId);
    const companyId = firstNonEmptyString(
      source.company_id,
      source.companyId,
      payload.company_id,
      payload.companyId,
      url.searchParams.get("companyId"),
      url.searchParams.get("company")
    );
    const connection = findTikTokBackfillConnection(runtime, companyId, advertiserId, formId);

    if (!connection) {
      pushInboundEvent(runtime, {
        source: "tiktok",
        status: "unmapped",
        summary: "TikTok event diterima tetapi advertiser/form belum dipetakan.",
        payload: { companyId, advertiserId, formId, leadId: source.lead_id || source.id || "" }
      });
      results.push({ status: "unmapped", companyId, advertiserId, formId });
      continue;
    }

    results.push(await captureTikTokLeadSource(runtime, connection, source, payload, {
      eventSource: "tiktok-webhook",
      notify: true,
      sendWhatsApp: true
    }));
  }

  const next = await writeRuntimeState(runtime);
  return sendJson(res, 200, { ok: true, results, inboundEvents: next.integrations.inboundEvents.length });
}

async function handleWhatsAppWebhook(req, res, url) {
  const runtime = await ensureRuntimeState();
  const { settings, config } = activeWhatsAppConfig(runtime);

  if (req.method === "GET") {
    const mode = url.searchParams.get("hub.mode");
    const verifyToken = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge") || "";
    if (mode === "subscribe" && verifyToken && verifyToken === config.webhookVerifyToken) {
      return sendText(res, 200, challenge);
    }
    return sendText(res, 403, "Invalid verify token");
  }

  if (req.method !== "POST") {
    return sendText(res, 405, "Method not allowed");
  }

  const raw = await readBody(req, { maxBytes: REQUEST_BODY_LIMITS.whatsappWebhook });
  let payload;
  try {
    payload = JSON.parse(raw || "{}");
  } catch {
    logWhatsAppRequest(runtime, {
      direction: "system",
      message_type: "system",
      message_body: "Invalid WhatsApp webhook JSON",
      status: "failed",
      raw_payload_json: raw.slice(0, 800)
    });
    await writeRuntimeState(runtime);
    return sendJson(res, 400, { ok: false, error: "Invalid JSON" });
  }

  runtime.whatsapp = mergeWhatsApp(runtime.whatsapp);
  runtime.whatsapp.inboundEvents = [{
    id: createId("wa-event"),
    source: "whatsapp",
    status: "received",
    summary: "WhatsApp webhook payload received.",
    at: new Date().toISOString(),
    payload
  }, ...runtime.whatsapp.inboundEvents].slice(0, 120);

  const results = [];
  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      for (const inboundMessage of value.messages || []) {
        const phoneNumber = formatMalaysiaPhoneNumber(inboundMessage.from || "");
        const lead = findWhatsAppLeadByPhone(runtime, phoneNumber);
        const messageBody = whatsappPayloadText(inboundMessage);
        const logged = logWhatsAppRequest(runtime, {
          lead_id: lead?.id || "",
          phone_number: phoneNumber,
          direction: "inbound",
          message_type: inboundMessage.type || "text",
          message_body: messageBody,
          meta_message_id: inboundMessage.id || "",
          status: "received",
          raw_payload_json: { entry: entry.id || "", change: change.field || "", message: inboundMessage, contacts: value.contacts || [] }
        });

        if (lead && isOptOutReply(messageBody)) {
          markWhatsAppOptOut(runtime, phoneNumber, lead.id, messageBody);
          lead.details = {
            ...(lead.details || {}),
            whatsapp_opt_out: true,
            whatsapp_opt_out_at: new Date().toISOString(),
            whatsapp_opt_out_reason: messageBody
          };
        }
        results.push({ status: "message-received", id: logged.id, leadId: lead?.id || "" });
      }

      for (const statusUpdate of value.statuses || []) {
        const failedError = statusUpdate.errors?.[0] || {};
        const updated = updateWhatsAppMessage(runtime, "", {
          meta_message_id: statusUpdate.id || "",
          phone_number: statusUpdate.recipient_id || "",
          status: statusUpdate.status || "received",
          error_code: failedError.code || "",
          error_message: failedError.message || failedError.title || "",
          raw_payload_json: { entry: entry.id || "", change: change.field || "", status: statusUpdate }
        });
        if (!updated) {
          logWhatsAppRequest(runtime, {
            phone_number: statusUpdate.recipient_id || "",
            direction: "system",
            message_type: "status",
            meta_message_id: statusUpdate.id || "",
            status: statusUpdate.status || "received",
            error_code: failedError.code || "",
            error_message: failedError.message || failedError.title || "",
            raw_payload_json: statusUpdate
          });
        }
        results.push({ status: "status-updated", metaMessageId: statusUpdate.id || "", messageStatus: statusUpdate.status || "" });
      }
    }
  }

  const next = await writeRuntimeState(runtime);
  return sendJson(res, 200, {
    ok: true,
    active: settings.is_active,
    results,
    whatsappMessages: next.whatsapp.messages.length
  });
}

function adminOnly(user) {
  return user && GLOBAL_ACCESS_ROLES.has(user.role);
}

function mergeWhatsAppSettingsPatch(currentSettings, patch = {}) {
  const incoming = patch && typeof patch === "object" ? patch : {};
  const next = {
    ...currentSettings,
    waba_id: String(incoming.waba_id ?? incoming.wabaId ?? currentSettings.waba_id ?? "").trim(),
    phone_number_id: String(incoming.phone_number_id ?? incoming.phoneNumberId ?? currentSettings.phone_number_id ?? "").trim(),
    access_token_env_key: String(incoming.access_token_env_key ?? incoming.accessTokenEnvKey ?? currentSettings.access_token_env_key ?? WHATSAPP_DEFAULT_ACCESS_TOKEN_ENV_KEY).trim() || WHATSAPP_DEFAULT_ACCESS_TOKEN_ENV_KEY,
    webhook_verify_token: String(incoming.webhook_verify_token ?? incoming.webhookVerifyToken ?? currentSettings.webhook_verify_token ?? "").trim(),
    default_template_name: String(incoming.default_template_name ?? incoming.defaultTemplateName ?? currentSettings.default_template_name ?? "").trim(),
    default_language_code: String(incoming.default_language_code ?? incoming.defaultLanguageCode ?? currentSettings.default_language_code ?? "ms").trim() || "ms",
    test_recipient_number: formatMalaysiaPhoneNumber(incoming.test_recipient_number ?? incoming.testRecipientNumber ?? currentSettings.test_recipient_number ?? ""),
    is_active: typeof incoming.is_active === "boolean" ? incoming.is_active : typeof incoming.isActive === "boolean" ? incoming.isActive : Boolean(currentSettings.is_active),
    updated_at: new Date().toISOString()
  };
  return next;
}

async function handleWhatsAppSettingsApi(req, res) {
  const user = await requireAuth(req, res);
  if (!user) return;
  if (!adminOnly(user)) return sendJson(res, 403, { ok: false, error: "Admin access required" });

  const runtime = await ensureRuntimeState();
  runtime.whatsapp = mergeWhatsApp(runtime.whatsapp);

  if (req.method === "GET") {
    return sendJson(res, 200, sanitizeWhatsAppForUser(runtime.whatsapp, user, runtime.records));
  }

  if (req.method === "PUT") {
    const body = await readBody(req);
    let payload;
    try {
      payload = JSON.parse(body || "{}");
    } catch {
      return sendJson(res, 400, { ok: false, error: "Invalid JSON" });
    }

    runtime.whatsapp.settings = mergeWhatsAppSettingsPatch(runtime.whatsapp.settings, payload.settings || payload);
    const next = await writeRuntimeState(runtime);
    return sendJson(res, 200, sanitizeWhatsAppForUser(next.whatsapp, user, next.records));
  }

  return sendText(res, 405, "Method not allowed");
}

async function handleWhatsAppTestApi(req, res) {
  const user = await requireAuth(req, res);
  if (!user) return;
  if (!adminOnly(user)) return sendJson(res, 403, { ok: false, error: "Admin access required" });
  if (req.method !== "POST") return sendText(res, 405, "Method not allowed");

  const runtime = await ensureRuntimeState();
  runtime.whatsapp = mergeWhatsApp(runtime.whatsapp);
  const body = await readBody(req);
  let payload = {};
  try {
    payload = JSON.parse(body || "{}");
  } catch {
    return sendJson(res, 400, { ok: false, error: "Invalid JSON" });
  }

  const config = whatsappConfigFromSettings(runtime.whatsapp.settings);
  const phoneNumber = formatMalaysiaPhoneNumber(payload.phoneNumber || runtime.whatsapp.settings.test_recipient_number || "");
  const message = await sendTemplateMessage(runtime, { id: "", kind: "lead", phone: phoneNumber }, {
    phoneNumber,
    templateName: payload.templateName || config.defaultTemplateName,
    languageCode: payload.languageCode || config.defaultLanguageCode
  });
  const next = await writeRuntimeState(runtime);
  const sanitized = sanitizeWhatsAppForUser(next.whatsapp, user, next.records);
  return sendJson(res, 200, {
    ok: message?.status === "sent",
    status: message?.status || "failed",
    message: sanitized.messages.find((item) => item.id === message?.id) || null,
    settings: sanitized.settings
  });
}

async function handleWhatsAppRegisterPhoneApi(req, res) {
  const user = await requireAuth(req, res);
  if (!user) return;
  if (!adminOnly(user)) return sendJson(res, 403, { ok: false, error: "Admin access required" });
  if (req.method !== "POST") return sendText(res, 405, "Method not allowed");

  const runtime = await ensureRuntimeState();
  runtime.whatsapp = mergeWhatsApp(runtime.whatsapp);
  const body = await readBody(req);
  let payload = {};
  try {
    payload = JSON.parse(body || "{}");
  } catch {
    return sendJson(res, 400, { ok: false, error: "Invalid JSON" });
  }

  const currentSettings = runtime.whatsapp.settings;
  const phoneNumberId = String(payload.phoneNumberId || currentSettings.phone_number_id || "").trim();
  const pin = String(payload.pin || "").trim();
  const config = whatsappConfigFromSettings({
    ...currentSettings,
    phone_number_id: phoneNumberId || currentSettings.phone_number_id
  });

  try {
    const result = await callWhatsAppCloudRegisterApi(config, pin, phoneNumberId);
    if (phoneNumberId && phoneNumberId !== currentSettings.phone_number_id) {
      runtime.whatsapp.settings = mergeWhatsAppSettingsPatch(currentSettings, { phone_number_id: phoneNumberId });
    }
    logWhatsAppRequest(runtime, {
      phone_number: "",
      direction: "system",
      message_type: "system",
      message_body: `Cloud API phone number registered: ${phoneNumberId || config.phoneNumberId}`,
      status: "sent",
      raw_payload_json: {
        success: Boolean(result?.success),
        phone_number_id: phoneNumberId || config.phoneNumberId
      }
    });
    const next = await writeRuntimeState(runtime);
    const sanitized = sanitizeWhatsAppForUser(next.whatsapp, user, next.records);
    return sendJson(res, 200, {
      ok: true,
      success: Boolean(result?.success ?? true),
      settings: sanitized.settings,
      message: sanitized.messages[0] || null
    });
  } catch (error) {
    const handled = handleWhatsAppError(error);
    logWhatsAppRequest(runtime, {
      phone_number: "",
      direction: "system",
      message_type: "system",
      message_body: `Cloud API phone number register failed: ${phoneNumberId || config.phoneNumberId || "missing phone number id"}`,
      status: "failed",
      ...handled
    });
    const next = await writeRuntimeState(runtime);
    return sendJson(res, 400, {
      ok: false,
      error: handled.error_message,
      error_code: handled.error_code,
      settings: sanitizeWhatsAppForUser(next.whatsapp, user, next.records).settings
    });
  }
}

async function handleWhatsAppRetryApi(req, res) {
  const user = await requireAuth(req, res);
  if (!user) return;
  if (!adminOnly(user)) return sendJson(res, 403, { ok: false, error: "Admin access required" });
  if (req.method !== "POST") return sendText(res, 405, "Method not allowed");

  const runtime = await ensureRuntimeState();
  const body = await readBody(req);
  let payload = {};
  try {
    payload = JSON.parse(body || "{}");
  } catch {
    return sendJson(res, 400, { ok: false, error: "Invalid JSON" });
  }

  const message = await retryFailedMessage(runtime, String(payload.messageId || ""));
  const next = await writeRuntimeState(runtime);
  const sanitized = sanitizeWhatsAppForUser(next.whatsapp, user, next.records);
  return sendJson(res, 200, {
    ok: Boolean(message),
    message: sanitized.messages.find((item) => item.id === message?.id) || null
  });
}

async function syncMetaLeadsOnce() {
  if (metaLeadSyncRunning) return;
  metaLeadSyncRunning = true;
  try {
    const runtime = await ensureRuntimeState();
    let capturedCount = 0;
    let repairedCount = 0;
    let stateTouched = false;

    try {
      const repair = await repairMetaUnmappedInboundEvents(runtime);
      repairedCount = repair.capturedCount;
      stateTouched = repair.touched;
      capturedCount += repairedCount;
    } catch (error) {
      console.warn(`[meta-sync] inbound repair: ${error.message}`);
    }

    for (const connection of runtime.integrations.connections || []) {
      if (!connection.metaEnabled || !connection.metaAccessToken) continue;
      const formIds = parseDelimitedIds(connection.metaFormIds);
      if (!formIds.length) continue;

      for (const formId of formIds) {
        let leads = [];
        try {
          leads = await fetchMetaFormLeads(connection, runtime, formId);
        } catch (error) {
          console.warn(`[meta-sync] ${connection.companyId}/${formId}: ${error.message}`);
          continue;
        }

        for (const formLead of leads) {
          const lead = {
            ...formLead,
            page_id: connection.metaPageId || formLead.page_id || "",
            form_id: formLead.form_id || formId
          };
          try {
            const capture = await captureMetaLead(runtime, connection, lead, "auto-sync");
            if (capture.status === "captured") capturedCount += 1;
          } catch (error) {
            console.warn(`[meta-sync] capture ${lead.id || ""}: ${error.message}`);
          }
        }
      }
    }

    if (capturedCount > 0 || stateTouched) {
      await writeRuntimeState(runtime);
      console.log(`[meta-sync] captured ${capturedCount} new lead(s)${repairedCount ? `, repaired ${repairedCount} unmapped event(s)` : ""}`);
    }
  } finally {
    metaLeadSyncRunning = false;
  }
}

function startMetaLeadAutoSync() {
  if (!META_LEAD_SYNC_INTERVAL_MS) return;
  setTimeout(() => syncMetaLeadsOnce().catch((error) => console.warn(`[meta-sync] ${error.message}`)), 15000);
  setInterval(() => {
    syncMetaLeadsOnce().catch((error) => console.warn(`[meta-sync] ${error.message}`));
  }, META_LEAD_SYNC_INTERVAL_MS);
}

function currentMonthRange() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  return {
    dateFrom: localIsoDate(start),
    dateTo: localIsoDate(end)
  };
}

async function syncAdsSpendOnce() {
  if (adsSpendSyncRunning) return;
  adsSpendSyncRunning = true;
  try {
    const runtime = await ensureRuntimeState();
    const { dateFrom, dateTo } = currentMonthRange();
    let totalSynced = 0;
    for (const connection of runtime.integrations.connections || []) {
      if (!connection.metaSpendSyncEnabled && !connection.tiktokSpendSyncEnabled) continue;
      try {
        const result = await syncAdsSpendForReport(runtime, {
          companyId: connection.companyId,
          dateFrom,
          dateTo,
          staff: "all"
        });
        totalSynced += Number(result.metaSynced || 0) + Number(result.tiktokSynced || 0);
        (result.errors || []).forEach((error) => {
          console.warn(`[ads-spend-sync] ${error.platform || "Ads"} ${error.target || ""}: ${error.message}`);
        });
      } catch (error) {
        console.warn(`[ads-spend-sync] ${connection.companyId}: ${error.message}`);
      }
    }
    if (totalSynced > 0) {
      await writeRuntimeState(runtime);
      console.log(`[ads-spend-sync] updated ${totalSynced} campaign snapshot(s) for ${dateFrom} to ${dateTo}`);
    }
  } finally {
    adsSpendSyncRunning = false;
  }
}

function startAdsSpendAutoSync() {
  if (!ADS_SPEND_SYNC_INTERVAL_MS) return;
  setTimeout(() => syncAdsSpendOnce().catch((error) => console.warn(`[ads-spend-sync] ${error.message}`)), 45000);
  setInterval(() => {
    syncAdsSpendOnce().catch((error) => console.warn(`[ads-spend-sync] ${error.message}`));
  }, ADS_SPEND_SYNC_INTERVAL_MS);
}

async function handleApi(req, res, url) {
  const pathname = url.pathname;

  if (pathname === "/api/health") {
    const runtime = await ensureRuntimeState();
    const initialized = Boolean(runtime.records.length || runtime.campaigns.length || runtime.integrations.inboundEvents.length || runtime.integrations.publicBaseUrl);
    const backupCount = await backupStats();
    return sendJson(res, 200, {
      ok: true,
      initialized,
      updatedAt: runtime.updatedAt,
      control: {
        lastBackupAt: runtime.control.lastBackupAt,
        backupCount
      },
      counts: {
        records: runtime.records.length,
        campaigns: runtime.campaigns.length,
        inboundEvents: runtime.integrations.inboundEvents.length
      }
    });
  }

  if (pathname === "/api/records/status") {
    if (req.method !== "PATCH" && req.method !== "PUT") {
      return sendText(res, 405, "Method not allowed");
    }
    const user = await requireAuth(req, res);
    if (!user) return;

    const body = await readBody(req);
    let payload;
    try {
      payload = JSON.parse(body || "{}");
    } catch {
      return sendJson(res, 400, { ok: false, error: "Invalid JSON" });
    }

    const recordId = String(payload.recordId || payload.id || "").trim();
    if (!recordId) return sendJson(res, 400, { ok: false, error: "Missing record id" });

    const runtime = await ensureRuntimeState();
    const recordIndex = runtime.records.findIndex((record) => record.id === recordId);
    if (recordIndex < 0) return sendJson(res, 404, { ok: false, error: "Record not found" });

    const currentRecord = runtime.records[recordIndex];
    if (!canUserAccessRecord(user, currentRecord)) {
      return sendJson(res, 403, { ok: false, error: "Forbidden" });
    }

    let nextRecord;
    try {
      nextRecord = normalizeRecordStatusPatch(currentRecord, payload);
    } catch (error) {
      return sendJson(res, error.statusCode || 400, { ok: false, error: error.message || "Invalid status update" });
    }

    runtime.records[recordIndex] = nextRecord;
    const next = await writeRuntimeState(runtime);
    const visibleRecord = sanitizeRuntimeForUser(next, user).records.find((record) => record.id === recordId) || nextRecord;
    return sendJson(res, 200, { ok: true, record: visibleRecord, updatedAt: next.updatedAt });
  }

  if (pathname === "/api/state") {
    if (req.method === "GET") {
      const user = await requireAuth(req, res);
      if (!user) return;
      return sendJson(res, 200, sanitizeRuntimeForUser(await ensureRuntimeState(), user));
    }
    if (req.method === "PUT") {
      const user = await requireAuth(req, res);
      if (!user) return;
      const body = await readBody(req, { maxBytes: REQUEST_BODY_LIMITS.state });
      let payload;
      try {
        payload = JSON.parse(body || "{}");
      } catch {
        return sendJson(res, 400, { ok: false, error: "Invalid JSON" });
      }
      const current = await ensureRuntimeState();
      const nextRuntime = {
        ...current,
        records: mergeScopedRecords(current.records, payload.records, user),
        campaigns: mergeScopedCampaigns(current.campaigns, payload.campaigns, user),
        integrations: mergeScopedIntegrations(current.integrations, payload.integrations || current.integrations, user),
        control: mergeScopedControl(current.control, payload.control, user),
        goldRates: mergeGoldRates(payload.goldRates || current.goldRates)
      };
      await autoSendWhatsAppForNewLeads(nextRuntime, current.records, "crm-form");
      const next = await writeRuntimeState(nextRuntime);
      return sendJson(res, 200, sanitizeRuntimeForUser(next, user));
    }
    return sendText(res, 405, "Method not allowed");
  }

  if (pathname === "/api/integrations") {
    if (req.method === "GET") {
      const user = await requireAuth(req, res);
      if (!user) return;
      return sendJson(res, 200, sanitizeRuntimeForUser(await ensureRuntimeState(), user).integrations);
    }
    if (req.method === "PUT") {
      const user = await requireAuth(req, res);
      if (!user) return;
      const body = await readBody(req);
      let payload;
      try {
        payload = JSON.parse(body || "{}");
      } catch {
        return sendJson(res, 400, { ok: false, error: "Invalid JSON" });
      }
      const runtime = await ensureRuntimeState();
      runtime.integrations = mergeScopedIntegrations(runtime.integrations, payload, user);
      const next = await writeRuntimeState(runtime);
      return sendJson(res, 200, sanitizeRuntimeForUser(next, user).integrations);
    }
    return sendText(res, 405, "Method not allowed");
  }

  if (pathname === "/api/reports/spend-sync") {
    if (req.method !== "POST") {
      return sendText(res, 405, "Method not allowed");
    }
    const user = await requireAuth(req, res);
    if (!user) return;
    const body = await readBody(req);
    let payload;
    try {
      payload = JSON.parse(body || "{}");
    } catch {
      return sendJson(res, 400, { ok: false, error: "Invalid JSON" });
    }

    const companyId = String(payload.companyId || user.companyId || "");
    if (!canUserAccessCompany(user, companyId)) {
      return sendJson(res, 403, { ok: false, error: "Forbidden company scope" });
    }

    const dateFrom = String(payload.dateFrom || localIsoDate(new Date())).slice(0, 10);
    const dateTo = String(payload.dateTo || dateFrom).slice(0, 10);
    const orderedFrom = dateFrom <= dateTo ? dateFrom : dateTo;
    const orderedTo = dateFrom <= dateTo ? dateTo : dateFrom;
    const requestedStaff = user.role === "staff"
      ? user.staffName
      : normalizeStaffName(companyId, payload.staff) || "all";

    const runtime = await ensureRuntimeState();
    const sync = await syncAdsSpendForReport(runtime, {
      companyId,
      dateFrom: orderedFrom,
      dateTo: orderedTo,
      staff: requestedStaff
    });
    const next = (sync.metaSynced || sync.tiktokSynced) ? await writeRuntimeState(runtime) : runtime;
    return sendJson(res, 200, {
      ...sync,
      state: sanitizeRuntimeForUser(next, user)
    });
  }

  if (pathname === "/api/integrations/meta-test") {
    if (req.method !== "POST") {
      return sendText(res, 405, "Method not allowed");
    }
    const user = await requireAuth(req, res);
    if (!user) return;
    if (!adminOnly(user)) return sendJson(res, 403, { ok: false, error: "Admin access required" });
    const body = await readBody(req);
    let payload;
    try {
      payload = JSON.parse(body || "{}");
    } catch {
      return sendJson(res, 400, { ok: false, error: "Invalid JSON" });
    }
    const companyId = String(payload.companyId || "");
    const runtime = await ensureRuntimeState();
    const connection = (runtime.integrations.connections || []).find((item) => item.companyId === companyId);
    if (!connection) {
      return sendJson(res, 404, { ok: false, error: "Company integration not found" });
    }
    return sendJson(res, 200, await testMetaConnection(runtime, connection));
  }

  if (pathname === "/api/integrations/tiktok-leadsbridge-backfill") {
    return handleTikTokLeadsBridgeBackfill(req, res);
  }

  if (pathname === "/api/whatsapp/settings") {
    return handleWhatsAppSettingsApi(req, res);
  }

  if (pathname === "/api/whatsapp/test") {
    return handleWhatsAppTestApi(req, res);
  }

  if (pathname === "/api/whatsapp/register-phone") {
    return handleWhatsAppRegisterPhoneApi(req, res);
  }

  if (pathname === "/api/whatsapp/retry") {
    return handleWhatsAppRetryApi(req, res);
  }

  if (pathname === "/api/rates/gold") {
    if (req.method !== "GET") {
      return sendText(res, 405, "Method not allowed");
    }
    const runtime = await ensureRuntimeState();
    try {
      return sendJson(res, 200, await loadGoldRates(runtime));
    } catch (error) {
      const fallback = mergeGoldRates(runtime.goldRates);
      if (fallback.fetchedAt) {
        return sendJson(res, 200, {
          ...fallback,
          status: "stale",
          error: error.message
        });
      }
      return sendJson(res, 502, { ok: false, error: error.message });
    }
  }

  if (pathname === "/api/push/public-key") {
    if (req.method !== "GET") {
      return sendText(res, 405, "Method not allowed");
    }
    const keys = await ensureVapidKeys();
    return sendJson(res, 200, { ok: true, publicKey: keys.publicKey });
  }

  if (pathname === "/api/push/subscribe") {
    if (req.method !== "POST") {
      return sendText(res, 405, "Method not allowed");
    }
    const user = await requireAuth(req, res);
    if (!user) return;
    const body = await readBody(req);
    let payload;
    try {
      payload = JSON.parse(body || "{}");
      await savePushSubscription(user, payload);
      return sendJson(res, 200, { ok: true });
    } catch (error) {
      return sendJson(res, 400, { ok: false, error: error.message });
    }
  }

  if (pathname === "/api/push/unsubscribe") {
    if (req.method !== "POST") {
      return sendText(res, 405, "Method not allowed");
    }
    const user = await requireAuth(req, res);
    if (!user) return;
    const body = await readBody(req);
    try {
      const payload = JSON.parse(body || "{}");
      await removePushSubscription(String(payload.endpoint || ""));
      return sendJson(res, 200, { ok: true });
    } catch {
      return sendJson(res, 400, { ok: false, error: "Invalid JSON" });
    }
  }

  if (pathname === "/api/auth/login") {
    if (req.method !== "POST") {
      return sendText(res, 405, "Method not allowed");
    }
    const body = await readBody(req);
    let payload;
    try {
      payload = JSON.parse(body || "{}");
    } catch {
      return sendJson(res, 400, { ok: false, error: "Invalid JSON" });
    }
    const store = await ensureAuthStore();
    const username = String(payload.username || "").trim().toLowerCase();
    const password = String(payload.password || "");
    if (isLoginRateLimited(req, username)) {
      return sendJson(res, 429, { ok: false, error: "Too many login attempts. Try again shortly." });
    }
    const user = store.users.find((item) => item.username.toLowerCase() === username);
    if (!user || hashPassword(password, user.passwordSalt) !== user.passwordHash) {
      recordLoginFailure(req, username);
      return sendJson(res, 401, { ok: false, error: "Invalid credentials" });
    }
    clearLoginFailures(req, username);
    const token = crypto.randomBytes(24).toString("hex");
    authSessions.set(token, {
      profileId: user.profileId,
      expiresAt: Date.now() + SESSION_TTL_MS
    });
    return sendJson(res, 200, { ok: true, token, user: sanitizeProfile(user) });
  }

  if (pathname === "/api/auth/session") {
    if (req.method !== "GET") {
      return sendText(res, 405, "Method not allowed");
    }
    const user = await requireAuth(req, res);
    if (!user) return;
    return sendJson(res, 200, { ok: true, user });
  }

  if (pathname === "/api/auth/logout") {
    if (req.method !== "POST") {
      return sendText(res, 405, "Method not allowed");
    }
    const token = authTokenFromRequest(req);
    if (token) authSessions.delete(token);
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === "/api/uploads") {
    if (req.method !== "POST") {
      return sendText(res, 405, "Method not allowed");
    }
    const user = await requireAuth(req, res);
    if (!user) return;
    const body = await readBody(req, { maxBytes: REQUEST_BODY_LIMITS.uploads });
    let payload;
    try {
      payload = JSON.parse(body || "{}");
    } catch {
      return sendJson(res, 400, { ok: false, error: "Invalid JSON" });
    }
    const companyId = String(payload.companyId || "");
    if (!canUserAccessCompany(user, companyId)) {
      return sendJson(res, 403, { ok: false, error: "Forbidden company scope" });
    }
    const attachments = await storeUploads(companyId, String(payload.recordKind || "record"), Array.isArray(payload.files) ? payload.files : []);
    return sendJson(res, 200, { ok: true, attachments });
  }

  if (pathname === "/api/webhooks/meta") {
    return handleMetaWebhook(req, res, url);
  }

  if (pathname === "/api/webhooks/tiktok" || pathname === "/api/webhooks/tiktok/connector") {
    return handleTikTokWebhook(req, res, url);
  }

  if (pathname === "/api/webhooks/whatsapp" || pathname === "/webhook/whatsapp") {
    return handleWhatsAppWebhook(req, res, url);
  }

  return sendText(res, 404, "Not found");
}

async function serveStatic(req, res, url) {
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname === "/privacy" ? "/privacy.html" : url.pathname;
  const publicRootFiles = new Set(["/index.html", "/privacy.html", "/app.js", "/styles.css", "/sw.js", "/manifest.webmanifest"]);
  const isPublicAsset = pathname.startsWith("/assets/") || pathname.startsWith("/uploads/");
  if (!publicRootFiles.has(pathname) && !isPublicAsset) {
    return sendText(res, 404, "Not found");
  }
  let requestedPath;
  if (pathname.startsWith("/uploads/")) {
    const relativeUploadPath = pathname.replace(/^\/uploads\//, "");
    requestedPath = path.normalize(path.join(UPLOAD_DIR, relativeUploadPath));
    if (!requestedPath.startsWith(UPLOAD_DIR)) {
      return sendText(res, 403, "Forbidden");
    }
  } else {
    requestedPath = path.normalize(path.join(ROOT, pathname));
  }
  if (!pathname.startsWith("/uploads/") && !requestedPath.startsWith(ROOT)) {
    return sendText(res, 403, "Forbidden");
  }

  try {
    const stat = await fs.stat(requestedPath);
    if (stat.isDirectory()) {
      return sendText(res, 403, "Forbidden");
    }
    const ext = path.extname(requestedPath).toLowerCase();
    const contentType = MIME_TYPES[ext] || "application/octet-stream";
    const buffer = await fs.readFile(requestedPath);
    res.writeHead(200, {
      ...securityHeaders(),
      "Content-Type": contentType,
      "Cache-Control": ext === ".html" || pathname === "/sw.js" ? "no-store" : "public, max-age=300",
      ...(pathname === "/sw.js" ? { "Service-Worker-Allowed": "/" } : {})
    });
    res.end(buffer);
  } catch {
    sendText(res, 404, "Not found");
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
    if (url.pathname.startsWith("/api/") || url.pathname === "/webhook/whatsapp") {
      return await handleApi(req, res, url);
    }
    return await serveStatic(req, res, url);
  } catch (error) {
    const statusCode = Number(error.statusCode || 500);
    return sendJson(res, statusCode, { ok: false, error: error.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`CRM Salam Fortress server running on http://${HOST}:${PORT}`);
  startMetaLeadAutoSync();
  startAdsSpendAutoSync();
});

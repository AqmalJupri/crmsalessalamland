import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const dryRun = process.argv.includes("--dry-run");
const failures = [];

function read(relativePath) {
  return readFileSync(new URL(relativePath, root), "utf8");
}

function check(label, condition, detail = "") {
  if (condition) {
    console.log(`PASS ${label}`);
    return;
  }
  failures.push(label);
  console.error(`FAIL ${label}${detail ? `: ${detail}` : ""}`);
}

function envEntries(source) {
  return Object.fromEntries(source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && line.includes("="))
    .map((line) => {
      const separator = line.indexOf("=");
      return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
    }));
}

const PACKAGE_EXCLUSIONS = [
  "backups/",
  "deploy/",
  "exports/",
  "handoff/",
  "node_modules/",
  ".git/",
  "logs/",
  "reports/",
  "data/runtime.json",
  "data/auth.json",
  "data/backups/",
  "data/uploads/"
];

const PACKAGE_ALLOWLIST = new Set([
  ".env.production.example",
  "DEPLOYMENT-CHECKLIST.md",
  "PRODUCTION-PACKAGE.md",
  "ecosystem.config.cjs",
  "server.js",
  "scripts/production-package-audit.mjs",
  "scripts/smoke-lead-ingestion-guards.mjs",
  "scripts/smoke-stabilize-sales-production.mjs"
]);

function isRealEnvFile(relativePath) {
  const basename = relativePath.split("/").pop() || "";
  return /^\.env(?:\..+)?$/.test(basename) && !basename.endsWith(".example");
}

function isPackageExcluded(relativePath) {
  const normalized = String(relativePath || "").replace(/^\.\//, "");
  const basename = normalized.split("/").pop() || "";
  return basename.startsWith("._") || isRealEnvFile(normalized) || PACKAGE_EXCLUSIONS.some((entry) => (
    entry.endsWith("/") ? normalized.startsWith(entry) : normalized === entry
  ));
}

function isPackageAllowed(relativePath) {
  const normalized = String(relativePath || "").replace(/^\.\//, "");
  return !isPackageExcluded(normalized) && PACKAGE_ALLOWLIST.has(normalized);
}

function isStrictPackagePlan(paths = []) {
  return Array.isArray(paths) && paths.length > 0 && paths.every(isPackageAllowed);
}

function ecosystemTargetsProduction(source) {
  return /name:\s*["']crm-salamland-my["']/.test(source) &&
    /cwd:\s*["']\/var\/www\/crm\.salamland\.my["']/.test(source) &&
    /PORT:\s*process\.env\.PORT\s*\|\|\s*["']8877["']/.test(source) &&
    /HOST:\s*process\.env\.HOST\s*\|\|\s*["']127\.0\.0\.1["']/.test(source);
}

function validProductionTikTokToken(value) {
  const normalized = String(value || "").trim();
  return Boolean(normalized) && normalized !== "crm-salam-fortress-tiktok";
}

check("dry-run mode requested", dryRun, "run with --dry-run");

const serverSource = read("server.js");
const envSource = read(".env.production.example");
const ecosystemSource = read("ecosystem.config.cjs");
const checklistSource = read("DEPLOYMENT-CHECKLIST.md");
const packageSource = read("PRODUCTION-PACKAGE.md");
const env = envEntries(envSource);

check("NODE_ENV production gate represented", env.NODE_ENV === "production" && /NODE_ENV/.test(ecosystemSource));
check("CRM_REQUIRE_WEBHOOK_SIGNATURES required for production", env.CRM_REQUIRE_WEBHOOK_SIGNATURES === "true" && /CRM_REQUIRE_WEBHOOK_SIGNATURES/.test(serverSource));
check("META_APP_SECRET production placeholder documented", Object.hasOwn(env, "META_APP_SECRET") && env.META_APP_SECRET === "");
check("Meta unsigned override disabled", env.META_ALLOW_UNSIGNED_WEBHOOKS === "false");
check("TikTok unsigned override disabled", env.TIKTOK_ALLOW_UNSIGNED_WEBHOOKS === "false");
check(
  "TikTok callback token contract rejects missing and generic seed",
  !validProductionTikTokToken("") &&
    !validProductionTikTokToken("crm-salam-fortress-tiktok") &&
    validProductionTikTokToken("deployment-specific-token") &&
    /crm-salam-fortress-tiktok/.test(checklistSource)
);

const secretLikeExampleEntries = Object.entries(env).filter(([key, value]) => (
  /(?:TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY|REGISTER_PIN)$/.test(key) && value !== ""
));
check("environment example contains no real secret values", secretLikeExampleEntries.length === 0);

for (const required of PACKAGE_EXCLUSIONS) {
  const fixturePath = required.endsWith("/") ? `${required}fixture.json` : required;
  check(`package excludes ${required}`, isPackageExcluded(fixturePath));
  check(`package contract documents ${required}`, packageSource.includes(required));
}
check("package excludes real .env files", isPackageExcluded(".env") && isPackageExcluded(".env.production") && !isPackageExcluded(".env.production.example"));
check("package contract documents real .env exclusion", /real [`']?\.env|\.env files/i.test(packageSource));

for (const key of [
  "NODE_ENV",
  "CRM_REQUIRE_WEBHOOK_SIGNATURES",
  "META_APP_SECRET",
  "META_ALLOW_UNSIGNED_WEBHOOKS",
  "TIKTOK_ALLOW_UNSIGNED_WEBHOOKS"
]) {
  check(`PM2 forwards ${key} from process.env`, ecosystemSource.includes(`${key}: process.env.${key}`));
}
check("PM2 contains no generic TikTok callback token", !ecosystemSource.includes("crm-salam-fortress-tiktok"));
check("PM2 contains no hardcoded secret-like values", !/(?:SECRET|ACCESS_TOKEN|CALLBACK_TOKEN):\s*["'][^"']+["']/.test(ecosystemSource));
check("PM2 targets crm-salamland-my production process/path/port", ecosystemTargetsProduction(ecosystemSource));
check(
  "PM2 target gate rejects wrong process/path/port fixture",
  !ecosystemTargetsProduction('name: "crm-salam-fortress", cwd: "/var/www/crm-salam-fortress", HOST: process.env.HOST || "127.0.0.1", PORT: process.env.PORT || "8876"')
);

for (const route of [
  "/api/public/salam-land/leads",
  "/api/integrations/meta-backfill",
  "/api/auth/change-password",
  "/api/auth/admin-reset-password"
]) {
  check(`hardening scope excludes ${route}`, !serverSource.includes(route));
}

for (const gate of [
  "all verification commands exit 0",
  "fresh production backup",
  "exact rollback snapshot",
  "signature envs configured",
  "unsigned webhook overrides disabled",
  "TikTok callback token changed from `crm-salam-fortress-tiktok`"
]) {
  check(`deployment checklist: ${gate}`, checklistSource.includes(gate));
}
check("production package documents clean package contract", /Clean Package Contract/i.test(packageSource));

const repositoryFiles = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
  cwd: new URL(".", root),
  encoding: "utf8"
}).split("\0").filter(Boolean);
const includedFiles = repositoryFiles.filter(isPackageAllowed);
const missingAllowlistedFiles = [...PACKAGE_ALLOWLIST].filter((relativePath) => !repositoryFiles.includes(relativePath));
check("strict package allowlist is complete", missingAllowlistedFiles.length === 0, missingAllowlistedFiles.join(", "));
check("dry-run package plan contains only allowlisted paths", includedFiles.every((relativePath) => PACKAGE_ALLOWLIST.has(relativePath)));
check("dry-run package plan contains no excluded paths", includedFiles.every((relativePath) => !isPackageExcluded(relativePath)));
check("strict package plan validator accepts current allowlist", isStrictPackagePlan(includedFiles));
check("strict package plan validator rejects disallowed fixture", !isStrictPackagePlan(["server.js", "data/runtime.json"]));
check("dry-run package retains environment example", includedFiles.includes(".env.production.example"));
check("runtime package includes server.js", includedFiles.includes("server.js"));
check("unchanged UI files are not runtime replacements", !includedFiles.some((relativePath) => ["app.js", "index.html", "styles.css", "privacy.html", "sw.js"].includes(relativePath)));
for (const disallowed of [
  "data/runtime.json",
  "data/auth.json",
  "data/backups/runtime.json",
  "data/uploads/file.bin",
  "backups/snapshot/server.js",
  "deploy/package.tar.gz",
  "exports/leads.csv",
  "handoff/notes.md",
  "node_modules/pkg/index.js",
  ".git/config",
  ".env.production",
  "logs/server.log",
  "reports/audit.txt",
  "assets/._logo.png",
  "scripts/register-whatsapp-cloud-api.js",
  "scripts/cleanup-salam-production-data.js",
  "scripts/backfill-meta-salam-recent.mjs"
]) {
  check(`strict allowlist rejects ${disallowed}`, !isPackageAllowed(disallowed));
}
console.log(`INFO dry-run package plan: ${includedFiles.length} included, ${repositoryFiles.length - includedFiles.length} excluded`);

if (failures.length) {
  console.error(`Production package audit failed: ${failures.length} check(s)`);
  process.exitCode = 1;
} else {
  console.log("PASS production package dry-run contract");
}

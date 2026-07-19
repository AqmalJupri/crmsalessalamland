import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { pbkdf2Sync } from "node:crypto";
import assert from "node:assert/strict";

const root = new URL("../", import.meta.url);
const serverPath = new URL("server.js", root);
const appPath = new URL("app.js", root);
const smokePort = Number(process.env.CRM_STABILIZE_SMOKE_PORT || 18790);
const smokePassword = "TemporarySmokePassword123";

function pass(label) {
  console.log(`PASS ${label}`);
}

function nodeCheck(fileUrl) {
  execFileSync(process.execPath, ["--check", fileURLToPath(fileUrl)], { stdio: "pipe" });
}

async function waitFor(check, timeoutMs = 8000) {
  const startedAt = Date.now();
  let lastError;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await check();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw lastError || new Error("Timed out waiting for temporary CRM server");
}

async function stopServer(server) {
  if (server.exitCode !== null) return;
  server.kill("SIGTERM");
  await new Promise((resolve) => server.once("exit", resolve));
}

function fixtureRecord(id, companyId, staff, phone) {
  return {
    id,
    kind: "lead",
    companyId,
    customerName: id,
    phone,
    source: "Smoke fixture",
    campaignId: "",
    staff,
    product: "Fixture product",
    status: "New Lead",
    createdAt: "2026-07-01",
    nextFollowUp: "",
    value: 0,
    units: 0,
    actionFlags: {},
    details: {},
    notes: ""
  };
}

function runtimeFixture() {
  return {
    records: [
      fixtureRecord("salam-nureen", "salam-land", "Nureen", "60110000001"),
      fixtureRecord("salam-wafi", "salam-land", "Wafi", "60110000002"),
      fixtureRecord("bumi-amy", "bumi-hayat", "Amy", "60110000003"),
      fixtureRecord("barakah-nabilah", "barakah-emas", "Nabilah", "60110000004")
    ],
    campaigns: [],
    integrations: {
      publicBaseUrl: "",
      meta: { verifyToken: "fixture-meta-verify", apiVersion: "v22.0" },
      tiktok: { callbackToken: "fixture-tiktok-callback", leadRetentionDays: 90 },
      connections: [
        { companyId: "salam-land" },
        { companyId: "bumi-hayat" },
        { companyId: "barakah-emas" }
      ],
      assignmentCursor: { meta: {}, tiktok: {} },
      inboundEvents: [{
        id: "fixture-auth-monitoring-event",
        companyId: "barakah-emas",
        source: "meta",
        status: "captured",
        payload: { raw_marker: "auth-role-sensitive-marker", phone_number: "60119999999" }
      }]
    },
    control: { settings: { autoBackupEnabled: false } },
    goldRates: {},
    whatsapp: { settings: {}, messages: [], optOuts: [], inboundEvents: [] }
  };
}

const fixtureAccounts = [
  {
    profileId: "admin-root",
    username: "afiq.admin",
    name: "Afiq Admin",
    role: "admin",
    companyIds: ["salam-land", "bumi-hayat", "barakah-emas"],
    companyId: "",
    staffName: "",
    title: "Super admin",
    note: "Smoke fixture"
  },
  {
    profileId: "boss-root",
    username: "boss.management",
    name: "Management Boss",
    role: "boss",
    companyIds: ["salam-land", "bumi-hayat", "barakah-emas"],
    companyId: "",
    staffName: "",
    title: "Executive overview",
    note: "Smoke fixture"
  },
  {
    profileId: "company-salam-land",
    username: "staffsalam",
    name: "Salam Land Workspace",
    role: "company",
    companyIds: ["salam-land"],
    companyId: "salam-land",
    staffName: "",
    title: "Company workspace access",
    note: "Smoke fixture"
  },
  {
    profileId: "staff-smoke-wafi",
    username: "staffsalam-wafi",
    name: "Wafi",
    role: "staff",
    companyIds: ["salam-land"],
    companyId: "salam-land",
    staffName: "Wafi",
    title: "Team sales",
    note: "Smoke-only injected profile"
  }
];

function authFixture() {
  return {
    version: 1,
    users: fixtureAccounts.map((account, index) => {
      const passwordSalt = `role-smoke-salt-${index}`;
      return {
        ...account,
        passwordSalt,
        passwordHash: pbkdf2Sync(smokePassword, passwordSalt, 120000, 32, "sha256").toString("hex"),
        mustChangePassword: false
      };
    })
  };
}

function serverWithTemporaryStaffProfile(source) {
  const marker = "\n  return profiles;\n}\n\nfunction hashPassword";
  assert.ok(source.includes(marker), "buildAccessProfiles injection point missing");
  const injected = `
  profiles.push({
    profileId: "staff-smoke-wafi",
    username: "staffsalam-wafi",
    name: "Wafi",
    role: "staff",
    companyIds: ["salam-land"],
    companyId: "salam-land",
    staffName: "Wafi",
    title: "Team sales",
    note: "Smoke-only injected profile"
  });
`;
  return source.replace(marker, `${injected}${marker}`);
}

nodeCheck(serverPath);
pass("server.js syntax");
nodeCheck(appPath);
pass("app.js syntax");

const serverSource = readFileSync(serverPath, "utf8");
assert.ok(serverSource.includes("sanitizeProfile(profile)"), "profile sanitizer missing");
assert.ok(!serverSource.includes("mustChangePassword: __REDACTED__"), "redacted runtime placeholder still present");
assert.ok(serverSource.includes("canUserAccessRecord"), "record access guard missing");
assert.ok(serverSource.includes("Dangerous runtime write rejected"), "runtime write protection missing");
assert.ok(serverSource.includes("writeRuntimeFileAtomically"), "atomic runtime writer missing");
assert.ok(serverSource.includes("await handle.sync()"), "runtime temp file fsync missing");
assert.ok(serverSource.includes("await fs.rename(tempPath, STATE_FILE)"), "atomic runtime rename missing");
assert.ok(serverSource.includes("runtime-corrupt-"), "corrupt runtime quarantine missing");
for (const outOfScopeRoute of [
  "/api/public/salam-land/leads",
  "/api/integrations/meta-backfill",
  "/api/auth/change-password",
  "/api/auth/admin-reset-password"
]) {
  assert.ok(!serverSource.includes(outOfScopeRoute), `hardening-only server contains ${outOfScopeRoute}`);
}
pass("stabilization source guards");

const tempRoot = mkdtempSync(join(tmpdir(), "agency-crm-auth-role-smoke-"));
try {
  writeFileSync(join(tempRoot, "server.js"), serverWithTemporaryStaffProfile(serverSource));
  for (const filename of ["index.html", "app.js", "styles.css"]) {
    copyFileSync(new URL(filename, root), join(tempRoot, filename));
  }
  mkdirSync(join(tempRoot, "data"), { recursive: true });
  writeFileSync(join(tempRoot, "data", "runtime.json"), JSON.stringify(runtimeFixture(), null, 2));
  writeFileSync(join(tempRoot, "data", "auth.json"), JSON.stringify(authFixture(), null, 2));

  const server = spawn(process.execPath, ["server.js"], {
    cwd: tempRoot,
    env: {
      ...process.env,
      PORT: String(smokePort),
      HOST: "127.0.0.1",
      META_LEAD_SYNC_INTERVAL_MS: "0",
      ADS_SPEND_SYNC_INTERVAL_MS: "0",
      WHATSAPP_ALLOWED_STAFF: ""
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  server.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  server.stdout.on("data", () => {});

  const request = async (pathname, options = {}) => {
    const response = await fetch(`http://127.0.0.1:${smokePort}${pathname}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {})
      }
    });
    const text = await response.text();
    let body = null;
    try { body = JSON.parse(text); } catch {}
    return { response, body, text };
  };
  const bearer = (token) => ({ Authorization: `Bearer ${token}` });

  try {
    await waitFor(async () => {
      const result = await request("/api/health");
      assert.equal(result.response.status, 200);
      return result;
    });
    pass("temporary CRM health endpoint");

    const loginPage = await request("/");
    assert.equal(loginPage.response.status, 200);
    assert.match(loginPage.text, /Sign in to open dashboard/);
    assert.match(loginPage.text, /id="loginForm"/);
    pass("login page renders from temporary server");

    const wrongLogin = await request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: "wrong-user", password: "wrong-password" })
    });
    assert.equal(wrongLogin.response.status, 401);
    assert.match(String(wrongLogin.body?.error || ""), /invalid credentials/i);
    pass("wrong login returns 401");

    for (const pathname of ["/api/state", "/api/integrations"]) {
      assert.equal((await request(pathname)).response.status, 401, `${pathname} accepted missing token`);
      assert.equal((await request(pathname, { headers: bearer("invalid-session-token") })).response.status, 401, `${pathname} accepted invalid token`);
    }
    pass("protected state and integrations reject missing and invalid tokens");

    const accounts = [
      { username: "afiq.admin", role: "admin" },
      { username: "boss.management", role: "boss" },
      { username: "staffsalam", role: "company" },
      { username: "staffsalam-wafi", role: "staff" }
    ];
    const sessions = new Map();
    for (const account of accounts) {
      const login = await request("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ username: account.username, password: smokePassword })
      });
      assert.equal(login.response.status, 200, `valid ${account.role} login failed`);
      assert.ok(login.body?.token, `${account.role} login token missing`);
      assert.equal(login.body?.user?.role, account.role, `${account.role} login returned wrong role`);
      assert.ok(!/passwordHash|passwordSalt|passwordAlgorithm/.test(JSON.stringify(login.body)), `${account.role} login leaked password fields`);
      const session = await request("/api/auth/session", { headers: bearer(login.body.token) });
      assert.equal(session.response.status, 200, `${account.role} session token unusable`);
      assert.equal(session.body?.user?.role, account.role, `${account.role} session returned wrong role`);
      sessions.set(account.role, login.body.token);
    }
    pass("admin, boss, company and staff login tokens create usable sessions");

    for (const role of ["admin", "boss"]) {
      const state = (await request("/api/state", { headers: bearer(sessions.get(role)) })).body;
      const integrations = (await request("/api/integrations", { headers: bearer(sessions.get(role)) })).body;
      assert.equal(state.records.length, 4, `${role} lost global records`);
      assert.equal(integrations.connections.length, 3, `${role} lost global connections`);
      assert.ok(integrations.inboundEvents.some((event) => event.id === "fixture-auth-monitoring-event"), `${role} lost monitoring events`);
    }
    pass("admin and boss retain global records, connections and monitoring");

    const companyState = (await request("/api/state", { headers: bearer(sessions.get("company")) })).body;
    const companyIntegrations = (await request("/api/integrations", { headers: bearer(sessions.get("company")) })).body;
    assert.ok(companyState.records.length > 0 && companyState.records.every((record) => record.companyId === "salam-land"), "company record scope leaked another company");
    assert.deepEqual(companyIntegrations.connections.map((connection) => connection.companyId), ["salam-land"]);
    assert.deepEqual(companyState.integrations.inboundEvents, []);
    assert.deepEqual(companyIntegrations.inboundEvents, []);
    pass("company sees only company-scoped data without inbound events");

    const staffState = (await request("/api/state", { headers: bearer(sessions.get("staff")) })).body;
    const staffIntegrations = (await request("/api/integrations", { headers: bearer(sessions.get("staff")) })).body;
    assert.deepEqual(staffState.records.map((record) => record.id), ["salam-wafi"]);
    assert.ok(staffState.records.every((record) => record.companyId === "salam-land" && record.staff === "Wafi"));
    assert.deepEqual(staffState.integrations.inboundEvents, []);
    assert.deepEqual(staffIntegrations.inboundEvents, []);
    assert.ok(!JSON.stringify(staffState).includes("auth-role-sensitive-marker"), "staff state exposed raw inbound payload");
    pass("staff sees only own assigned leads without inbound payloads");

    const tempAuth = JSON.parse(readFileSync(join(tempRoot, "data", "auth.json"), "utf8"));
    assert.ok(Array.isArray(tempAuth.users) && tempAuth.users.length >= accounts.length, "temporary auth fixture missing users");
    pass("temporary auth fixture remains valid JSON");
  } finally {
    await stopServer(server);
    if (stderr.trim()) console.error(stderr.trim());
  }
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

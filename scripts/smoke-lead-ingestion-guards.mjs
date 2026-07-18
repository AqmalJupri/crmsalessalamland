import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createHmac, pbkdf2Sync } from "node:crypto";
import http from "node:http";
import assert from "node:assert/strict";

const root = new URL("../", import.meta.url);
const crmPort = Number(process.env.CRM_SMOKE_PORT || 18765);
const metaPort = Number(process.env.CRM_SMOKE_META_PORT || 18766);
const setupPassword = "SmokePassword123";
const metaAppSecret = "smoke-meta-app-secret";
const tiktokCallbackSecret = "smoke-tiktok-hmac-secret";
const tiktokDefaultCallbackToken = "crm-salam-fortress-tiktok";
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kuala_Lumpur", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const bodyLimits = {
  json: 1024 * 1024,
  metaWebhook: 512 * 1024,
  tiktokWebhook: 2 * 1024 * 1024
};

function log(label) {
  console.log(`PASS ${label}`);
}

function oversizedJson(maxBytes) {
  const body = JSON.stringify({ padding: "x".repeat(maxBytes) });
  assert.ok(Buffer.byteLength(body) > maxBytes, "oversized test body must exceed configured limit");
  return body;
}

function metaSignature(rawBody) {
  return `sha256=${createHmac("sha256", metaAppSecret).update(rawBody).digest("hex")}`;
}

function tiktokSignature(rawBody, timestamp = "1720000000") {
  const signedPayload = `${timestamp}.${rawBody}`;
  const signature = createHmac("sha256", tiktokCallbackSecret).update(signedPayload).digest("hex");
  return `t=${timestamp},s=${signature}`;
}

function metaWebhookPayload(leadId, formId = "form-known") {
  return {
    entry: [{
      id: "page-1",
      changes: [{ field: "leadgen", value: { leadgen_id: leadId, page_id: "page-1", form_id: formId } }]
    }]
  };
}

function tiktokWebhookPayload(leadId) {
  return {
    advertiser_id: "adv-1",
    form_id: "tt-form-1",
    leads: [{
      lead_id: leadId,
      full_name: "TikTok Auth Guard",
      phone_number: "60139999999",
      created_at: "2026-07-05 10:30:00",
      campaign_name: "Wafi LeadsBridge Campaign"
    }]
  };
}

function verifySafeLocalIsoDateBoundaries() {
  const serverSource = readFileSync(new URL("server.js", root), "utf8");
  const functionStart = serverSource.indexOf("function safeLocalIsoDate");
  const functionEnd = serverSource.indexOf("\nfunction isoOffset(", functionStart);
  assert.ok(functionStart >= 0 && functionEnd > functionStart, "safeLocalIsoDate source not found");
  const functionSource = serverSource.slice(functionStart, functionEnd);
  const malaysiaIsoDate = (date = new Date()) => new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kuala_Lumpur",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
  const safeLocalIsoDate = new Function("localIsoDate", `return (${functionSource})`)(malaysiaIsoDate);
  const cases = [
    ["2026-07-02T20:30:00+0000", "2026-07-03"],
    ["2026-07-02T20:30:00Z", "2026-07-03"],
    ["2026-07-02T20:30:00+00:00", "2026-07-03"],
    ["2026-07-02T15:59:59+0000", "2026-07-02"],
    ["2026-07-02T16:00:00+0000", "2026-07-03"],
    ["2026-07-02", "2026-07-02"],
    ["02/07/2026 20:30", "2026-07-02"]
  ];
  for (const [input, expected] of cases) {
    assert.equal(safeLocalIsoDate(input), expected, `safeLocalIsoDate boundary failed for ${input}`);
  }
  log("server date parser respects explicit timezone boundaries and local date inputs");
}

function authFixture(accounts) {
  return {
    version: 1,
    users: accounts.map((account, index) => {
      const passwordSalt = `smoke-salt-${index}`;
      return {
        ...account,
        passwordSalt,
        passwordHash: pbkdf2Sync(setupPassword, passwordSalt, 120000, 32, "sha256").toString("hex"),
        mustChangePassword: false
      };
    })
  };
}

const smokeAccounts = [
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
  }
];

async function waitFor(fn, timeoutMs = 8000) {
  const start = Date.now();
  let lastError;
  while (Date.now() - start < timeoutMs) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  throw lastError || new Error("waitFor timed out");
}

async function request(path, options = {}) {
  return requestAt(crmPort, path, options);
}

async function requestAt(port, path, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { response, body };
}

function spawnTempCrm(tempRoot, port, extraEnv = {}) {
  return spawn(process.execPath, ["server.js"], {
    cwd: tempRoot,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      META_LEAD_SYNC_INTERVAL_MS: "0",
      ADS_SPEND_SYNC_INTERVAL_MS: "0",
      WHATSAPP_ALLOWED_STAFF: "",
      ...extraEnv
    },
    stdio: ["ignore", "ignore", "pipe"]
  });
}

async function stopTempCrm(server) {
  if (server.exitCode !== null) return;
  server.kill("SIGTERM");
  await new Promise((resolve) => server.once("exit", resolve));
}

async function verifyRuntimePersistenceGuards() {
  const serverSource = readFileSync(new URL("server.js", root), "utf8");
  assert.ok(serverSource.includes('fs.open(tempPath, "wx", 0o600)'), "atomic writer must create a same-directory temp file exclusively");
  assert.ok(serverSource.includes("await handle.sync()"), "atomic writer must fsync the temp file");
  assert.ok(serverSource.includes("await fs.rename(tempPath, STATE_FILE)"), "atomic writer must rename temp state into runtime.json");

  const corruptRoot = mkdtempSync(join(tmpdir(), "agency-crm-corrupt-runtime-"));
  const corruptPort = crmPort + 10;
  const corruptRuntime = '{"records":[{"id":"must-survive"}';
  try {
    copyFileSync(new URL("server.js", root), join(corruptRoot, "server.js"));
    mkdirSync(join(corruptRoot, "data"), { recursive: true });
    writeFileSync(join(corruptRoot, "data", "runtime.json"), corruptRuntime);
    const corruptServer = spawnTempCrm(corruptRoot, corruptPort);
    try {
      const result = await waitFor(() => requestAt(corruptPort, "/api/health"));
      assert.equal(result.response.status, 503, "corrupt runtime must fail health safely");
      assert.equal(readFileSync(join(corruptRoot, "data", "runtime.json"), "utf8"), corruptRuntime, "corrupt runtime must not be replaced");
      const quarantines = readdirSync(join(corruptRoot, "data", "backups"))
        .filter((name) => /^runtime-corrupt-.*\.json$/.test(name));
      assert.equal(quarantines.length, 1, "corrupt runtime must create exactly one quarantine copy");
      assert.equal(readFileSync(join(corruptRoot, "data", "backups", quarantines[0]), "utf8"), corruptRuntime, "quarantine must preserve original bytes");
      log("corrupt runtime is quarantined and never replaced with empty state");
    } finally {
      await stopTempCrm(corruptServer);
    }
  } finally {
    rmSync(corruptRoot, { recursive: true, force: true });
  }

  const missingRoot = mkdtempSync(join(tmpdir(), "agency-crm-missing-runtime-"));
  const missingPort = crmPort + 11;
  try {
    copyFileSync(new URL("server.js", root), join(missingRoot, "server.js"));
    mkdirSync(join(missingRoot, "data"), { recursive: true });
    const missingServer = spawnTempCrm(missingRoot, missingPort);
    try {
      const result = await waitFor(() => requestAt(missingPort, "/api/health"));
      assert.equal(result.response.status, 200, "missing runtime should initialize safely");
      const initialized = JSON.parse(readFileSync(join(missingRoot, "data", "runtime.json"), "utf8"));
      assert.ok(Array.isArray(initialized.records), "initialized runtime records must be an array");
      const tempFiles = readdirSync(join(missingRoot, "data")).filter((name) => name.includes(".tmp-"));
      assert.deepEqual(tempFiles, [], "atomic runtime initialization must not leave temp files");
      log("missing runtime initializes through a clean atomic write");
    } finally {
      await stopTempCrm(missingServer);
    }
  } finally {
    rmSync(missingRoot, { recursive: true, force: true });
  }
}

async function login(username) {
  const { response, body } = await request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password: setupPassword })
  });
  assert.equal(response.status, 200, `login ${username}: ${JSON.stringify(body)}`);
  assert.ok(body.token, "login token missing");
  return body.token;
}

function auth(token) {
  return { Authorization: `Bearer ${token}` };
}

function runtimeFixture() {
  return {
    records: [
      {
        id: "existing-meta-booking",
        kind: "lead",
        companyId: "salam-land",
        customerName: "Existing Booking",
        phone: "60111111111",
        source: "Meta Ads",
        campaignId: "",
        staff: "Nureen",
        product: "Tanah Lot Semi D",
        status: "Booking",
        createdAt: "2026-07-02",
        nextFollowUp: "",
        value: 0,
        units: 0,
        actionFlags: { booking: true },
        details: {
          externalPlatform: "meta",
          externalLeadId: "meta-existing-1",
          metaLeadId: "meta-existing-1",
          leadgenId: "meta-existing-1",
          metaCreatedTime: "2026-07-02T04:00:00+0000",
          metaPageId: "page-1",
          metaFormId: "form-known",
          metaCampaignName: "Nureen Booking Campaign",
          remark: "sales already updated"
        },
        notes: "Do not overwrite"
      }
    ],
    campaigns: [],
    integrations: {
      publicBaseUrl: "",
      meta: { verifyToken: "verify-meta", apiVersion: "v22.0" },
      tiktok: { callbackToken: tiktokCallbackSecret, leadRetentionDays: 90 },
      connections: [
        {
          companyId: "salam-land",
          metaEnabled: true,
          metaPageId: "page-1",
          metaAdAccountId: "",
          metaFormIds: "form-known, form-other\nform-third",
          metaCampaignId: "",
          metaSpendSyncEnabled: false,
          metaAccessToken: "meta-token",
          metaSpendAccessToken: "",
          metaDefaultStaff: "Nureen",
          metaLeadStatus: "New Lead",
          tiktokEnabled: true,
          tiktokAdvertiserId: "adv-1",
          tiktokFormIds: "tt-form-1",
          tiktokCampaignId: "",
          tiktokSpendSyncEnabled: false,
          tiktokLeadMode: "instant-form",
          tiktokCallbackToken: "tiktok-secret",
          tiktokAccessToken: "",
          tiktokDefaultStaff: "Nureen",
          tiktokLeadStatus: "New Lead",
          notes: ""
        },
        { companyId: "bumi-hayat" },
        { companyId: "barakah-emas" }
      ],
      assignmentCursor: { meta: {}, tiktok: {} },
      inboundEvents: [{
        id: "fixture-sensitive-inbound",
        at: "2026-07-10T10:00:00.000Z",
        source: "meta",
        status: "captured",
        companyId: "barakah-emas",
        summary: "Cross-company fixture",
        payload: {
          phone_number: "60128887777",
          page_id: "page-cross-company",
          form_id: "form-cross-company",
          campaign_id: "campaign-cross-company",
          leadsbridge: { raw_field: "raw-integration-marker" }
        }
      }]
    },
    control: { settings: { autoBackupEnabled: false } },
    goldRates: {},
    whatsapp: { settings: {}, messages: [], optOuts: [], inboundEvents: [] }
  };
}

async function verifyMetaWebhookMissingSecretGuard() {
  const scenarios = [
    { label: "production", portOffset: 12, env: { NODE_ENV: "production" } },
    { label: "required-signatures mode", portOffset: 13, env: { NODE_ENV: "test", CRM_REQUIRE_WEBHOOK_SIGNATURES: "true" } }
  ];

  for (const scenario of scenarios) {
    const noSecretRoot = mkdtempSync(join(tmpdir(), "agency-crm-meta-no-secret-"));
    const noSecretPort = crmPort + scenario.portOffset;
    try {
      copyFileSync(new URL("server.js", root), join(noSecretRoot, "server.js"));
      mkdirSync(join(noSecretRoot, "data"), { recursive: true });
      writeFileSync(join(noSecretRoot, "data", "runtime.json"), JSON.stringify(runtimeFixture(), null, 2));
      const noSecretServer = spawnTempCrm(noSecretRoot, noSecretPort, {
        ...scenario.env,
        META_APP_SECRET: "",
        META_ALLOW_UNSIGNED_WEBHOOKS: "true",
        META_GRAPH_API_BASE: `http://127.0.0.1:${metaPort}`
      });
      try {
        await waitFor(() => requestAt(noSecretPort, "/api/health"));
        const stateBefore = readFileSync(join(noSecretRoot, "data", "runtime.json"), "utf8");
        const rawBody = JSON.stringify(metaWebhookPayload(`meta-no-secret-${scenario.portOffset}`));
        const result = await requestAt(noSecretPort, "/api/webhooks/meta", { method: "POST", body: rawBody });
        assert.equal(result.response.status, 503, `${scenario.label} Meta webhook must fail closed when app secret is missing`);
        assert.equal(readFileSync(join(noSecretRoot, "data", "runtime.json"), "utf8"), stateBefore, "missing Meta app secret must not write runtime state");
        log(`${scenario.label} Meta webhook fails closed when app secret is missing`);
      } finally {
        await stopTempCrm(noSecretServer);
      }
    } finally {
      rmSync(noSecretRoot, { recursive: true, force: true });
    }
  }
}

async function verifyTikTokWebhookMissingSecretGuard() {
  const scenarios = [
    { label: "production missing-secret", portOffset: 14, callbackToken: "", env: { NODE_ENV: "production" }, expectedStatus: 503 },
    { label: "required-signatures missing-secret", portOffset: 15, callbackToken: "", env: { NODE_ENV: "test", CRM_REQUIRE_WEBHOOK_SIGNATURES: "true" }, expectedStatus: 503 },
    { label: "explicit local missing-secret override", portOffset: 16, callbackToken: "", env: { NODE_ENV: "test" }, expectedStatus: 200 },
    { label: "production default-seed", portOffset: 17, callbackToken: tiktokDefaultCallbackToken, env: { NODE_ENV: "production" }, expectedStatus: 503 },
    { label: "required-signatures default-seed", portOffset: 18, callbackToken: tiktokDefaultCallbackToken, env: { NODE_ENV: "test", CRM_REQUIRE_WEBHOOK_SIGNATURES: "true" }, expectedStatus: 503 },
    { label: "explicit local default-seed override", portOffset: 19, callbackToken: tiktokDefaultCallbackToken, env: { NODE_ENV: "test" }, expectedStatus: 200 }
  ];

  for (const scenario of scenarios) {
    const noSecretRoot = mkdtempSync(join(tmpdir(), "agency-crm-tiktok-no-secret-"));
    const noSecretPort = crmPort + scenario.portOffset;
    try {
      copyFileSync(new URL("server.js", root), join(noSecretRoot, "server.js"));
      mkdirSync(join(noSecretRoot, "data"), { recursive: true });
      const fixture = runtimeFixture();
      fixture.integrations.tiktok.callbackToken = scenario.callbackToken;
      writeFileSync(join(noSecretRoot, "data", "runtime.json"), JSON.stringify(fixture, null, 2));
      const noSecretServer = spawnTempCrm(noSecretRoot, noSecretPort, {
        ...scenario.env,
        TIKTOK_ALLOW_UNSIGNED_WEBHOOKS: "true"
      });
      try {
        await waitFor(() => requestAt(noSecretPort, "/api/health"));
        const stateBefore = readFileSync(join(noSecretRoot, "data", "runtime.json"), "utf8");
        const leadId = `tiktok-no-secret-${scenario.portOffset}`;
        const result = await requestAt(noSecretPort, "/api/webhooks/tiktok/connector", {
          method: "POST",
          body: JSON.stringify(tiktokWebhookPayload(leadId))
        });
        assert.equal(result.response.status, scenario.expectedStatus, `${scenario.label} TikTok callback secret policy changed`);
        const stateAfter = readFileSync(join(noSecretRoot, "data", "runtime.json"), "utf8");
        if (scenario.expectedStatus === 503) {
          assert.equal(stateAfter, stateBefore, `${scenario.label} unsafe TikTok secret must not write runtime state`);
        } else {
          assert.ok(JSON.parse(stateAfter).records.some((record) => record.details?.externalLeadId === leadId), "explicit local override did not preserve unsigned fixture behavior");
        }
        log(`${scenario.label} TikTok callback secret policy is enforced`);
      } finally {
        await stopTempCrm(noSecretServer);
      }
    } finally {
      rmSync(noSecretRoot, { recursive: true, force: true });
    }
  }
}

function metaLeadPayload(leadId) {
  if (leadId === "meta-existing-1") {
    return {
      id: "meta-existing-1",
      created_time: "2026-07-02T04:00:00+0000",
      campaign_name: "Nureen Booking Campaign",
      form_id: "form-known",
      field_data: [
        { name: "full_name", values: ["Existing Booking"] },
        { name: "phone_number", values: ["60111111111"] }
      ]
    };
  }
  return {
    id: leadId,
    created_time: `${today}T03:00:00+0000`,
    campaign_name: "Wafi Tanah Lot Campaign",
    form_id: "form-unmapped-live",
    field_data: [
      { name: "full_name", values: ["Meta New Lead"] },
      { name: "phone_number", values: ["60122222222"] }
    ]
  };
}

const metaServer = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const leadId = url.pathname.split("/").pop();
  res.writeHead(200, { "Content-Type": "application/json" });
  if (url.pathname.includes("/leadgen_forms")) {
    res.end(JSON.stringify({ data: [{ id: "form-known" }, { id: "form-unmapped-live" }] }));
    return;
  }
  res.end(JSON.stringify(metaLeadPayload(leadId)));
});

await new Promise((resolve) => metaServer.listen(metaPort, "127.0.0.1", resolve));

const tempRoot = mkdtempSync(join(tmpdir(), "agency-crm-smoke-"));
try {
  verifySafeLocalIsoDateBoundaries();
  await verifyRuntimePersistenceGuards();
  await verifyMetaWebhookMissingSecretGuard();
  await verifyTikTokWebhookMissingSecretGuard();
  copyFileSync(new URL("server.js", root), join(tempRoot, "server.js"));
  mkdirSync(join(tempRoot, "data"), { recursive: true });
  writeFileSync(join(tempRoot, "data", "runtime.json"), JSON.stringify(runtimeFixture(), null, 2));
  writeFileSync(join(tempRoot, "data", "auth.json"), JSON.stringify(authFixture(smokeAccounts), null, 2));

  const server = spawn(process.execPath, ["server.js"], {
    cwd: tempRoot,
    env: {
      ...process.env,
      PORT: String(crmPort),
      HOST: "127.0.0.1",
      META_APP_SECRET: metaAppSecret,
      META_ALLOW_UNSIGNED_WEBHOOKS: "",
      META_GRAPH_API_BASE: `http://127.0.0.1:${metaPort}`,
      META_LEAD_SYNC_INTERVAL_MS: "0",
      ADS_SPEND_SYNC_INTERVAL_MS: "0",
      WHATSAPP_ALLOWED_STAFF: ""
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  server.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  server.stdout.on("data", () => {});

  try {
    await waitFor(async () => {
      const { response, body } = await request("/api/health");
      assert.equal(response.status, 200);
      assert.equal(body.ok, true);
      return body;
    });
    log("temp CRM health endpoint starts safely");

    const metaVerification = await request("/api/webhooks/meta?hub.mode=subscribe&hub.verify_token=verify-meta&hub.challenge=meta-challenge");
    assert.equal(metaVerification.response.status, 200, "Meta GET verification must remain available");
    assert.equal(metaVerification.body, "meta-challenge", "Meta GET verification challenge changed");
    log("Meta GET webhook verification remains unchanged");

    const stateBeforeWebhookLimits = readFileSync(join(tempRoot, "data", "runtime.json"), "utf8");
    const oversizedMeta = await request("/api/webhooks/meta", {
      method: "POST",
      body: oversizedJson(bodyLimits.metaWebhook)
    });
    assert.equal(oversizedMeta.response.status, 413, "oversized Meta webhook must return 413");

    const oversizedTikTok = await request("/api/webhooks/tiktok/connector?token=tiktok-secret", {
      method: "POST",
      body: oversizedJson(bodyLimits.tiktokWebhook)
    });
    assert.equal(oversizedTikTok.response.status, 413, "oversized TikTok webhook must return 413");
    assert.equal(readFileSync(join(tempRoot, "data", "runtime.json"), "utf8"), stateBeforeWebhookLimits, "oversized webhook payloads must not write runtime state");
    log("webhook body limits reject oversized payloads without state writes");

    const adminToken = await login("afiq.admin");
    const bossToken = await login("boss.management");
    const companyToken = await login("staffsalam");

    const adminDebugState = (await request("/api/state", { headers: auth(adminToken) })).body;
    const bossDebugState = (await request("/api/state", { headers: auth(bossToken) })).body;
    for (const [role, state] of [["admin", adminDebugState], ["boss", bossDebugState]]) {
      const fixtureEvent = state.integrations.inboundEvents.find((event) => event.id === "fixture-sensitive-inbound");
      assert.ok(fixtureEvent, `${role} lost inbound monitoring visibility`);
      assert.equal(fixtureEvent.payload.leadsbridge.raw_field, "raw-integration-marker", `${role} inbound event payload changed`);
      assert.ok(state.records.some((record) => record.id === "existing-meta-booking"), `${role} lost global record access`);
      assert.ok(state.integrations.connections.some((connection) => connection.companyId === "barakah-emas"), `${role} lost global integration visibility`);
    }

    for (const [role, token] of [["company", companyToken]]) {
      const state = (await request("/api/state", { headers: auth(token) })).body;
      const integrations = (await request("/api/integrations", { headers: auth(token) })).body;
      assert.deepEqual(state.integrations.inboundEvents, [], `${role} state exposed inbound integration events`);
      assert.deepEqual(integrations.inboundEvents, [], `${role} integrations response exposed inbound events`);
      assert.ok(!JSON.stringify(state).includes("raw-integration-marker"), `${role} state exposed raw integration payload`);
      assert.ok(!JSON.stringify(integrations).includes("page-cross-company"), `${role} integrations exposed cross-company metadata`);
      assert.ok(state.integrations.connections.every((connection) => connection.companyId === "salam-land"), `${role} state exposed cross-company connections`);
    }
    log("non-debug company responses hide inbound payloads while admin and boss retain monitoring visibility");

    const stateBeforeAuthenticatedLimit = readFileSync(join(tempRoot, "data", "runtime.json"), "utf8");
    const oversizedAuthenticatedJson = await request("/api/integrations", {
      method: "PUT",
      headers: auth(adminToken),
      body: oversizedJson(bodyLimits.json)
    });
    assert.equal(oversizedAuthenticatedJson.response.status, 413, "oversized authenticated JSON must return 413");
    assert.equal(readFileSync(join(tempRoot, "data", "runtime.json"), "utf8"), stateBeforeAuthenticatedLimit, "oversized authenticated JSON must not write runtime state");
    log("authenticated JSON body limit rejects oversized payload without state writes");

    const rejectedTikTokLeadId = "tt-rejected-token";
    const rejectedTikTokBody = JSON.stringify(tiktokWebhookPayload(rejectedTikTokLeadId));
    const missingTikTokToken = await request("/api/webhooks/tiktok/connector", { method: "POST", body: rejectedTikTokBody });
    assert.equal(missingTikTokToken.response.status, 401, "missing TikTok callback token must return 401");
    const invalidTikTokToken = await request("/api/webhooks/tiktok/connector?token=invalid", { method: "POST", body: rejectedTikTokBody });
    assert.equal(invalidTikTokToken.response.status, 401, "invalid TikTok callback token must return 401");
    const stateAfterRejectedTikTok = (await request("/api/state", { headers: auth(adminToken) })).body;
    assert.ok(!stateAfterRejectedTikTok.records.some((record) => record.details?.externalLeadId === rejectedTikTokLeadId), "rejected TikTok callback processed a lead");
    log("TikTok callback rejects missing and invalid configured tokens without processing leads");

    const rejectedMetaBody = JSON.stringify(metaWebhookPayload("meta-rejected-signature"));
    const stateBeforeRejectedMeta = readFileSync(join(tempRoot, "data", "runtime.json"), "utf8");
    const missingMetaSignature = await request("/api/webhooks/meta", { method: "POST", body: rejectedMetaBody });
    assert.equal(missingMetaSignature.response.status, 401, "missing Meta signature must return 401");
    const invalidMetaSignature = await request("/api/webhooks/meta", {
      method: "POST",
      headers: { "X-Hub-Signature-256": `sha256=${"0".repeat(64)}` },
      body: rejectedMetaBody
    });
    assert.equal(invalidMetaSignature.response.status, 401, "invalid Meta signature must return 401");
    assert.equal(readFileSync(join(tempRoot, "data", "runtime.json"), "utf8"), stateBeforeRejectedMeta, "rejected Meta signatures must not write runtime state");
    log("Meta webhook rejects missing and invalid signatures without state writes");

    const metaWebhook = metaWebhookPayload("meta-new-1", "form-known");
    const metaWebhookBody = JSON.stringify(metaWebhook);
    let webhookResult = await request("/api/webhooks/meta", {
      method: "POST",
      headers: { "X-Hub-Signature-256": metaSignature(metaWebhookBody) },
      body: metaWebhookBody
    });
    assert.equal(webhookResult.response.status, 200, JSON.stringify(webhookResult.body));
    assert.equal(webhookResult.body.results[0].status, "captured");

    let adminState = (await request("/api/state", { headers: auth(adminToken) })).body;
    const metaLead = adminState.records.find((record) => record.details?.externalPlatform === "meta" && record.details?.externalLeadId === "meta-new-1");
    assert.ok(metaLead, "valid signed Meta webhook did not capture its configured-form lead");
    assert.equal(metaLead.details.metaFormId, "form-known");
    log("valid signed Meta webhook preserves configured-form lead ingestion");

    const duplicateMetaBody = JSON.stringify(metaWebhookPayload("meta-existing-1"));
    webhookResult = await request("/api/webhooks/meta", {
      method: "POST",
      headers: { "X-Hub-Signature-256": metaSignature(duplicateMetaBody) },
      body: duplicateMetaBody
    });
    assert.equal(webhookResult.response.status, 200);
    adminState = (await request("/api/state", { headers: auth(adminToken) })).body;
    const existing = adminState.records.find((record) => record.id === "existing-meta-booking");
    assert.equal(existing.status, "Booking", "duplicate webhook reset existing sales status");
    assert.equal(existing.staff, "Nureen", "duplicate webhook overwrote existing staff");
    assert.equal(adminState.records.filter((record) => record.details?.externalPlatform === "meta" && record.details?.externalLeadId === "meta-existing-1").length, 1, "duplicate webhook created duplicate Meta lead");
    log("Meta duplicate webhook does not overwrite Booking/staff/remarks or create duplicate");

    const tiktokPayload = {
      advertiser_id: "adv-1",
      form_id: "tt-form-1",
      leads: [{
        lead_id: "tt-lead-1",
        full_name: "TikTok Old Lead",
        phone_number: "60133333333",
        created_at: "2026-07-05 10:30:00",
        campaign_name: "Wafi LeadsBridge Campaign"
      }]
    };
    const tiktokHmacLeadId = "tt-hmac-valid-1";
    const tiktokHmacBody = JSON.stringify(tiktokWebhookPayload(tiktokHmacLeadId));
    const tiktokHmacResult = await request("/api/webhooks/tiktok/connector", {
      method: "POST",
      headers: { "TikTok-Signature": tiktokSignature(tiktokHmacBody) },
      body: tiktokHmacBody
    });
    assert.equal(tiktokHmacResult.response.status, 200, JSON.stringify(tiktokHmacResult.body));
    assert.equal(tiktokHmacResult.body.results[0].status, "captured");
    adminState = (await request("/api/state", { headers: auth(adminToken) })).body;
    assert.ok(adminState.records.some((record) => record.details?.externalLeadId === tiktokHmacLeadId), "valid TikTok HMAC webhook was not ingested");
    log("valid TikTok HMAC signature is accepted and ingested");

    let tiktokResult = await request(`/api/webhooks/tiktok/connector?token=${encodeURIComponent(tiktokCallbackSecret)}`, { method: "POST", body: JSON.stringify(tiktokPayload) });
    assert.equal(tiktokResult.response.status, 200, JSON.stringify(tiktokResult.body));
    assert.equal(tiktokResult.body.results[0].status, "captured");
    adminState = (await request("/api/state", { headers: auth(adminToken) })).body;
    const tiktokLead = adminState.records.find((record) => record.details?.externalLeadId === "tt-lead-1");
    assert.ok(tiktokLead, "TikTok/LeadsBridge lead was not captured");
    assert.equal(tiktokLead.createdAt, "2026-07-05", "TikTok lead did not preserve original created_time date");

    tiktokResult = await request(`/api/webhooks/tiktok/connector?token=${encodeURIComponent(tiktokCallbackSecret)}`, { method: "POST", body: JSON.stringify(tiktokPayload) });
    assert.equal(tiktokResult.response.status, 200);
    assert.equal(tiktokResult.body.results[0].status, "duplicate");
    adminState = (await request("/api/state", { headers: auth(adminToken) })).body;
    assert.equal(adminState.records.filter((record) => record.details?.externalLeadId === "tt-lead-1").length, 1, "TikTok duplicate created duplicate lead");
    log("TikTok/LeadsBridge preserves source date and dedupes reruns");

  } finally {
    server.kill("SIGTERM");
    await new Promise((resolve) => server.once("exit", resolve));
    if (stderr.trim()) console.error(stderr.trim());
  }
} finally {
  metaServer.close();
  rmSync(tempRoot, { recursive: true, force: true });
}

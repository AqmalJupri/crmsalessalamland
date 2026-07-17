import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import postgres from "postgres";

const baseUrl = process.env.PRODUCTION_SMOKE_URL ?? "http://127.0.0.1:3000";
const requestTimeoutMs = 10_000;
const databaseUrl = process.env.DATABASE_URL;
const productSurface = process.env.PRODUCT_SURFACE;
assert.ok(databaseUrl, "DATABASE_URL is required for the production runtime smoke.");
assert.match(
  productSurface ?? "",
  /^(?:crm|tasha)$/,
  "PRODUCT_SURFACE must identify the immutable artifact under test.",
);
const databaseName = new URL(databaseUrl).pathname.slice(1);
assert.match(
  databaseName,
  /^crm_salam_(?:test|codex)_[a-z0-9_]+$/,
  "Production runtime smoke requires an isolated CRM test database.",
);

const sql = postgres(databaseUrl, { max: 1, prepare: false, onnotice: () => undefined });
const restrictedFixture = {
  organizationId: "10000000-0000-4000-8000-000000000010",
  businessUnitId: "10000000-0000-4000-8000-000000000101",
  userId: "10000000-0000-4000-8000-000000000001",
  membershipId: "10000000-0000-4000-8000-000000000201",
  sessionId: "10000000-0000-4000-8000-000000000301",
  sessionToken: "production-runtime-restricted-viewer",
};

async function removeRestrictedFixture() {
  await sql.begin(async (transaction) => {
    await transaction`delete from sessions where id = ${restrictedFixture.sessionId}`;
    await transaction`delete from memberships where id = ${restrictedFixture.membershipId}`;
    await transaction`delete from users where id = ${restrictedFixture.userId}`;
    await transaction`delete from business_units where id = ${restrictedFixture.businessUnitId}`;
    await transaction`delete from organizations where id = ${restrictedFixture.organizationId}`;
  });
}

async function provisionRestrictedFixture() {
  await removeRestrictedFixture();
  const tokenHash = createHash("sha256").update(restrictedFixture.sessionToken).digest();
  await sql.begin(async (transaction) => {
    await transaction`
      insert into organizations (id, code, name)
      values (${restrictedFixture.organizationId}, 'runtime-scope', 'Runtime Scope')
    `;
    await transaction`
      insert into business_units (id, organization_id, code, name)
      values (
        ${restrictedFixture.businessUnitId},
        ${restrictedFixture.organizationId},
        'runtime-scope',
        'Runtime Scope'
      )
    `;
    await transaction`
      insert into users (id, auth_subject, display_name, user_type, status)
      values (
        ${restrictedFixture.userId},
        'https://identity.example.test#runtime-restricted',
        'Runtime Restricted',
        'HUMAN',
        'ACTIVE'
      )
    `;
    await transaction`
      insert into memberships (
        id, organization_id, business_unit_id, user_id, status, valid_from
      ) values (
        ${restrictedFixture.membershipId},
        ${restrictedFixture.organizationId},
        ${restrictedFixture.businessUnitId},
        ${restrictedFixture.userId},
        'ACTIVE',
        clock_timestamp() - interval '1 minute'
      )
    `;
    await transaction`
      insert into sessions (
        id, organization_id, active_business_unit_id, user_id, token_hash, last_seen_at,
        expires_at
      ) values (
        ${restrictedFixture.sessionId},
        ${restrictedFixture.organizationId},
        ${restrictedFixture.businessUnitId},
        ${restrictedFixture.userId},
        ${tokenHash},
        clock_timestamp() - interval '1 hour',
        clock_timestamp() + interval '1 hour'
      )
    `;
  });
}

async function readRestrictedLastSeen() {
  const [session] = await sql`
    select last_seen_at::text as value
    from sessions
    where id = ${restrictedFixture.sessionId}
  `;
  assert.ok(session?.value, "Restricted runtime session must exist.");
  return session.value;
}

function requireBaselineHeaders(response) {
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.match(response.headers.get("cache-control") ?? "", /no-store/i);
}

function requireSecurityHeaders(response) {
  requireBaselineHeaders(response);
  const csp = response.headers.get("content-security-policy") ?? "";
  assert.match(csp, /script-src[^;]*'strict-dynamic'/i);
  assert.doesNotMatch(csp, /'unsafe-eval'|'unsafe-inline'/i);

  const nonce = csp.match(/'nonce-([^']+)'/i)?.[1];
  assert.ok(nonce, "CSP must contain a nonce.");
  return nonce;
}

function requireMatchingHtmlNonces(html, expectedNonce) {
  const scriptTags = html.match(/<script\b[^>]*>/gi) ?? [];
  assert.ok(scriptTags.length > 0, "HTML must contain framework scripts.");
  for (const tag of scriptTags) {
    assert.equal(
      tag.match(/\bnonce=["']([^"']+)["']/i)?.[1],
      expectedNonce,
      `Script tag is missing the current CSP nonce: ${tag.slice(0, 100)}`,
    );
  }

  const inlineStyleTags = html.match(/<style\b[^>]*>/gi) ?? [];
  for (const tag of inlineStyleTags) {
    assert.equal(
      tag.match(/\bnonce=["']([^"']+)["']/i)?.[1],
      expectedNonce,
      "Inline style tag is missing the current CSP nonce.",
    );
  }
}

function fetchBounded(input, init = {}, timeoutMs = requestTimeoutMs) {
  return fetch(input, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
  });
}

async function verifyHtml(path, expectedStatus, headers) {
  const response = await fetchBounded(new URL(path, baseUrl), {
    redirect: "manual",
    ...(headers ? { headers } : {}),
  });
  assert.equal(response.status, expectedStatus, `${path} returned ${response.status}.`);
  const nonce = requireSecurityHeaders(response);
  requireMatchingHtmlNonces(await response.text(), nonce);
}

async function verifyRscPrefetch(path) {
  const response = await fetchBounded(new URL(path, baseUrl), {
    headers: { "next-router-prefetch": "1", rsc: "1" },
    redirect: "manual",
  });
  assert.equal(response.status, 200);
  requireSecurityHeaders(response);
  assert.match(response.headers.get("content-type") ?? "", /^text\/x-component\b/i);
  const payload = await response.text();
  assert.doesNotMatch(
    payload,
    /NEXT_HTTP_ERROR_FALLBACK;404/,
    "An allowed RSC prefetch must not fail closed as a missing route.",
  );
  assert.ok(
    payload.includes(`"${path.slice(1)}"`),
    `The RSC prefetch payload must identify the requested ${path} route.`,
  );
}

async function verifyRscNavigationRequiresAuthentication(path) {
  const response = await fetchBounded(new URL(path, baseUrl), {
    headers: { rsc: "1" },
    redirect: "manual",
  });
  assert.equal(response.status, 200);
  requireSecurityHeaders(response);
  assert.match(response.headers.get("content-type") ?? "", /^text\/x-component\b/i);

  const payload = await response.text();
  assert.doesNotMatch(
    payload,
    /NEXT_HTTP_ERROR_FALLBACK;404/,
    "An allowed RSC navigation must reach authentication instead of failing closed as a missing route.",
  );
  assert.ok(
    payload.includes(
      `NEXT_REDIRECT;replace;/login?returnTo=${encodeURIComponent(path)};307;`,
    ),
    `The allowed ${path} RSC navigation must preserve its safe authentication return target.`,
  );
}

async function verifyTashaRejectsCrmRouteBeforeViewer() {
  const cookie = `crm_session=${restrictedFixture.sessionToken}`;
  const lastSeenBefore = await readRestrictedLastSeen();
  const htmlResponse = await fetchBounded(new URL("/leads", baseUrl), {
    headers: { Cookie: cookie },
    redirect: "manual",
  });
  assert.equal(htmlResponse.status, 404);
  const htmlNonce = requireSecurityHeaders(htmlResponse);
  const html = await htmlResponse.text();
  assert.match(html, /Halaman tidak ditemui/);
  requireMatchingHtmlNonces(html, htmlNonce);
  assert.equal(
    await readRestrictedLastSeen(),
    lastSeenBefore,
    "A surface-rejected HTML route must not load or refresh its viewer session.",
  );

  const rscResponse = await fetchBounded(new URL("/leads", baseUrl), {
    headers: { Cookie: cookie, rsc: "1" },
    redirect: "manual",
  });
  assert.equal(rscResponse.status, 200);
  requireSecurityHeaders(rscResponse);
  assert.match(rscResponse.headers.get("content-type") ?? "", /^text\/x-component\b/i);
  assert.match(await rscResponse.text(), /NEXT_HTTP_ERROR_FALLBACK;404/);
  assert.equal(
    await readRestrictedLastSeen(),
    lastSeenBefore,
    "A surface-rejected RSC navigation must not load or refresh its viewer session.",
  );
}

async function verifyMalformedPrefetchRejected(path) {
  const response = await fetchBounded(new URL(path, baseUrl), {
    headers: { "next-router-prefetch": "1" },
    redirect: "manual",
  }, 2_000);
  assert.equal(response.status, 400);
  requireBaselineHeaders(response);
  assert.deepEqual(await response.json(), {
    error: {
      code: "INVALID_PREFETCH_CONTRACT",
      message: "Invalid router prefetch request.",
    },
  });
}

try {
  await verifyHtml("/login", 200);
  await verifyHtml("/does-not-exist", 404);
  await verifyHtml("/login", 200, { "next-router-prefetch": "0" });
  const allowedModulePath = productSurface === "tasha" ? "/inventory" : "/leads";
  await verifyRscPrefetch(allowedModulePath);
  await verifyRscNavigationRequiresAuthentication(allowedModulePath);
  await verifyMalformedPrefetchRejected("/login");
  await verifyMalformedPrefetchRejected("/api/internal/prefetch-contract/extra");
  await verifyHtml("/login", 200, { purpose: "prefetch" });

  const unauthenticatedModule = await fetchBounded(new URL("/finance", baseUrl), {
    redirect: "manual",
  });
  assert.equal(unauthenticatedModule.status, 307);
  requireSecurityHeaders(unauthenticatedModule);
  const redirectLocation = new URL(
    unauthenticatedModule.headers.get("location") ?? "",
    baseUrl,
  );
  assert.equal(
    `${redirectLocation.pathname}${redirectLocation.search}`,
    "/login?returnTo=%2Ffinance",
  );

  await provisionRestrictedFixture();
  if (productSurface === "tasha") {
    await verifyTashaRejectsCrmRouteBeforeViewer();
  }
  const forbiddenModule = await fetchBounded(new URL("/finance", baseUrl), {
    headers: { Cookie: `crm_session=${restrictedFixture.sessionToken}` },
    redirect: "manual",
  });
  assert.equal(forbiddenModule.status, 403);
  const forbiddenNonce = requireSecurityHeaders(forbiddenModule);
  const forbiddenHtml = await forbiddenModule.text();
  assert.match(forbiddenHtml, /Akses ditolak/);
  requireMatchingHtmlNonces(forbiddenHtml, forbiddenNonce);

  const readiness = await fetchBounded(new URL("/api/health/ready", baseUrl));
  assert.equal(readiness.status, 200);
  assert.match(readiness.headers.get("cache-control") ?? "", /no-store/i);
  assert.deepEqual(await readiness.json(), {
    status: "ok",
    dependencies: { configuration: "valid", database: "ready" },
  });

  console.log("Production runtime smoke passed.");
} finally {
  await removeRestrictedFixture().catch(() => undefined);
  await sql.end();
}

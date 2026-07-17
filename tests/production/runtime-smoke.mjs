import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import postgres from "postgres";
import {
  readDocumentEvidence,
  requireDocumentEvidence,
  runWithCleanup,
} from "./runtime-evidence.mjs";

const baseUrl = process.env.PRODUCTION_SMOKE_URL ?? "http://127.0.0.1:3000";
const requestTimeoutMs = 10_000;
const privateRobots = "noindex, nofollow, noarchive";
const failClosedFallbackCsp =
  "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'";
const unavailableHtml =
  '<!doctype html><html lang="ms"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow,noarchive"><title>Tidak tersedia</title></head><body><main><p>Aplikasi tidak tersedia di luar talian.</p></main></body></html>';
const oldMetadataDescription = "CRM dan revenue operations Salam";
const expectedMigrationLedger = [
  {
    filename: "0001_foundation.sql",
    checksum: "169f78b45d72a1119969defafee5c2ab6934bb21682ebc53e90850e7651ea0de",
  },
  {
    filename: "0002_migration_platform.sql",
    checksum: "2e8425ae8f551fc5b8c96466f36e917df118a12a18c66e69ec68800e73ec0e73",
  },
  {
    filename: "0003_reconciliation_bytewise_order.sql",
    checksum: "46fb6ab301eb4362dc4c74c186a432e59bcf00736e78ab3d5d8ea8e7359885c4",
  },
  {
    filename: "0004_membership_user_identity_guard.sql",
    checksum: "58713ceda7660aa4a5385c734744c9bb9e12ccb00272032acf9a34cdfca70c5c",
  },
  {
    filename: "0005_reconciliation_typed_result_truth.sql",
    checksum: "8fbf0ff4b506cc682b16b6d3fe4b59d69ee47040b95ed20542ff6983c496c381",
  },
  {
    filename: "0006_reconciliation_finite_amounts.sql",
    checksum: "c320a95155c63273f176d2d79df7f9c729285b9c0474e332207da8f4bf0c5541",
  },
];
const navigationItems = [
  ["/", "Utama", undefined],
  ["/leads", "Lead", "lead.read"],
  ["/pipeline", "Pipeline", "opportunity.read"],
  ["/tasks", "Tugasan", "task.read"],
  ["/orders", "Pesanan", "order.read"],
  ["/inventory", "Inventori", "inventory.read"],
  ["/finance", "Kewangan", "finance.read"],
  ["/marketing", "Pemasaran", "marketing.read"],
  ["/reports", "Laporan", "report.read"],
  ["/team", "Pasukan", "team.read"],
  ["/settings", "Tetapan", "settings.read"],
];
const surfaceContracts = {
  crm: {
    name: "Salam CRM",
    otherName: "Tasha",
    routes: navigationItems,
  },
  tasha: {
    name: "Tasha",
    otherName: "Salam CRM",
    routes: navigationItems.filter(([path]) =>
      ["/", "/inventory", "/orders", "/finance", "/tasks", "/reports"].includes(path),
    ),
  },
};
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
const surfaceContract = surfaceContracts[productSurface];
const restrictedFixture = {
  organizationId: "10000000-0000-4000-8000-000000000010",
  businessUnitId: "10000000-0000-4000-8000-000000000101",
  userId: "10000000-0000-4000-8000-000000000001",
  membershipId: "10000000-0000-4000-8000-000000000201",
  sessionId: "10000000-0000-4000-8000-000000000301",
  sessionToken: "production-runtime-restricted-viewer",
};
const authorizedFixture = {
  organizationId: "20000000-0000-4000-8000-000000000020",
  businessUnitId: "20000000-0000-4000-8000-000000000102",
  userId: "20000000-0000-4000-8000-000000000002",
  membershipId: "20000000-0000-4000-8000-000000000202",
  roleId: "20000000-0000-4000-8000-000000000402",
  sessionId: "20000000-0000-4000-8000-000000000302",
  sessionToken: "production-runtime-authorized-shell-viewer",
};
const authorizedCapabilities = navigationItems.flatMap(([, , capability]) =>
  capability ? [capability] : [],
);

async function removeAuthorizedFixture() {
  await sql.begin(async (transaction) => {
    await transaction`
      delete from membership_roles
      where organization_id = ${authorizedFixture.organizationId}
    `;
    await transaction`
      delete from role_capabilities
      where organization_id = ${authorizedFixture.organizationId}
    `;
    await transaction`delete from sessions where id = ${authorizedFixture.sessionId}`;
    await transaction`delete from memberships where id = ${authorizedFixture.membershipId}`;
    await transaction`delete from roles where id = ${authorizedFixture.roleId}`;
    await transaction`delete from users where id = ${authorizedFixture.userId}`;
    await transaction`delete from business_units where id = ${authorizedFixture.businessUnitId}`;
    await transaction`delete from organizations where id = ${authorizedFixture.organizationId}`;
    for (const capability of authorizedCapabilities) {
      await transaction`
        delete from capabilities
        where key = ${capability}
          and description = ${`Runtime shell proof for ${capability}`}
          and not exists (
            select 1 from role_capabilities where capability_key = ${capability}
          )
      `;
    }
  });
}

async function provisionAuthorizedFixture() {
  await removeAuthorizedFixture();
  const tokenHash = createHash("sha256").update(authorizedFixture.sessionToken).digest();
  await sql.begin(async (transaction) => {
    await transaction`
      insert into organizations (id, code, name)
      values (${authorizedFixture.organizationId}, 'runtime-shell', 'Runtime Shell')
    `;
    await transaction`
      insert into business_units (id, organization_id, code, name)
      values (
        ${authorizedFixture.businessUnitId},
        ${authorizedFixture.organizationId},
        'salam-land',
        'Salam Land'
      )
    `;
    await transaction`
      insert into users (id, auth_subject, display_name, user_type, status)
      values (
        ${authorizedFixture.userId},
        'https://identity.example.test#runtime-shell',
        'Runtime Shell',
        'HUMAN',
        'ACTIVE'
      )
    `;
    await transaction`
      insert into memberships (
        id, organization_id, business_unit_id, user_id, status, valid_from
      ) values (
        ${authorizedFixture.membershipId},
        ${authorizedFixture.organizationId},
        ${authorizedFixture.businessUnitId},
        ${authorizedFixture.userId},
        'ACTIVE',
        clock_timestamp() - interval '1 minute'
      )
    `;
    await transaction`
      insert into roles (id, organization_id, key, name)
      values (
        ${authorizedFixture.roleId},
        ${authorizedFixture.organizationId},
        'runtime-shell-viewer',
        'Runtime Shell Viewer'
      )
    `;
    for (const capability of authorizedCapabilities) {
      await transaction`
        insert into capabilities (key, description)
        values (${capability}, ${`Runtime shell proof for ${capability}`})
      `;
      await transaction`
        insert into role_capabilities (organization_id, role_id, capability_key)
        values (
          ${authorizedFixture.organizationId},
          ${authorizedFixture.roleId},
          ${capability}
        )
      `;
    }
    await transaction`
      insert into membership_roles (organization_id, membership_id, role_id)
      values (
        ${authorizedFixture.organizationId},
        ${authorizedFixture.membershipId},
        ${authorizedFixture.roleId}
      )
    `;
    await transaction`
      insert into sessions (
        id, organization_id, active_business_unit_id, user_id, token_hash, last_seen_at,
        expires_at
      ) values (
        ${authorizedFixture.sessionId},
        ${authorizedFixture.organizationId},
        ${authorizedFixture.businessUnitId},
        ${authorizedFixture.userId},
        ${tokenHash},
        clock_timestamp() - interval '1 hour',
        clock_timestamp() + interval '1 hour'
      )
    `;
  });
}

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

function requirePrivateRobotsHeader(response) {
  assert.equal(response.headers.get("x-robots-tag"), privateRobots);
}

function requireBaselineHeaders(response) {
  requirePrivateRobotsHeader(response);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.match(response.headers.get("cache-control") ?? "", /no-store/i);
}

function requireSurfaceMetadata(html) {
  requireDocumentEvidence(html, {
    language: "ms",
    title: `Log masuk · ${surfaceContract.name}`,
    metadata: {
      "color-scheme": "light",
      "theme-color": "#0B172A",
      robots: privateRobots,
    },
    forbiddenBodyText: [oldMetadataDescription, surfaceContract.otherName],
  });
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

async function verifyHtml(path, expectedStatus, headers, verifyMetadata = false) {
  const response = await fetchBounded(new URL(path, baseUrl), {
    redirect: "manual",
    ...(headers ? { headers } : {}),
  });
  assert.equal(response.status, expectedStatus, `${path} returned ${response.status}.`);
  const nonce = requireSecurityHeaders(response);
  const html = await response.text();
  requireMatchingHtmlNonces(html, nonce);
  if (verifyMetadata) requireSurfaceMetadata(html);
  return html;
}

async function verifyManifest() {
  const response = await fetchBounded(new URL("/manifest.webmanifest", baseUrl));
  assert.equal(response.status, 200);
  requirePrivateRobotsHeader(response);
  assert.match(response.headers.get("content-type") ?? "", /^application\/manifest\+json\b/i);
  const expected = {
    name: surfaceContract.name,
    short_name: surfaceContract.name,
    lang: "ms",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#F8FAFC",
    theme_color: "#0B172A",
    icons: [
      {
        src: `/icons/${productSurface}-192.png`,
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: `/icons/${productSurface}-512.png`,
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: `/icons/${productSurface}-maskable-512.png`,
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
  const manifest = await response.json();
  assert.deepEqual(manifest, expected);
  const serialized = JSON.stringify(manifest);
  assert.doesNotMatch(serialized, new RegExp(surfaceContract.otherName, "i"));
  assert.doesNotMatch(serialized, new RegExp(`/icons/${productSurface === "crm" ? "tasha" : "crm"}-`, "i"));
}

async function verifyServiceWorker() {
  const response = await fetchBounded(new URL("/sw.js", baseUrl));
  assert.equal(response.status, 200);
  requirePrivateRobotsHeader(response);
  assert.match(response.headers.get("content-type") ?? "", /javascript/i);
  const source = await response.text();
  assert.doesNotMatch(source, /\bcaches\b|CacheStorage|cache\.(?:match|put)|caches\.open/);

  let fetchListener;
  let requested;
  const worker = {
    addEventListener(type, listener) {
      if (type === "fetch") fetchListener = listener;
    },
    clients: { claim: () => undefined },
    skipWaiting: () => undefined,
  };
  runInNewContext(source, {
    Response,
    self: worker,
    fetch: (request, init) => {
      requested = { request, init };
      return Promise.reject(new TypeError("offline"));
    },
  });
  assert.equal(typeof fetchListener, "function", "The fetched worker must install a fetch listener.");
  let responsePromise;
  const request = { mode: "navigate", url: `${baseUrl}/private/customer?record=runtime` };
  fetchListener({
    request,
    respondWith(candidate) {
      responsePromise = candidate;
    },
  });
  assert.equal(requested?.request, request);
  assert.deepEqual(Object.keys(requested?.init ?? {}), ["cache"]);
  assert.equal(requested?.init?.cache, "no-store");
  assert.ok(responsePromise, "The worker must respond to navigation requests.");
  const fallback = await responsePromise;
  assert.equal(fallback.status, 503);
  assert.equal(fallback.statusText, "Service Unavailable");
  assert.equal(fallback.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(fallback.headers.get("cache-control"), "no-store");
  assert.equal(fallback.headers.get("x-robots-tag"), privateRobots);
  assert.equal(fallback.headers.get("content-security-policy"), failClosedFallbackCsp);
  assert.equal(await fallback.text(), unavailableHtml);
}

function decodeHtmlText(value) {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

async function verifyAuthorizedSurfaceShell() {
  const response = await fetchBounded(new URL("/?bu=salam-land", baseUrl), {
    headers: { Cookie: `crm_session=${authorizedFixture.sessionToken}` },
    redirect: "manual",
  });
  assert.equal(response.status, 200);
  const nonce = requireSecurityHeaders(response);
  const html = await response.text();
  requireMatchingHtmlNonces(html, nonce);
  const { bodyText } = readDocumentEvidence(html);
  assert.doesNotMatch(bodyText, new RegExp(surfaceContract.otherName, "i"));
  assert.doesNotMatch(
    html,
    new RegExp(`/icons/${productSurface === "crm" ? "tasha" : "crm"}-`, "i"),
  );

  const navigationHtml = html.match(
    /<nav\b[^>]*\baria-label=["']Navigasi utama["'][^>]*>[\s\S]*?<\/nav>/i,
  )?.[0];
  assert.ok(navigationHtml, "The authorized shell must render its primary navigation.");
  const linksByPath = new Map();
  for (const match of navigationHtml.matchAll(
    /<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
  )) {
    const href = match[1].replace(/&amp;/g, "&");
    const pathname = new URL(href, baseUrl).pathname;
    const label = decodeHtmlText(match[2]);
    assert.ok(!linksByPath.has(pathname), `Navigation route ${pathname} must be unique.`);
    linksByPath.set(pathname, label);
  }
  assert.deepEqual(
    [...linksByPath.entries()].sort(([left], [right]) => left.localeCompare(right)),
    surfaceContract.routes
      .map(([path, label]) => [path, label])
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

async function verifyMigrationLedger() {
  const rows = await sql`
    select filename, checksum from schema_migrations order by filename
  `;
  assert.deepEqual(
    Array.from(rows, ({ filename, checksum }) => ({ filename, checksum })),
    expectedMigrationLedger,
  );
}

async function verifyProductionStateGalleryUnavailableBeforeViewer() {
  const lastSeenBefore = await readRestrictedLastSeen();
  const response = await fetchBounded(new URL("/__ui-test__/states", baseUrl), {
    headers: { Cookie: `crm_session=${restrictedFixture.sessionToken}` },
    redirect: "manual",
  });
  assert.equal(response.status, 404);
  const nonce = requireSecurityHeaders(response);
  const html = await response.text();
  assert.match(html, /Halaman tidak ditemui/);
  requireMatchingHtmlNonces(html, nonce);
  assert.equal(
    await readRestrictedLastSeen(),
    lastSeenBefore,
    "The production-only state-gallery rejection must happen before viewer session access.",
  );
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

await runWithCleanup(async () => {
  await verifyHtml("/login", 200, undefined, true);
  await verifyHtml("/does-not-exist", 404);
  await verifyHtml("/login", 200, { "next-router-prefetch": "0" });
  const allowedModulePath = productSurface === "tasha" ? "/inventory" : "/leads";
  await verifyRscPrefetch(allowedModulePath);
  await verifyRscNavigationRequiresAuthentication(allowedModulePath);
  await verifyMalformedPrefetchRejected("/login");
  await verifyMalformedPrefetchRejected("/api/internal/prefetch-contract/extra");
  await verifyHtml("/login", 200, { purpose: "prefetch" });
  await verifyManifest();
  await verifyServiceWorker();
  await verifyMigrationLedger();

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
  await verifyProductionStateGalleryUnavailableBeforeViewer();
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

  await provisionAuthorizedFixture();
  await verifyAuthorizedSurfaceShell();

  const readiness = await fetchBounded(new URL("/api/health/ready", baseUrl));
  assert.equal(readiness.status, 200);
  requirePrivateRobotsHeader(readiness);
  assert.match(readiness.headers.get("cache-control") ?? "", /no-store/i);
  assert.deepEqual(await readiness.json(), {
    status: "ok",
    dependencies: { configuration: "valid", database: "ready" },
  });

}, [removeAuthorizedFixture, removeRestrictedFixture, () => sql.end()]);

console.log("Production runtime smoke passed.");

import assert from "node:assert/strict";

const baseUrl = process.env.PRODUCTION_SMOKE_URL;
const artifactSurface = process.env.ARTIFACT_PRODUCT_SURFACE;
const runtimeSurface = process.env.PRODUCT_SURFACE;
const productNames = {
  crm: "Salam CRM",
  tasha: "Tasha",
};

assert.ok(baseUrl, "PRODUCTION_SMOKE_URL is required.");
assert.match(artifactSurface ?? "", /^(?:crm|tasha)$/);
assert.match(runtimeSurface ?? "", /^(?:crm|tasha)$/);
assert.notEqual(runtimeSurface, artifactSurface, "Mismatch proof requires opposite surfaces.");

async function request(path) {
  return fetch(new URL(path, baseUrl), {
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
}

const readiness = await request("/api/health/ready");
assert.equal(readiness.status, 503);
assert.deepEqual(await readiness.json(), {
  status: "degraded",
  dependencies: { configuration: "invalid", database: "unknown" },
});

const login = await request("/login");
assert.equal(login.status, 500, "Mismatched artifact must not render a working login page.");

const manifest = await request("/manifest.webmanifest");
assert.equal(manifest.status, 200);
assert.deepEqual(
  (await manifest.json()).name,
  productNames[artifactSurface],
  "Static manifest must retain the compiled artifact identity.",
);

console.log("Mismatched runtime surface was rejected by the compiled artifact.");

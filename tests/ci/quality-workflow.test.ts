import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const qualityWorkflow = readFileSync(
  `${repositoryRoot}.github/workflows/quality.yml`,
  "utf8",
);
const playwrightConfig = readFileSync(
  `${repositoryRoot}playwright.config.ts`,
  "utf8",
);

function workflowStep(name: string) {
  const start = qualityWorkflow.indexOf(`- name: ${name}`);
  expect(start, `workflow step ${name} must exist`).toBeGreaterThanOrEqual(0);

  const next = qualityWorkflow.indexOf("\n      - name:", start + 1);
  return qualityWorkflow.slice(start, next === -1 ? undefined : next);
}

function workflowJob(name: string) {
  const marker = `  ${name}:\n`;
  const start = qualityWorkflow.indexOf(marker);
  expect(start, `workflow job ${name} must exist`).toBeGreaterThanOrEqual(0);

  const remaining = qualityWorkflow.slice(start + marker.length);
  const next = remaining.search(/^  [a-z][\w-]*:\s*$/m);
  return qualityWorkflow.slice(
    start,
    next === -1 ? undefined : start + marker.length + next,
  );
}

function jobStep(job: string, name: string) {
  const start = job.indexOf(`- name: ${name}`);
  expect(start, `job step ${name} must exist`).toBeGreaterThanOrEqual(0);

  const next = job.indexOf("\n      - name:", start + 1);
  return job.slice(start, next === -1 ? undefined : next);
}

function requiredPort(source: string, pattern: RegExp, label: string) {
  const match = source.match(pattern);
  expect(match, `${label} must declare a port`).not.toBeNull();
  return Number(match?.[1]);
}

describe("Quality workflow server lifecycle", () => {
  it("isolates the production smoke server from Playwright's web server", () => {
    const smokeStep = workflowStep("Smoke production runtime and security headers");
    const serverPort = requiredPort(smokeStep, /\bPORT:\s*["']?(\d+)/, "smoke server");
    const probePort = requiredPort(
      smokeStep,
      /PRODUCTION_SMOKE_URL=http:\/\/127\.0\.0\.1:(\d+)/,
      "runtime probe",
    );
    const playwrightPort = requiredPort(
      playwrightConfig,
      /webServer:[\s\S]*?url:\s*["']http:\/\/localhost:(\d+)\//,
      "Playwright web server",
    );

    expect(serverPort).toBe(probePort);
    expect(serverPort).not.toBe(playwrightPort);
  });

  it("terminates the complete production smoke process group", () => {
    const smokeStep = workflowStep("Smoke production runtime and security headers");

    expect(smokeStep).toContain("setsid pnpm start");
    expect(smokeStep).toContain('kill -TERM -- "-$server_pid"');
  });
});

describe("Quality workflow deployment artifacts", () => {
  it("applies migrations once before the build matrix", () => {
    const checksJob = workflowJob("checks");
    const buildJob = workflowJob("build");

    expect(qualityWorkflow.match(/pnpm db:migrate/g) ?? []).toHaveLength(1);
    expect(checksJob).toMatch(/- name: Apply production migrations\s+run: pnpm db:migrate/);
    expect(buildJob).toContain("needs: checks");
  });

  it("builds immutable CRM and Tasha artifacts from the same commit", () => {
    const buildJob = workflowJob("build");

    expect(buildJob.match(/- surface:/g) ?? []).toHaveLength(2);
    expect(buildJob).toContain("- surface: crm");
    expect(buildJob).toContain("- surface: tasha");
    expect(buildJob).toContain('PRODUCT_SURFACE: ${{ matrix.surface }}');
    expect(buildJob).toContain('DEPLOYMENT_ENVIRONMENT: "ci"');
    expect(buildJob).toContain('APP_VERSION: ${{ github.sha }}');
    expect(buildJob).toContain("run: pnpm build");
    expect(buildJob).toContain("actions/upload-artifact@");
    expect(buildJob).toContain('production-${{ matrix.surface }}-${{ github.sha }}');

    const checkout = jobStep(buildJob, "Checkout");
    expect(checkout).toContain("persist-credentials: false");
    expect(checkout).toContain('ref: ${{ github.sha }}');
  });

  it("keeps database ownership out of workflow-global and build-job scopes", () => {
    const workflowGlobal = qualityWorkflow.slice(0, qualityWorkflow.indexOf("jobs:"));
    const buildJob = workflowJob("build");

    expect(workflowGlobal).not.toMatch(/DATABASE_URL|TEST_DATABASE_URL/);
    expect(buildJob).not.toMatch(
      /DATABASE_URL|TEST_DATABASE_URL|\bservices:|postgres:|db:migrate|test:db/,
    );
  });

  it("smokes both immutable surface artifacts without rebuilding or migrating", () => {
    const smokeJob = workflowJob("runtime-smoke");

    expect(smokeJob).toContain("needs: [checks, build]");
    expect(smokeJob.match(/- surface:/g) ?? []).toHaveLength(2);
    expect(smokeJob).toContain("- surface: crm");
    expect(smokeJob).toContain("app_url: https://crm-ci.example.test");
    expect(smokeJob).toContain("oidc_client_id: crm-ci");
    expect(smokeJob).toContain("- surface: tasha");
    expect(smokeJob).toContain("app_url: https://tasha-ci.example.test");
    expect(smokeJob).toContain("oidc_client_id: tasha-ci");
    expect(smokeJob).toContain('PRODUCT_SURFACE: ${{ matrix.surface }}');
    expect(smokeJob).toContain('APP_URL: ${{ matrix.app_url }}');
    expect(smokeJob).toContain('OIDC_CLIENT_ID: ${{ matrix.oidc_client_id }}');
    expect(smokeJob).toContain(
      'OIDC_REDIRECT_URI: ${{ matrix.app_url }}/api/v1/auth/oidc/callback',
    );
    expect(smokeJob).toContain("actions/download-artifact@");
    expect(smokeJob).toContain('production-${{ matrix.surface }}-${{ github.sha }}');
    expect(smokeJob).toContain('${{ matrix.surface }}-${{ github.sha }}.tar.gz');
    expect(smokeJob).not.toContain("pnpm build");
    expect(smokeJob).not.toContain("pnpm db:migrate");
  });

  it("installs and starts the packaged application from an empty runtime directory", () => {
    const buildJob = workflowJob("build");
    const smokeJob = workflowJob("runtime-smoke");
    const packageStep = jobStep(buildJob, "Package production artifact");
    const extractStep = jobStep(smokeJob, "Extract production artifact");
    const installStep = jobStep(smokeJob, "Install artifact production dependencies");
    const smokeStep = jobStep(smokeJob, "Smoke production runtime and security headers");

    expect(packageStep).toMatch(
      /\.next public package\.json pnpm-lock\.yaml pnpm-workspace\.yaml next\.config\.ts/,
    );
    expect(extractStep).toContain(
      'runtime_dir="$RUNNER_TEMP/runtime-${{ matrix.surface }}"',
    );
    expect(extractStep).toContain('mkdir "$runtime_dir"');
    expect(extractStep).toContain('-C "$runtime_dir"');
    expect(installStep).toMatch(
      /pnpm --dir "\$RUNNER_TEMP\/runtime-\$\{\{ matrix\.surface \}\}"\s+install --prod --frozen-lockfile/,
    );
    expect(smokeStep).toContain(
      'cd "$RUNNER_TEMP/runtime-${{ matrix.surface }}"',
    );
    expect(smokeStep).toContain("setsid pnpm start");
    expect(smokeStep.indexOf("cd ")).toBeLessThan(smokeStep.indexOf("setsid pnpm start"));
    expect(smokeStep).toContain(
      'pnpm --dir "$GITHUB_WORKSPACE" test:runtime',
    );
  });

  it("publishes one terminal verify result that depends on every quality gate", () => {
    const verifyJob = workflowJob("verify");

    expect(verifyJob).toContain("needs: [checks, build, runtime-smoke]");
    expect(verifyJob).toContain("if: always()");
    expect(verifyJob).toContain('CHECKS_RESULT: ${{ needs.checks.result }}');
    expect(verifyJob).toContain('BUILD_RESULT: ${{ needs.build.result }}');
    expect(verifyJob).toContain(
      'RUNTIME_SMOKE_RESULT: ${{ needs.runtime-smoke.result }}',
    );
    expect(verifyJob).toContain('test "$CHECKS_RESULT" = "success"');
    expect(verifyJob).toContain('test "$BUILD_RESULT" = "success"');
    expect(verifyJob).toContain('test "$RUNTIME_SMOKE_RESULT" = "success"');
  });
});

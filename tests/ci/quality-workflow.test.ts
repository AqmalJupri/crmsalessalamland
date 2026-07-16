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
    const verifyJob = workflowJob("verify");
    const buildJob = workflowJob("build");

    expect(qualityWorkflow.match(/pnpm db:migrate/g) ?? []).toHaveLength(1);
    expect(verifyJob).toMatch(/- name: Apply production migrations\s+run: pnpm db:migrate/);
    expect(buildJob).toContain("needs: verify");
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
  });

  it("keeps database ownership out of build jobs", () => {
    const buildJob = workflowJob("build");

    expect(buildJob).not.toMatch(
      /DATABASE_URL|TEST_DATABASE_URL|\bservices:|postgres:|db:migrate|test:db/,
    );
  });

  it("smokes the immutable CRM artifact without rebuilding it", () => {
    const smokeJob = workflowJob("runtime-smoke");

    expect(smokeJob).toContain("needs:");
    expect(smokeJob).toContain("build");
    expect(smokeJob).toContain("actions/download-artifact@");
    expect(smokeJob).toContain('production-crm-${{ github.sha }}');
    expect(smokeJob).not.toContain("pnpm build");
    expect(smokeJob).not.toContain("pnpm db:migrate");
  });
});

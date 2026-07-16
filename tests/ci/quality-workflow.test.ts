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

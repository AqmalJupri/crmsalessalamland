import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { PlaywrightTestConfig } from "@playwright/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isAlias,
  isMap,
  isPair,
  isScalar,
  isSeq,
  parseDocument,
  type Node as YamlNode,
  type Pair,
} from "yaml";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const qualityWorkflow = readFileSync(
  `${repositoryRoot}.github/workflows/quality.yml`,
  "utf8",
);
const productionCoverageConfig = readFileSync(
  `${repositoryRoot}vitest.production-coverage.config.ts`,
  "utf8",
);
const migrationLedgerGatePath = `${repositoryRoot}scripts/ci/verify-migration-ledger.ts`;
const migrationLedgerGateSource = existsSync(migrationLedgerGatePath)
  ? readFileSync(migrationLedgerGatePath, "utf8")
  : "";
const visualEvidenceContractSource = readFileSync(
  `${repositoryRoot}tests/ui/visual-evidence-contract.test.ts`,
  "utf8",
);
const packageJson = JSON.parse(
  readFileSync(`${repositoryRoot}package.json`, "utf8"),
) as {
  scripts: Record<string, string>;
  devDependencies: Record<string, string>;
};

const expectedE2eScripts = {
  "test:e2e": "pnpm test:e2e:crm && pnpm test:e2e:tasha",
  "test:e2e:crm": "pnpm clean:next && DATABASE_URL=postgresql://crm:crm_local_only@127.0.0.1:5432/crm_salam_codex_ui APP_URL=http://127.0.0.1:3201 AUTH_HASH_KEY=ui-e2e-auth-hash-key-0123456789abcdef CRM_DEMO_MODE=true DEPLOYMENT_ENVIRONMENT=local PRODUCT_SURFACE=crm E2E_PRODUCT_SURFACE=crm E2E_PORT=3201 playwright test",
  "test:e2e:tasha": "pnpm clean:next && DATABASE_URL=postgresql://crm:crm_local_only@127.0.0.1:5432/crm_salam_codex_ui APP_URL=http://127.0.0.1:3202 AUTH_HASH_KEY=ui-e2e-auth-hash-key-0123456789abcdef CRM_DEMO_MODE=true DEPLOYMENT_ENVIRONMENT=local PRODUCT_SURFACE=tasha E2E_PRODUCT_SURFACE=tasha E2E_PORT=3202 playwright test",
} as const;

const expectedProjects = [
  { name: "mobile-chromium-320x800", width: 320, height: 800, isMobile: true, hasTouch: true },
  { name: "mobile-chromium-375x812", width: 375, height: 812, isMobile: true, hasTouch: true },
  { name: "mobile-chromium-390x844", width: 390, height: 844, isMobile: true, hasTouch: true },
  { name: "desktop-chromium-768x1024", width: 768, height: 1024, isMobile: false, hasTouch: false },
  { name: "desktop-chromium-1024x768", width: 1024, height: 768, isMobile: false, hasTouch: false },
  { name: "desktop-chromium-1280x800", width: 1280, height: 800, isMobile: false, hasTouch: false },
  { name: "desktop-chromium-1440x900", width: 1440, height: 900, isMobile: false, hasTouch: false },
] as const;

const playwrightEnvironmentKeys = [
  "APP_URL",
  "E2E_PORT",
  "E2E_PRODUCT_SURFACE",
  "PRODUCT_SURFACE",
] as const;

async function loadPlaywrightConfig(overrides: Partial<Record<(typeof playwrightEnvironmentKeys)[number], string | undefined>>): Promise<PlaywrightTestConfig> {
  const previous = Object.fromEntries(
    playwrightEnvironmentKeys.map((key) => [key, process.env[key]]),
  );

  for (const key of playwrightEnvironmentKeys) {
    const value = overrides[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.resetModules();

  try {
    return (await import("../../playwright.config")).default;
  } finally {
    for (const key of playwrightEnvironmentKeys) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.resetModules();
  }
}

function surfaceConfig(surface: "crm" | "tasha") {
  const port = surface === "crm" ? "3201" : "3202";
  return loadPlaywrightConfig({
    APP_URL: `http://127.0.0.1:${port}`,
    E2E_PORT: port,
    E2E_PRODUCT_SURFACE: surface,
    PRODUCT_SURFACE: surface,
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

const expectedSurfaceBindings = [
  {
    surface: "crm",
    app_url: "https://crm-ci.example.test",
    oidc_client_id: "crm-ci",
    mismatched_surface: "tasha",
  },
  {
    surface: "tasha",
    app_url: "https://tasha-ci.example.test",
    oidc_client_id: "tasha-ci",
    mismatched_surface: "crm",
  },
];

const migrationDatabaseName = "crm_salam_codex_migration_platform";
const migrationDatabaseUrl =
  `postgresql://crm:crm_local_only@127.0.0.1:5432/${migrationDatabaseName}`;
const productionMigrationSuites = [
  "tests/integration/migration-platform-schema.test.ts",
  "tests/integration/migration-schema-parity.test.ts",
  "tests/integration/migration-runner.test.ts",
  "tests/integration/migration-source-registration.test.ts",
  "tests/integration/import-batch-service.test.ts",
  "tests/integration/import-row-service.test.ts",
  "tests/integration/import-validation-approval.test.ts",
  "tests/integration/import-apply-service.test.ts",
  "tests/integration/reconciliation-service.test.ts",
  "tests/integration/migration-cli.test.ts",
] as const;

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

function expectDatabaseFreeRootScope(source: string) {
  expect(source).not.toMatch(/^(?:env|["']env["'])[ \t]*:/m);
}

function parseMatrixEntry(target: Record<string, string>, source: string) {
  const separator = source.indexOf(":");
  if (separator < 1 || !source.slice(separator + 1).trim()) {
    throw new Error(`Invalid matrix entry: ${source}`);
  }

  const key = source.slice(0, separator).trim();
  if (Object.hasOwn(target, key)) {
    throw new Error(`Duplicate matrix entry: ${key}`);
  }
  target[key] = source.slice(separator + 1).trim();
}

function surfaceBindings(job: string) {
  const lines = job.split("\n");
  const includeIndex = lines.findIndex((line) => /^\s+include:\s*$/.test(line));
  expect(includeIndex, "surface matrix include block must exist").toBeGreaterThanOrEqual(0);

  const includeIndent = lines[includeIndex]!.match(/^\s*/)?.[0].length ?? 0;
  const rowPrefix = `${" ".repeat(includeIndent + 2)}- `;
  const propertyPrefix = " ".repeat(includeIndent + 4);
  const rows: Array<Record<string, string>> = [];

  for (const line of lines.slice(includeIndex + 1)) {
    if (!line.trim()) continue;
    const indentation = line.match(/^\s*/)?.[0].length ?? 0;
    if (indentation <= includeIndent) break;

    if (line.startsWith(rowPrefix)) {
      const row: Record<string, string> = {};
      parseMatrixEntry(row, line.slice(rowPrefix.length));
      rows.push(row);
      continue;
    }

    if (line.startsWith(propertyPrefix) && indentation === includeIndent + 4 && rows.length) {
      parseMatrixEntry(rows.at(-1)!, line.slice(propertyPrefix.length));
      continue;
    }

    throw new Error(`Unexpected surface matrix line: ${line}`);
  }

  return rows;
}

function expectSurfaceBindings(job: string) {
  const rows = surfaceBindings(job);
  expect(rows).toEqual(expectedSurfaceBindings);
  return rows;
}

interface WorkflowStepValue {
  readonly name?: unknown;
  readonly if?: unknown;
  readonly uses?: unknown;
  readonly run?: unknown;
  readonly with?: unknown;
  readonly env?: unknown;
}

interface WorkflowJobValue {
  readonly needs?: unknown;
  readonly if?: unknown;
  readonly "runs-on"?: unknown;
  readonly permissions?: unknown;
  readonly strategy?: unknown;
  readonly steps?: unknown;
  readonly env?: unknown;
}

interface StrictWorkflowValue {
  readonly jobs: Readonly<Record<string, WorkflowJobValue>>;
}

function assertSafeYamlNode(node: YamlNode | Pair | null): void {
  if (!node) return;
  if (isAlias(node)) throw new Error("YAML aliases are forbidden.");
  if ("anchor" in node && node.anchor) throw new Error("YAML anchors are forbidden.");
  if ("tag" in node && node.tag) throw new Error("Explicit YAML tags are forbidden.");

  if (isPair(node)) {
    if (!isScalar(node.key) || typeof node.key.value !== "string") {
      throw new Error("YAML mapping keys must be plain strings.");
    }
    if (node.key.value === "<<") throw new Error("YAML merge keys are forbidden.");
    assertSafeYamlNode(node.key);
    assertSafeYamlNode(node.value as YamlNode | null);
    return;
  }
  if (isMap(node)) {
    for (const item of node.items) assertSafeYamlNode(item);
    return;
  }
  if (isSeq(node)) {
    for (const item of node.items) assertSafeYamlNode(item as YamlNode | null);
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function parseStrictWorkflow(source: string): StrictWorkflowValue {
  const document = parseDocument(source, {
    schema: "core",
    strict: true,
    stringKeys: true,
    uniqueKeys: true,
  });
  if (document.errors.length) {
    throw new Error(`Invalid workflow YAML: ${document.errors.map(String).join("; ")}`);
  }
  if (document.warnings.length) {
    throw new Error(`Workflow YAML warnings are forbidden: ${document.warnings.map(String).join("; ")}`);
  }
  assertSafeYamlNode(document.contents);

  const value: unknown = document.toJS({ maxAliasCount: 0 });
  if (!isPlainRecord(value) || !isPlainRecord(value.jobs)) {
    throw new Error("Workflow root and jobs must be mappings.");
  }
  for (const [name, job] of Object.entries(value.jobs)) {
    if (!/^[a-z][a-z0-9-]*$/.test(name) || !isPlainRecord(job)) {
      throw new Error(`Workflow job ${name} must be a plain mapping.`);
    }
  }
  return value as unknown as StrictWorkflowValue;
}

const strictWorkflow = parseStrictWorkflow(qualityWorkflow);

const reviewedRunner = "ubuntu-24.04";
const reviewedActionPins = new Set([
  "actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5",
  "pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1",
  "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
  "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
  "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093",
  "actions/attest@a1948c3f048ba23858d222213b7c278aabede763",
]);

function strictJob(name: string): WorkflowJobValue {
  const job = strictWorkflow.jobs[name];
  if (!job) throw new Error(`Workflow job ${name} must exist.`);
  return job;
}

function strictSteps(job: WorkflowJobValue): readonly WorkflowStepValue[] {
  if (!Array.isArray(job.steps) || job.steps.some((step) => !isPlainRecord(step))) {
    throw new Error("Workflow steps must be an array of plain mappings.");
  }
  return job.steps as readonly WorkflowStepValue[];
}

function strictStep(job: WorkflowJobValue, name: string): WorkflowStepValue {
  const matches = strictSteps(job).filter((step) => step.name === name);
  if (matches.length !== 1) throw new Error(`Workflow step ${name} must exist exactly once.`);
  return matches[0]!;
}

function strictNeeds(job: WorkflowJobValue): readonly string[] {
  if (typeof job.needs === "string") return [job.needs];
  if (Array.isArray(job.needs) && job.needs.every((value) => typeof value === "string")) {
    return job.needs;
  }
  throw new Error("Workflow needs must be a string or string array.");
}

function strictReleaseSurfaces(job: WorkflowJobValue): readonly string[] {
  if (!isPlainRecord(job.strategy) || !isPlainRecord(job.strategy.matrix)) {
    throw new Error("Release job must define a matrix mapping.");
  }
  const include = job.strategy.matrix.include;
  if (!Array.isArray(include) || include.some((row) => !isPlainRecord(row))) {
    throw new Error("Release matrix include must contain mappings.");
  }
  return include.map((row) => {
    if (Object.keys(row).length !== 1 || !["crm", "tasha"].includes(String(row.surface))) {
      throw new Error("Release matrix rows may contain only literal crm/tasha surfaces.");
    }
    return String(row.surface);
  });
}

function expectPinnedActions(job: WorkflowJobValue): void {
  const actions = strictSteps(job)
    .map((step) => step.uses)
    .filter((value): value is string => typeof value === "string");
  expect(actions.length).toBeGreaterThan(0);
  for (const action of actions) {
    expect(reviewedActionPins.has(action), `unreviewed action ${action}`).toBe(true);
  }
}

function expectExactCheckout(job: WorkflowJobValue): void {
  const checkout = strictSteps(job).filter(
    (step) => typeof step.uses === "string" && step.uses.startsWith("actions/checkout@"),
  );
  expect(checkout).toHaveLength(1);
  expect(checkout[0]?.with).toEqual({
    "persist-credentials": false,
    ref: "${{ github.sha }}",
  });
}

describe("Dual-surface Playwright contract", () => {
  it("pins the reviewed browser runtime and deterministic surface commands", () => {
    expect(packageJson.devDependencies["@playwright/test"]).toBe("1.61.1");
    expect(packageJson.scripts).toMatchObject(expectedE2eScripts);
  });

  it.each([
    ["surface", { E2E_PORT: "3201", PRODUCT_SURFACE: "crm", APP_URL: "http://127.0.0.1:3201" }],
    ["port", { E2E_PRODUCT_SURFACE: "crm", PRODUCT_SURFACE: "crm", APP_URL: "http://127.0.0.1:3201" }],
  ] as const)("rejects a missing required E2E %s binding", async (_label, environment) => {
    await expect(loadPlaywrightConfig(environment)).rejects.toThrow(/E2E_(?:PRODUCT_SURFACE|PORT)/);
  });

  it.each([
    [
      "surface mismatch",
      {
        APP_URL: "http://127.0.0.1:3201",
        E2E_PORT: "3201",
        E2E_PRODUCT_SURFACE: "crm",
        PRODUCT_SURFACE: "tasha",
      },
    ],
    [
      "surface port mismatch",
      {
        APP_URL: "http://127.0.0.1:3202",
        E2E_PORT: "3202",
        E2E_PRODUCT_SURFACE: "crm",
        PRODUCT_SURFACE: "crm",
      },
    ],
    [
      "application URL mismatch",
      {
        APP_URL: "http://127.0.0.1:3999",
        E2E_PORT: "3201",
        E2E_PRODUCT_SURFACE: "crm",
        PRODUCT_SURFACE: "crm",
      },
    ],
  ] as const)("rejects a %s instead of trusting host state", async (_label, environment) => {
    await expect(loadPlaywrightConfig(environment)).rejects.toThrow(/surface|port|APP_URL/i);
  });

  it.each(["crm", "tasha"] as const)(
    "defines the exact seven %s Chromium viewports and isolated artifact paths",
    async (surface) => {
      const config = await surfaceConfig(surface);
      const port = surface === "crm" ? 3201 : 3202;
      const projects = (config.projects ?? []).map((project) => {
        const use = project.use as {
          browserName?: string;
          hasTouch?: boolean;
          isMobile?: boolean;
          viewport?: { width: number; height: number } | null;
        };
        return {
          name: project.name,
          width: use.viewport?.width,
          height: use.viewport?.height,
          isMobile: use.isMobile ?? false,
          hasTouch: use.hasTouch ?? false,
          browserName: use.browserName,
        };
      });

      expect(projects).toEqual(
        expectedProjects.map((project) => ({ ...project, browserName: "chromium" })),
      );
      expect(config.use?.baseURL).toBe(`http://127.0.0.1:${port}`);
      expect(config.outputDir).toBe(`.playwright/${surface}/test-results`);
      expect(config.snapshotPathTemplate).toBe(
        `tests/e2e/__snapshots__/${surface}/{testFilePath}/{projectName}/{arg}{ext}`,
      );
      expect(config.preserveOutput).toBe("failures-only");

      const webServer = Array.isArray(config.webServer)
        ? config.webServer[0]
        : config.webServer;
      expect(webServer).toMatchObject({
        command: `pnpm exec next dev --hostname 127.0.0.1 --port ${port}`,
        url: `http://127.0.0.1:${port}/api/health/live`,
        reuseExistingServer: false,
      });

      const reporters = Array.isArray(config.reporter) ? config.reporter : [];
      const htmlReporter = reporters.find(
        (reporter) => Array.isArray(reporter) && reporter[0] === "html",
      );
      expect(htmlReporter?.[1]).toMatchObject({
        open: "never",
        outputFolder: `.playwright/${surface}/report`,
      });
    },
  );
});

describe("Quality workflow mutation resistance", () => {
  it.each([
    ["block", "env:\n  DATABASE_URL: postgresql://forbidden.example.test/crm"],
    ["inline", "env: { DATABASE_URL: postgresql://forbidden.example.test/crm }"],
    ["alias", "env: *database-environment"],
    ["double-quoted key", '"env": { DATABASE_URL: forbidden }'],
    ["single-quoted key", "'env': { DATABASE_URL: forbidden }"],
  ])("rejects a root %s environment declared after jobs", (_label, rootEnvironment) => {
    const mutatedWorkflow = `${qualityWorkflow.trimEnd()}\n\n${rootEnvironment}\n`;

    expect(() => expectDatabaseFreeRootScope(mutatedWorkflow)).toThrow();
  });

  it("rejects CRM and Tasha values swapped between matrix rows", () => {
    const smokeJob = workflowJob("runtime-smoke");
    const mutatedJob = smokeJob
      .replace(
        "app_url: https://crm-ci.example.test\n            oidc_client_id: crm-ci",
        "__CRM_SURFACE_BINDING__",
      )
      .replace(
        "app_url: https://tasha-ci.example.test\n            oidc_client_id: tasha-ci",
        "app_url: https://crm-ci.example.test\n            oidc_client_id: crm-ci",
      )
      .replace(
        "__CRM_SURFACE_BINDING__",
        "app_url: https://tasha-ci.example.test\n            oidc_client_id: tasha-ci",
      );

    expect(() => expectSurfaceBindings(mutatedJob)).toThrow();
  });
});

describe("Quality workflow server lifecycle", () => {
  it("isolates the production smoke server from both Playwright servers", () => {
    const smokeJob = workflowJob("runtime-smoke");
    const smokeStep = jobStep(smokeJob, "Smoke production runtime and security headers");
    const serverPort = requiredPort(smokeStep, /\bPORT:\s*["']?(\d+)/, "smoke server");

    expect(serverPort).toBe(3100);
    expect(serverPort).not.toBe(3201);
    expect(serverPort).not.toBe(3202);
  });

  it("delegates the complete production process group to the portable Node owner", () => {
    const smokeJob = workflowJob("runtime-smoke");
    const smokeStep = jobStep(smokeJob, "Smoke production runtime and security headers");

    expect(smokeStep).toContain(
      'node "$GITHUB_WORKSPACE/scripts/ci/run-next-runtime-smoke.mjs"',
    );
    expect(smokeStep).not.toMatch(/\bsetsid\b|\bcurl\b|kill\s+-TERM|pnpm\s+start/);
  });

  it("rejects running either immutable artifact as the other product surface", () => {
    const smokeJob = workflowJob("runtime-smoke");
    const mismatchStep = jobStep(smokeJob, "Reject mismatched runtime surface");

    expect(mismatchStep).toContain('ARTIFACT_PRODUCT_SURFACE: ${{ matrix.surface }}');
    expect(mismatchStep).toContain('PRODUCT_SURFACE: ${{ matrix.mismatched_surface }}');
    expect(mismatchStep).toContain('PORT: "3101"');
    expect(mismatchStep).toContain(
      'node "$GITHUB_WORKSPACE/scripts/ci/run-next-runtime-surface-mismatch.mjs"',
    );
    expect(mismatchStep).not.toMatch(/pnpm\s+build|db:migrate/);
  });
});

describe("Quality workflow browser evidence", () => {
  it("provisions the exact synthetic browser role and database from the migrated snapshot", () => {
    const checksJob = workflowJob("checks");
    const prepareStep = jobStep(checksJob, "Prepare synthetic browser database");
    const browserStep = jobStep(
      checksJob,
      "Run isolated CRM and Tasha browser evidence",
    );

    expect(prepareStep).not.toContain("CREATE ROLE crm");
    expect(prepareStep).toContain(
      "createdb --username=postgres --owner=crm crm_salam_codex_ui",
    );
    expect(prepareStep).toContain(
      `"$RUNNER_TEMP/migrated-db/${migrationDatabaseName}.dump"`,
    );
    expect(prepareStep).toMatch(
      /pg_restore[\s\S]*--no-owner --no-privileges[\s\S]*--dbname="\$browser_database_url"/,
    );
    expect(prepareStep).toContain(
      "browser_database_url=postgresql://crm:crm_local_only@127.0.0.1:5432/crm_salam_codex_ui",
    );
    expect(prepareStep).not.toMatch(/pg_restore[\s\S]*--username=postgres/);
    expect(prepareStep).not.toMatch(/dropdb/i);
    expect(checksJob.indexOf("Prepare synthetic browser database")).toBeLessThan(
      checksJob.indexOf("Run isolated CRM and Tasha browser evidence"),
    );
    expect(browserStep).toContain("pnpm test:e2e");
  });

  it("runs the exact CRM then Tasha package contract without workflow surface overrides", () => {
    const checksJob = workflowJob("checks");
    const browserStep = jobStep(
      checksJob,
      "Run isolated CRM and Tasha browser evidence",
    );

    expect(browserStep).toContain(
      "unset OIDC_ISSUER OIDC_CLIENT_ID OIDC_CLIENT_SECRET OIDC_REDIRECT_URI",
    );
    expect(browserStep).toMatch(
      /unset OIDC_ISSUER OIDC_CLIENT_ID OIDC_CLIENT_SECRET OIDC_REDIRECT_URI\s+pnpm test:e2e/,
    );
    expect(browserStep).not.toMatch(/\n\s+env:/);
    expect(browserStep).not.toMatch(
      /E2E_PRODUCT_SURFACE|E2E_PORT|PRODUCT_SURFACE|APP_URL/,
    );
    expect(packageJson.scripts["test:e2e"]).toBe(
      "pnpm test:e2e:crm && pnpm test:e2e:tasha",
    );
  });

  it("uploads only failed synthetic surface-namespaced evidence for one day", () => {
    const checksJob = workflowJob("checks");
    const uploadStep = jobStep(
      checksJob,
      "Upload failed synthetic Playwright evidence",
    );

    expect(uploadStep).toContain("if: failure()");
    expect(uploadStep).toContain("actions/upload-artifact@");
    expect(uploadStep).toContain("name: synthetic-playwright-failure-${{ github.sha }}");
    expect(uploadStep).toContain(".playwright/crm");
    expect(uploadStep).toContain(".playwright/tasha");
    expect(uploadStep).toContain("if-no-files-found: ignore");
    expect(uploadStep).toContain("retention-days: 1");
    expect(uploadStep).not.toMatch(/retention-days:\s*(?:[2-9]|\d{2,})/);
  });

  it("supports an explicit manual Linux visual baseline capture request", () => {
    const checksJob = workflowJob("checks");
    const normalStep = jobStep(
      checksJob,
      "Run isolated CRM and Tasha browser evidence",
    );
    const captureStep = jobStep(
      checksJob,
      "Capture reviewed Linux visual baselines",
    );
    const uploadStep = jobStep(
      checksJob,
      "Upload Linux visual baseline candidates",
    );

    expect(qualityWorkflow).toMatch(
      /workflow_dispatch:[\s\S]*capture_visual_baselines:[\s\S]*type:\s*boolean[\s\S]*default:\s*false/,
    );
    expect(normalStep).toContain("env.VISUAL_CAPTURE_REQUESTED != 'true'");
    expect(normalStep).toContain("pnpm test:e2e");
    expect(normalStep).not.toContain("--update-snapshots");
    expect(captureStep).toContain("env.VISUAL_CAPTURE_REQUESTED == 'true'");
    expect(captureStep).toContain("VISUAL_BASELINE_CAPTURE: reviewed-linux");
    expect(captureStep).toContain(
      "pnpm test:e2e:crm tests/e2e/ui-visual.spec.ts --update-snapshots=all",
    );
    expect(captureStep).toContain(
      "pnpm test:e2e:tasha tests/e2e/ui-visual.spec.ts --update-snapshots=all",
    );
    expect(captureStep).not.toMatch(/--update-snapshots(?:\s|$)/);
    expect(captureStep).toContain(
      "pnpm exec tsx scripts/ci/write-visual-baseline-provenance.ts",
    );
    expect(uploadStep).toContain(
      "env.VISUAL_CAPTURE_REQUESTED == 'true' && success()",
    );
    expect(uploadStep).toContain("visual-baseline-candidates-${{ github.sha }}");
    expect(uploadStep).toContain("tests/e2e/__snapshots__");
    expect(uploadStep).toContain("retention-days: 1");
  });

  it(
    "lets manual capture regenerate stale reviewed evidence without weakening normal runs",
    () => {
      const result = spawnSync(
        "pnpm",
        ["exec", "vitest", "run", "tests/ui/visual-evidence-contract.test.ts"],
        {
          cwd: repositoryRoot,
          encoding: "utf8",
          env: { ...process.env, VISUAL_CAPTURE_REQUESTED: "true" },
          timeout: 20_000,
        },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/1 skipped/);
      expect(visualEvidenceContractSource).toContain(
        'it.skipIf(process.env.VISUAL_CAPTURE_REQUESTED === "true")(',
      );
    },
    25_000,
  );
});

describe("Quality workflow deployment artifacts", () => {
  it("runs production coverage through the serial database-backed migration contracts", () => {
    expect(productionCoverageConfig).toContain(
      '"server-only": fileURLToPath(new URL("./tests/stubs/server-only.ts", import.meta.url))',
    );
    expect(productionCoverageConfig).toMatch(/fileParallelism:\s*false/);
    expect(productionCoverageConfig).toMatch(/testTimeout:\s*15_000/);
    expect(productionCoverageConfig).toMatch(/hookTimeout:\s*30_000/);
    expect(productionCoverageConfig).toMatch(
      /exclude:\s*\[\s*"src\/\*\*\/\*\.test\.\{ts,tsx\}",\s*"src\/\*\*\/\*\.d\.ts"\s*\]/,
    );
    expect(productionCoverageConfig).toMatch(
      /thresholds:\s*\{\s*lines:\s*62,\s*functions:\s*69,\s*branches:\s*58,\s*statements:\s*62,?\s*\}/,
    );
    for (const suite of productionMigrationSuites) {
      expect(productionCoverageConfig).toContain(`"${suite}"`);
    }
  });

  it("rejects unsafe database targets before either job can touch PostgreSQL", () => {
    const checksJob = workflowJob("checks");
    const smokeJob = workflowJob("runtime-smoke");

    for (const [job, firstDatabaseStep] of [
      [checksJob, "Bootstrap isolated migration database"],
      [smokeJob, "Bootstrap runtime migration database"],
    ] as const) {
      const preflightStep = jobStep(job, "Preflight exact migration database targets");
      const preflightIndex = job.indexOf("- name: Preflight exact migration database targets");

      expect(preflightStep).toContain(
        `const expectedDatabaseUrl = '${migrationDatabaseUrl}'`,
      );
      expect(preflightStep).toContain("['DATABASE_URL', 'TEST_DATABASE_URL']");
      expect(preflightStep).toContain("new URL(raw)");
      expect(preflightStep).toContain("raw !== expectedDatabaseUrl");
      expect(preflightStep).toContain("target.protocol !== 'postgresql:'");
      expect(preflightStep).toContain("target.hostname !== '127.0.0.1'");
      expect(preflightStep).toContain("target.port !== '5432'");
      expect(preflightStep).toContain("target.pathname !== '/crm_salam_codex_migration_platform'");
      expect(preflightStep).toContain("target.username !== 'crm'");
      expect(preflightStep).toContain("target.password !== 'crm_local_only'");
      expect(preflightStep).not.toMatch(
        /\bpsql\b|\bpg_restore\b|\bpg_dump\b|\bcreatedb\b|\bdropdb\b|docker\s+exec|db:migrate/,
      );
      expect(preflightIndex).toBeGreaterThanOrEqual(0);
      expect(job.indexOf("- name: Assert runner architecture")).toBeLessThan(
        preflightIndex,
      );
      expect(preflightIndex).toBeLessThan(job.indexOf("- name: Checkout"));
      expect(preflightIndex).toBeLessThan(job.indexOf(`- name: ${firstDatabaseStep}`));
      for (const databaseOperation of [
        "CREATE ROLE crm",
        "dropdb --if-exists",
        "createdb --username=postgres",
        "psql --username=postgres",
        "pg_restore",
        "pg_dump",
        "pnpm db:migrate",
      ]) {
        const operationIndex = job.indexOf(databaseOperation);
        if (operationIndex >= 0) expect(preflightIndex).toBeLessThan(operationIndex);
      }
    }
  });

  it("bootstraps and attests both exact application URLs before migrations", () => {
    const checksJob = workflowJob("checks");
    const smokeJob = workflowJob("runtime-smoke");
    const bootstrapStep = jobStep(checksJob, "Bootstrap isolated migration database");
    const attestationStep = jobStep(checksJob, "Attest isolated migration database");
    const migrationIndex = checksJob.indexOf("- name: Apply production migrations");

    expect(checksJob).toContain(`DATABASE_URL: ${migrationDatabaseUrl}`);
    expect(checksJob).toContain(`TEST_DATABASE_URL: ${migrationDatabaseUrl}`);
    expect(smokeJob).toContain(`DATABASE_URL: ${migrationDatabaseUrl}`);
    expect(smokeJob).toContain(`TEST_DATABASE_URL: ${migrationDatabaseUrl}`);
    expect(qualityWorkflow).not.toContain("crm_salam_test_ci");

    expect(bootstrapStep).toContain("--username=postgres --dbname=postgres");
    expect(bootstrapStep).toContain(
      "CREATE ROLE crm LOGIN PASSWORD 'crm_local_only' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION",
    );
    expect(bootstrapStep).toContain(
      `createdb --username=postgres --owner=crm ${migrationDatabaseName}`,
    );
    expect(bootstrapStep).toContain(
      `dropdb --if-exists --username=postgres ${migrationDatabaseName}`,
    );
    expect(bootstrapStep.indexOf("CREATE ROLE crm")).toBeLessThan(
      bootstrapStep.indexOf(`createdb --username=postgres --owner=crm ${migrationDatabaseName}`),
    );
    expect(
      bootstrapStep.indexOf(`dropdb --if-exists --username=postgres ${migrationDatabaseName}`),
    ).toBeLessThan(
      bootstrapStep.indexOf(`createdb --username=postgres --owner=crm ${migrationDatabaseName}`),
    );

    expect(attestationStep).toMatch(
      /select current_database\(\), current_user, current_setting\('server_encoding'\)/i,
    );
    expect(attestationStep).toContain(`${migrationDatabaseName}|crm|UTF8`);
    expect(checksJob.indexOf("- name: Bootstrap isolated migration database")).toBeLessThan(
      checksJob.indexOf("- name: Attest isolated migration database"),
    );
    expect(checksJob.indexOf("- name: Attest isolated migration database")).toBeLessThan(
      migrationIndex,
    );
    expect(migrationIndex).toBeGreaterThanOrEqual(0);
  });

  it("replays migrations and byte-compares the complete timestamped ledger", () => {
    const checksJob = workflowJob("checks");
    const buildJob = workflowJob("build");
    const firstMigrationIndex = checksJob.indexOf("- name: Apply production migrations");
    const firstExactGateIndex = checksJob.indexOf(
      "- name: Verify exact migration ledger before replay",
    );
    const beforeLedgerIndex = checksJob.indexOf("- name: Capture migration ledger before replay");
    const replayIndex = checksJob.indexOf("- name: Replay production migrations");
    const replayExactGateIndex = checksJob.indexOf(
      "- name: Verify exact migration ledger after replay",
    );
    const compareIndex = checksJob.indexOf("- name: Verify replay preserved migration ledger");
    const dumpIndex = checksJob.indexOf("- name: Capture migrated database");
    const firstExactGateStep = jobStep(
      checksJob,
      "Verify exact migration ledger before replay",
    );
    const replayExactGateStep = jobStep(
      checksJob,
      "Verify exact migration ledger after replay",
    );
    const compareStep = jobStep(checksJob, "Verify replay preserved migration ledger");

    expect(qualityWorkflow.match(/pnpm db:migrate/g) ?? []).toHaveLength(2);
    expect(checksJob).toMatch(/- name: Apply production migrations\s+run: pnpm db:migrate/);
    expect(checksJob).toMatch(/- name: Replay production migrations\s+run: pnpm db:migrate/);
    for (const exactGateStep of [firstExactGateStep, replayExactGateStep]) {
      expect(exactGateStep).toContain(
        "pnpm exec tsx scripts/ci/verify-migration-ledger.ts",
      );
    }
    expect(compareStep).toMatch(
      /select filename, checksum, applied_at from schema_migrations order by filename/i,
    );
    expect(compareStep).toContain("migration-ledger-before.csv");
    expect(compareStep).toContain("migration-ledger-after.csv");
    expect(compareStep).toMatch(/cmp\s+--silent/);
    expect(firstMigrationIndex).toBeLessThan(firstExactGateIndex);
    expect(firstExactGateIndex).toBeLessThan(beforeLedgerIndex);
    expect(beforeLedgerIndex).toBeLessThan(replayIndex);
    expect(replayIndex).toBeLessThan(replayExactGateIndex);
    expect(replayExactGateIndex).toBeLessThan(compareIndex);
    expect(replayIndex).toBeLessThan(compareIndex);
    expect(compareIndex).toBeLessThan(dumpIndex);
    expect(buildJob).toContain("needs: checks");
  });

  it("binds the executable ledger gate to the frozen migration manifest", () => {
    expect(migrationLedgerGateSource).toMatch(
      /import\s*\{[\s\S]*EXPECTED_MIGRATIONS[\s\S]*assertMigrationLedgerCurrent[\s\S]*\}\s*from\s*"\.\.\/\.\.\/src\/server\/db\/migration-manifest"/,
    );
    expect(migrationLedgerGateSource).toMatch(
      /select\s+filename,\s*checksum\s+from\s+schema_migrations\s+order\s+by\s+filename/i,
    );
    expect(migrationLedgerGateSource).toContain("assertMigrationLedgerCurrent(rows)");
    expect(migrationLedgerGateSource).toContain("EXPECTED_MIGRATIONS.length");
  });

  it("uses the application identity for migration, tests, dump, restore, and runtime smoke", () => {
    const checksJob = workflowJob("checks");
    const smokeJob = workflowJob("runtime-smoke");
    const migrationStep = jobStep(checksJob, "Apply production migrations");
    const replayStep = jobStep(checksJob, "Replay production migrations");
    const captureStep = jobStep(checksJob, "Capture migrated database");
    const coverageStep = jobStep(checksJob, "Run production migration coverage");
    const invariantStep = jobStep(checksJob, "Verify database invariants");
    const runtimeBootstrapStep = jobStep(smokeJob, "Bootstrap runtime migration database");
    const restoreStep = jobStep(smokeJob, "Restore migrated database");
    const restoreProofStep = jobStep(smokeJob, "Verify restored migration database");

    for (const step of [migrationStep, replayStep, captureStep, coverageStep, invariantStep]) {
      expect(step).not.toContain("--username=postgres");
    }
    expect(captureStep).toMatch(/pg_dump[\s\S]*"\$DATABASE_URL"/);
    expect(restoreStep).toMatch(/pg_restore[\s\S]*--dbname="\$DATABASE_URL"/);
    expect(restoreStep).not.toContain("--username=postgres");
    expect(restoreProofStep).toContain("migration-ledger-before.csv");
    expect(restoreProofStep).toContain("migration-ledger-restored.csv");
    expect(restoreProofStep).toMatch(/cmp\s+--silent/);
    expect(runtimeBootstrapStep).toContain(
      "CREATE ROLE crm LOGIN PASSWORD 'crm_local_only' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION",
    );
    expect(runtimeBootstrapStep).toContain(
      `dropdb --if-exists --username=postgres ${migrationDatabaseName}`,
    );
    expect(runtimeBootstrapStep).toContain(
      `createdb --username=postgres --owner=crm ${migrationDatabaseName}`,
    );
    expect(
      runtimeBootstrapStep.indexOf(`dropdb --if-exists --username=postgres ${migrationDatabaseName}`),
    ).toBeLessThan(
      runtimeBootstrapStep.indexOf(`createdb --username=postgres --owner=crm ${migrationDatabaseName}`),
    );
    expect(smokeJob).toContain(`DATABASE_URL: ${migrationDatabaseUrl}`);
  });

  it("creates and proves the restored dump before production runtime smoke", () => {
    const checksJob = workflowJob("checks");
    const smokeJob = workflowJob("runtime-smoke");
    const dumpIndex = checksJob.indexOf("- name: Capture migrated database");
    const uploadIndex = checksJob.indexOf("- name: Upload migrated database");
    const coverageIndex = checksJob.indexOf("- name: Run production migration coverage");
    const restoreIndex = smokeJob.indexOf("- name: Restore migrated database");
    const proofIndex = smokeJob.indexOf("- name: Verify restored migration database");
    const runtimeIndex = smokeJob.indexOf("- name: Smoke production runtime and security headers");

    expect(dumpIndex).toBeGreaterThanOrEqual(0);
    expect(uploadIndex).toBeGreaterThan(dumpIndex);
    // Preserve the reviewed migrated snapshot before destructive database-backed coverage.
    expect(coverageIndex).toBeGreaterThan(uploadIndex);
    expect(restoreIndex).toBeGreaterThanOrEqual(0);
    expect(proofIndex).toBeGreaterThan(restoreIndex);
    expect(runtimeIndex).toBeGreaterThan(proofIndex);
  });

  it("builds immutable CRM and Tasha artifacts from the same commit", () => {
    const buildJob = workflowJob("build");

    expectSurfaceBindings(buildJob);
    expect(buildJob).toContain('PRODUCT_SURFACE: ${{ matrix.surface }}');
    expect(buildJob).toContain('APP_VERSION: ${{ github.sha }}');
    expect(buildJob).not.toMatch(
      /DEPLOYMENT_ENVIRONMENT|APP_URL|AUTH_HASH_KEY|OIDC_ISSUER|OIDC_CLIENT_ID|OIDC_CLIENT_SECRET|OIDC_REDIRECT_URI|CRM_DEMO_MODE/,
    );
    expect(buildJob).toContain("run: pnpm build");
    expect(buildJob).toContain("actions/upload-artifact@");
    expect(buildJob).toContain('production-${{ matrix.surface }}-${{ github.sha }}');

    const checkout = jobStep(buildJob, "Checkout");
    expect(checkout).toContain("persist-credentials: false");
    expect(checkout).toContain('ref: ${{ github.sha }}');
  });

  it("keeps database ownership out of workflow-global and build-job scopes", () => {
    const buildJob = workflowJob("build");

    expectDatabaseFreeRootScope(qualityWorkflow);
    expect(buildJob).not.toMatch(
      /DATABASE_URL|TEST_DATABASE_URL|\bservices:|postgres:|db:migrate|test:db/,
    );
  });

  it("smokes both immutable surface artifacts without rebuilding or migrating", () => {
    const buildJob = workflowJob("build");
    const smokeJob = workflowJob("runtime-smoke");
    const buildBindings = expectSurfaceBindings(buildJob);
    const smokeBindings = expectSurfaceBindings(smokeJob);

    expect(smokeJob).toContain("needs: [checks, build]");
    expect(smokeBindings).toEqual(buildBindings);
    expect(smokeJob).toContain('PRODUCT_SURFACE: ${{ matrix.surface }}');
    expect(smokeJob).toContain("NODE_ENV: production");
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
    expect(smokeStep).toContain(
      'node "$GITHUB_WORKSPACE/scripts/ci/run-next-runtime-smoke.mjs"',
    );
    expect(smokeStep.indexOf("cd ")).toBeLessThan(smokeStep.indexOf("node "));
    expect(smokeStep).not.toMatch(/\bsetsid\b|pnpm\s+--dir[^\n]*test:runtime/);
  });

  it("publishes one terminal verify result that depends on every quality gate", () => {
    const verifyJob = workflowJob("verify");

    expect(verifyJob).toContain(
      "needs: [checks, build, runtime-smoke, image-build, image-evidence, image-manifest, image-runtime-smoke, image-attestation]",
    );
    expect(verifyJob).toContain("if: always()");
    expect(verifyJob).toContain('CHECKS_RESULT: ${{ needs.checks.result }}');
    expect(verifyJob).toContain('BUILD_RESULT: ${{ needs.build.result }}');
    expect(verifyJob).toContain(
      'RUNTIME_SMOKE_RESULT: ${{ needs.runtime-smoke.result }}',
    );
    expect(verifyJob).toContain(
      'IMAGE_BUILD_RESULT: ${{ needs.image-build.result }}',
    );
    expect(verifyJob).toContain(
      'IMAGE_EVIDENCE_RESULT: ${{ needs.image-evidence.result }}',
    );
    expect(verifyJob).toContain(
      'IMAGE_MANIFEST_RESULT: ${{ needs.image-manifest.result }}',
    );
    expect(verifyJob).toContain(
      'IMAGE_RUNTIME_SMOKE_RESULT: ${{ needs.image-runtime-smoke.result }}',
    );
    expect(verifyJob).toContain(
      'IMAGE_ATTESTATION_RESULT: ${{ needs.image-attestation.result }}',
    );
    expect(verifyJob).toContain('test "$CHECKS_RESULT" = "success"');
    expect(verifyJob).toContain('test "$BUILD_RESULT" = "success"');
    expect(verifyJob).toContain('test "$RUNTIME_SMOKE_RESULT" = "success"');
    expect(verifyJob).toContain('test "$IMAGE_BUILD_RESULT" = "success"');
    expect(verifyJob).toContain('test "$IMAGE_EVIDENCE_RESULT" = "success"');
    expect(verifyJob).toContain('test "$IMAGE_MANIFEST_RESULT" = "success"');
    expect(verifyJob).toContain(
      'test "$IMAGE_RUNTIME_SMOKE_RESULT" = "success"',
    );
  });
});

describe("Release image workflow DAG", () => {
  it("parses the workflow with unique keys and no aliases, anchors, merges, or tags", () => {
    expect(Object.keys(strictWorkflow.jobs)).toEqual([
      "checks",
      "build",
      "runtime-smoke",
      "image-build",
      "image-evidence",
      "image-manifest",
      "image-runtime-smoke",
      "image-attestation",
      "verify",
    ]);
  });

  it("pins every job to the reviewed x64 runner contract", () => {
    for (const [name, job] of Object.entries(strictWorkflow.jobs)) {
      expect(job["runs-on"], `${name} must pin the reviewed runner`).toBe(reviewedRunner);
      expect(strictSteps(job)[0]).toMatchObject({
        name: "Assert runner architecture",
        run: 'test "$RUNNER_ARCH" = "X64"',
      });
    }
  });

  it("allows only the exact reviewed action repositories and commits globally", () => {
    const actions = Object.values(strictWorkflow.jobs).flatMap((job) =>
      strictSteps(job)
        .map((step) => step.uses)
        .filter((value): value is string => typeof value === "string"),
    );
    expect([...new Set(actions)].sort()).toEqual([...reviewedActionPins].sort());
    for (const action of actions) {
      expect(reviewedActionPins.has(action), `unreviewed action ${action}`).toBe(true);
    }
  });

  it("pins the patched Node 22 runtime in every workflow job that installs Node", () => {
    const setupSteps = Object.values(strictWorkflow.jobs).flatMap((job) =>
      strictSteps(job).filter(
        (step) =>
          typeof step.uses === "string" && step.uses.startsWith("actions/setup-node@"),
      ),
    );
    expect(setupSteps).toHaveLength(7);
    for (const step of setupSteps) {
      if (!isPlainRecord(step.with)) throw new Error("setup-node must define with.");
      expect(step.with["node-version"]).toBe("22.23.1");
    }
  });

  it.each([
    ["duplicate key", "jobs:\n  checks: {}\n  checks: {}\n"],
    ["alias", "jobs:\n  checks: &shared {}\n  build: *shared\n"],
    ["merge", "jobs:\n  checks: &shared {}\n  build:\n    <<: *shared\n"],
    ["custom tag", "jobs:\n  checks: !unsafe {}\n"],
  ])("rejects a %s mutation before evaluating workflow contracts", (_label, source) => {
    expect(() => parseStrictWorkflow(source)).toThrow();
  });

  it("builds exact CRM and Tasha OCI outputs from the triggering SHA", () => {
    const job = strictJob("image-build");
    expect(strictNeeds(job)).toEqual(["checks"]);
    expect(strictReleaseSurfaces(job)).toEqual(["crm", "tasha"]);
    expectPinnedActions(job);
    expectExactCheckout(job);

    const build = strictStep(job, "Build and export exact release image");
    expect(build.run).toMatch(/docker\s+buildx\s+build/);
    expect(build.run).toContain('--target "release-${{ matrix.surface }}"');
    expect(build.run).toContain('--build-arg "SOURCE_REVISION=${{ github.sha }}"');
    expect(build.run).toContain('--build-arg "APP_VERSION=${{ github.sha }}"');
    expect(build.run).toContain(
      '--secret "id=release_image_canary,env=RELEASE_IMAGE_CANARY"',
    );
    expect(build.run).toContain("type=oci");
    expect(build.run).not.toMatch(/(?:latest|:main|:master|\$\{\{\s*github\.ref)/);

    const upload = strictStep(job, "Upload exact release image");
    expect(upload.uses).toMatch(/^actions\/upload-artifact@[a-f0-9]{40}$/);
    expect(upload.with).toMatchObject({
      name: "release-image-${{ matrix.surface }}-${{ github.sha }}",
      "if-no-files-found": "error",
      "retention-days": 1,
      overwrite: false,
    });
  });

  it("verifies checksum-locked release tool bytes before extracting or executing them", () => {
    const buildJob = strictJob("image-build");
    const evidenceJob = strictJob("image-evidence");
    const runtimeJob = strictJob("image-runtime-smoke");

    for (const [job, stepName, tool] of [
      [buildJob, "Install checksum-locked Buildx", "buildx"],
      [evidenceJob, "Install checksum-locked Syft", "syft"],
      [evidenceJob, "Install checksum-locked Trivy", "trivy"],
      [runtimeJob, "Install checksum-locked OCI-capable Docker", "docker"],
    ] as const) {
      const install = strictStep(job, stepName);
      const source = String(install.run ?? "");
      expect(source).toContain("security/release-tool-lock.json");
      expect(source).toContain("scripts/ci/assert-release-tool.mjs");
      expect(source).toContain(`--tool ${tool}`);
      expect(source).toContain("curl --fail --silent --show-error --location");
      expect(source).toContain("--proto '=https'");
      expect(source.indexOf("assert-release-tool.mjs")).toBeLessThan(
        Math.max(source.indexOf("tar -x"), source.indexOf("chmod")),
      );
    }

    const allUses = [buildJob, evidenceJob, runtimeJob]
      .flatMap((job) => strictSteps(job))
      .map((step) => String(step.uses ?? ""));
    expect(allUses).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^docker\/setup-buildx-action@/),
        expect.stringMatching(/^anchore\/sbom-action\/download-syft@/),
        expect.stringMatching(/^aquasecurity\/setup-trivy@/),
        expect.stringMatching(/^docker\/setup-docker-action@/),
      ]),
    );
  });

  it("generates both SBOMs and a fail-closed scan from the downloaded image", () => {
    const job = strictJob("image-evidence");
    expect(strictNeeds(job)).toEqual(["image-build"]);
    expect(strictReleaseSurfaces(job)).toEqual(["crm", "tasha"]);
    expectPinnedActions(job);
    expectExactCheckout(job);

    const download = strictStep(job, "Download exact release image");
    expect(download.with).toMatchObject({
      name: "release-image-${{ matrix.surface }}-${{ github.sha }}",
    });
    const canary = strictStep(job, "Prove exact Trivy secret scanner");
    expect(canary.run).toContain("--scanners secret");
    expect(canary.run).toContain("--secret-config");
    expect(canary.run).toContain("release-secret-scanner-canary");
    expect(canary.run).toContain("Secrets");
    expect(canary.run).toContain("trap 'rm -rf");
    expect(canary.run).not.toMatch(/[a-f0-9]{64}/);

    const scan = strictStep(job, "Scan exact image for vulnerabilities and secrets");
    const scanSource = String(scan.run ?? "");
    expect(scanSource).toContain("--scanners secret");
    expect(scanSource).toContain("--image-config-scanners secret");
    expect(scanSource).toContain(
      'oci_layout="$(mktemp -d "$RUNNER_TEMP/release-oci-layout.XXXXXX")"',
    );
    expect(scanSource).toContain(
      'verified_dir="$(mktemp -d "$RUNNER_TEMP/release-image-verify.XXXXXX")"',
    );
    expect(scanSource).toContain("umask 077");
    expect(scanSource).toContain(
      'trap \'rm -rf "$verified_dir" "$oci_layout"\' EXIT',
    );
    expect(scanSource).toContain("scripts/ci/assert-release-image.mjs");
    expect(scanSource).toContain('--canary "release-image-canary-${{ github.sha }}"');
    expect(scanSource).toContain('--output "$verified_dir/image-metadata.json"');
    expect(scanSource).toContain("cmp --silent");
    expect(scanSource).toContain('"$release_dir/image-metadata.json"');
    expect(scanSource).toContain('"$verified_dir/image-metadata.json"');
    expect(scanSource).toContain("unset TAR_OPTIONS");
    expect(scanSource).toContain("tar --extract");
    expect(scanSource).toContain('--file "$release_dir/image.oci.tar"');
    expect(scanSource).toContain('--directory "$oci_layout"');
    expect(scanSource).toContain("--no-same-owner");
    expect(scanSource).toContain("--no-same-permissions");
    expect(scanSource).toContain("--keep-old-files");
    expect(scanSource).toContain("--no-overwrite-dir");
    expect(scanSource).toContain("value.imageManifestDigest");
    expect(scanSource).toContain('oci_input="$oci_layout@$image_manifest_digest"');
    expect(scanSource.match(/--input "\$oci_input"/g)).toHaveLength(2);
    expect(scanSource.match(/--platform linux\/amd64/g)).toHaveLength(2);
    expect(scanSource).not.toContain('--input "$release_dir/image.oci.tar"');
    const validationIndex = scanSource.indexOf("scripts/ci/assert-release-image.mjs");
    const metadataCompareIndex = scanSource.indexOf("cmp --silent");
    const manifestSelectionIndex = scanSource.indexOf("value.imageManifestDigest");
    const extractionIndex = scanSource.indexOf("tar --extract");
    const firstTrivyIndex = scanSource.indexOf("trivy --cache-dir", extractionIndex);
    const secondTrivyIndex = scanSource.indexOf("trivy --cache-dir", firstTrivyIndex + 1);
    const releaseAssertionIndex = scanSource.indexOf("scripts/ci/assert-release-scan.mjs");
    expect(validationIndex).toBeGreaterThanOrEqual(0);
    expect(metadataCompareIndex).toBeGreaterThan(validationIndex);
    expect(manifestSelectionIndex).toBeGreaterThan(metadataCompareIndex);
    expect(extractionIndex).toBeGreaterThan(manifestSelectionIndex);
    expect(firstTrivyIndex).toBeGreaterThan(extractionIndex);
    expect(secondTrivyIndex).toBeGreaterThan(firstTrivyIndex);
    expect(releaseAssertionIndex).toBeGreaterThan(secondTrivyIndex);
    const versionCaptureIndex = String(scan.run).indexOf(
      '> "$release_dir/trivy-version.json"',
    );
    const evaluationCaptureIndex = String(scan.run).indexOf("EVALUATION_TIME=");
    const assertionIndex = String(scan.run).indexOf("scripts/ci/assert-release-scan.mjs");
    expect(versionCaptureIndex).toBeGreaterThanOrEqual(0);
    expect(evaluationCaptureIndex).toBeGreaterThan(versionCaptureIndex);
    expect(assertionIndex).toBeGreaterThan(evaluationCaptureIndex);

    const source = strictSteps(job).map((step) => String(step.run ?? "")).join("\n");
    expect(source).toContain("sbom.cdx.json");
    expect(source).toContain("sbom.spdx.json");
    expect(source).toContain("scan-report.json");
    expect(source).toContain("--scanners vuln");
    expect(source).toContain("--scanners secret");
    expect(source).toContain("--trivy-secret-report");
    expect(source).toContain('--sbom-binding "$release_dir/sbom-binding.json"');
    expect(source).not.toContain("--scanners vuln,secret");
    expect(source).toContain('--evaluation-time "$EVALUATION_TIME"');
    expect(source).toContain(
      "--db-repository ghcr.io/aquasecurity/trivy-db:2",
    );
    expect(source).not.toMatch(/docker\s+(?:build|buildx)|build-push-action/);

    const upload = strictStep(job, "Upload release evidence");
    expect(upload.with).toMatchObject({
      name: "release-evidence-${{ matrix.surface }}-${{ github.sha }}",
      "if-no-files-found": "error",
      "retention-days": 1,
      overwrite: false,
    });
    expect(upload.with).toHaveProperty(
      "path",
      expect.stringMatching(
        /sbom\.cdx\.json[\s\S]*sbom\.spdx\.json[\s\S]*sbom-binding\.json[\s\S]*trivy-raw\.json[\s\S]*trivy-secret-raw\.json[\s\S]*trivy-version\.json[\s\S]*scan-report\.json/,
      ),
    );
  });

  it("writes the manifest only after downloading the exact image, ledger and evidence", () => {
    const job = strictJob("image-manifest");
    expect(strictNeeds(job)).toEqual(["checks", "image-build", "image-evidence"]);
    expect(strictReleaseSurfaces(job)).toEqual(["crm", "tasha"]);
    expectPinnedActions(job);
    expectExactCheckout(job);

    expect(strictStep(job, "Download exact release image").with).toMatchObject({
      name: "release-image-${{ matrix.surface }}-${{ github.sha }}",
    });
    expect(strictStep(job, "Download release evidence").with).toMatchObject({
      name: "release-evidence-${{ matrix.surface }}-${{ github.sha }}",
    });
    expect(strictStep(job, "Download exact migration ledger").with).toMatchObject({
      name: "migrated-db-${{ github.sha }}",
    });
    const write = strictStep(job, "Write bound release manifest");
    expect(write.run).toContain("scripts/ci/write-release-manifest.mjs");
    expect(write.run).toContain('--source-sha "${{ github.sha }}"');
    expect(write.run).toContain('--surface "${{ matrix.surface }}"');
    expect(String(write.run)).not.toMatch(/docker\s+(?:build|buildx)|build-push-action/);

    const upload = strictStep(job, "Upload bound release manifest");
    expect(upload.with).toMatchObject({
      name: "release-manifest-${{ matrix.surface }}-${{ github.sha }}",
      "if-no-files-found": "error",
      "retention-days": 1,
      overwrite: false,
    });
  });

  it("smokes only the exact downloaded image and its bound evidence", () => {
    const job = strictJob("image-runtime-smoke");
    expect(strictNeeds(job)).toEqual([
      "checks",
      "image-build",
      "image-evidence",
      "image-manifest",
    ]);
    expect(strictReleaseSurfaces(job)).toEqual(["crm", "tasha"]);
    expectPinnedActions(job);
    expectExactCheckout(job);

    const setupDocker = strictStep(job, "Install checksum-locked OCI-capable Docker");
    expect(setupDocker.run).toContain('"containerd-snapshotter": true');
    expect(setupDocker.run).toContain("dockerd");
    expect(strictStep(job, "Verify OCI image store").run).toMatch(
      /io\.containerd\.snapshotter\.v1/,
    );
    expect(strictStep(job, "Stop exact OCI-capable Docker").if).toBe("always()");

    const install = strictStep(job, "Install probe dependencies");
    expect(install.run).toBe("pnpm install --frozen-lockfile");
    expect(install.run).not.toContain("--prod");

    for (const [stepName, artifactName] of [
      ["Download exact release image", "release-image"],
      ["Download release evidence", "release-evidence"],
      ["Download bound release manifest", "release-manifest"],
      ["Download exact migration ledger", "migrated-db"],
    ] as const) {
      const step = strictStep(job, stepName);
      const suffix = artifactName === "migrated-db" ? "" : "-${{ matrix.surface }}";
      expect(step.with).toMatchObject({
        name: `${artifactName}${suffix}-\${{ github.sha }}`,
      });
    }
    const source = strictSteps(job).map((step) => String(step.run ?? "")).join("\n");
    expect(source).toContain("scripts/ci/run-release-image-smoke.mjs");
    expect(source).not.toMatch(
      /docker\s+(?:build|buildx)|build-push-action|docker\s+pull|(?:latest|:main|:master)/,
    );
  });

  it("attests the tested release bundle only on trusted main pushes", () => {
    const job = strictJob("image-attestation");
    expect(job.if).toBe(
      "github.event_name == 'push' && github.ref == 'refs/heads/main' && github.repository == 'AqmalJupri/crmsalessalamland'",
    );
    expect(job.permissions).toEqual({
      contents: "read",
      "id-token": "write",
      attestations: "write",
    });
    expect(strictNeeds(job)).toEqual([
      "image-build",
      "image-evidence",
      "image-manifest",
      "image-runtime-smoke",
    ]);
    expect(strictReleaseSurfaces(job)).toEqual(["crm", "tasha"]);
    expectPinnedActions(job);

    const attest = strictStep(job, "Attest exact release bundle");
    expect(attest.uses).toBe(
      "actions/attest@a1948c3f048ba23858d222213b7c278aabede763",
    );
    expect(attest.with).toHaveProperty(
      "subject-path",
      expect.stringMatching(
        /image\.oci\.tar[\s\S]*release-manifest\.json[\s\S]*sbom\.cdx\.json[\s\S]*sbom\.spdx\.json[\s\S]*sbom-binding\.json[\s\S]*scan-report\.json/,
      ),
    );
  });

  it("keeps both legacy gates and every release-image gate in terminal verification", () => {
    const verify = strictJob("verify");
    expect(strictNeeds(verify)).toEqual([
      "checks",
      "build",
      "runtime-smoke",
      "image-build",
      "image-evidence",
      "image-manifest",
      "image-runtime-smoke",
      "image-attestation",
    ]);
    const step = strictStep(verify, "Enforce successful quality gates");
    expect(step.env).toMatchObject({
      IMAGE_BUILD_RESULT: "${{ needs.image-build.result }}",
      IMAGE_EVIDENCE_RESULT: "${{ needs.image-evidence.result }}",
      IMAGE_MANIFEST_RESULT: "${{ needs.image-manifest.result }}",
      IMAGE_RUNTIME_SMOKE_RESULT: "${{ needs.image-runtime-smoke.result }}",
      IMAGE_ATTESTATION_RESULT: "${{ needs.image-attestation.result }}",
      EVENT_NAME: "${{ github.event_name }}",
      REF: "${{ github.ref }}",
      REPOSITORY: "${{ github.repository }}",
    });
    expect(step.run).toMatch(/test "\$IMAGE_BUILD_RESULT" = "success"/);
    expect(step.run).toMatch(/test "\$IMAGE_EVIDENCE_RESULT" = "success"/);
    expect(step.run).toMatch(/test "\$IMAGE_MANIFEST_RESULT" = "success"/);
    expect(step.run).toMatch(/test "\$IMAGE_RUNTIME_SMOKE_RESULT" = "success"/);
    expect(step.run).toContain('test "$IMAGE_ATTESTATION_RESULT" = "success"');
    expect(step.run).toContain('test "$IMAGE_ATTESTATION_RESULT" = "skipped"');
  });
});

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { PlaywrightTestConfig } from "@playwright/test";
import { afterEach, describe, expect, it, vi } from "vitest";

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
      expect(preflightIndex).toBe(job.indexOf("- name:"));
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

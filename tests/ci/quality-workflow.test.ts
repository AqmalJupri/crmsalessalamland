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

const expectedSurfaceBindings = [
  {
    surface: "crm",
    app_url: "https://crm-ci.example.test",
    oidc_client_id: "crm-ci",
  },
  {
    surface: "tasha",
    app_url: "https://tasha-ci.example.test",
    oidc_client_id: "tasha-ci",
  },
];

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

    expectSurfaceBindings(buildJob);
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

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const scannerPath = `${repositoryRoot}scripts/ci/assert-release-scan.mjs`;
const reviewedPolicyPath = `${repositoryRoot}security/container-vulnerability-allowlist.json`;
const sourceSha = "1".repeat(40);
const evaluationTime = "2026-07-19T00:02:00.000Z";
const imageManifestDigest = `sha256:${"2".repeat(64)}`;
const imageConfigDigest = `sha256:${"3".repeat(64)}`;
const baseImageDigest = `sha256:${"4".repeat(64)}`;
const baseImagePlatformDigest = `sha256:${"5".repeat(64)}`;
const imageArtifactSource = "synthetic-oci-image-archive\n";
const cyclonedxSource = canonicalJson(cyclonedxSbom());
const spdxSource = canonicalJson(spdxSbom());
const vulnerabilityDatabaseSource = "synthetic-trivy-database\n";
const measuredTrivyDatabaseBytes = 1_188_278_272;
const maximumTrivyDatabaseBytes = 2 * 1024 * 1024 * 1024;
const temporaryDirectories: string[] = [];

const emptyPolicy = Object.freeze({
  schemaVersion: 1,
  version: "2026-07-18",
  exceptions: [] as unknown[],
});

type JsonRecord = Record<string, unknown>;

interface RunMutation {
  policy?: unknown;
  policySource?: string;
  report?: unknown;
  reportSource?: string;
  secretReport?: unknown;
  secretReportSource?: string;
  trivyVersion?: unknown;
  trivyVersionSource?: string;
  cyclonedx?: unknown;
  spdx?: unknown;
  outputSource?: string;
  bindingOutputSource?: string;
  databaseSize?: number;
  arguments?: string[];
  trustedNow?: string;
  timeout?: number;
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(source: string): string {
  return `sha256:${createHash("sha256").update(source).digest("hex")}`;
}

function cyclonedxSbom(overrides: JsonRecord = {}): JsonRecord {
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    metadata: {
      timestamp: "2026-07-19T00:00:00Z",
      tools: {
        components: [
          { type: "application", author: "anchore", name: "syft", version: "1.48.0" },
        ],
      },
      component: { type: "container", name: "crm", version: sourceSha },
    },
    components: [{ type: "library", name: "next", version: "16.2.10" }],
    ...overrides,
  };
}

function spdxSbom(overrides: JsonRecord = {}): JsonRecord {
  return {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: "crm",
    documentNamespace: "https://anchore.com/syft/image/crm-fixture",
    creationInfo: {
      creators: ["Organization: Anchore, Inc", "Tool: syft-1.48.0"],
      created: "2026-07-19T00:00:00Z",
    },
    packages: [
      {
        name: "next",
        SPDXID: "SPDXRef-Package-next",
        versionInfo: "16.2.10",
        downloadLocation: "NOASSERTION",
        filesAnalyzed: false,
        licenseConcluded: "NOASSERTION",
        licenseDeclared: "NOASSERTION",
        copyrightText: "NOASSERTION",
      },
      {
        name: "crm",
        SPDXID: "SPDXRef-DocumentRoot-Image-crm",
        versionInfo: sourceSha,
        downloadLocation: "NOASSERTION",
        filesAnalyzed: false,
        checksums: [
          {
            algorithm: "SHA256",
            checksumValue: imageManifestDigest.slice("sha256:".length),
          },
        ],
        licenseConcluded: "NOASSERTION",
        licenseDeclared: "NOASSERTION",
        copyrightText: "NOASSERTION",
        externalRefs: [
          {
            referenceCategory: "PACKAGE-MANAGER",
            referenceType: "purl",
            referenceLocator: `pkg:oci/crm@${encodeURIComponent(imageManifestDigest)}?arch=amd64`,
          },
        ],
        primaryPackagePurpose: "CONTAINER",
      },
    ],
    relationships: [
      {
        spdxElementId: "SPDXRef-DOCUMENT",
        relatedSpdxElement: "SPDXRef-DocumentRoot-Image-crm",
        relationshipType: "DESCRIBES",
      },
    ],
    ...overrides,
  };
}

function vulnerability(overrides: JsonRecord = {}): JsonRecord {
  return {
    VulnerabilityID: "CVE-2026-12345",
    PkgName: "openssl",
    InstalledVersion: "3.0.17-1~deb12u3",
    Severity: "HIGH",
    Fingerprint: `sha256:${"9".repeat(64)}`,
    ...overrides,
  };
}

function trivyReport(results: unknown[] = [vulnerabilityResult([])]): JsonRecord {
  return {
    SchemaVersion: 2,
    Trivy: { Version: "0.72.0" },
    ReportID: "00000000-0000-4000-8000-000000000001",
    CreatedAt: "2026-07-19T00:00:00.000Z",
    ArtifactID: `sha256:${"8".repeat(64)}`,
    ArtifactName: "image.oci.tar",
    ArtifactType: "container_image",
    Metadata: {
      ImageID: imageConfigDigest,
      RepoDigests: [`crm-ci@${imageManifestDigest}`],
    },
    Results: results,
  };
}

function vulnerabilityResult(findings: unknown[]): JsonRecord {
  return {
    Target: "crm-ci",
    Class: "os-pkgs",
    Type: "debian",
    Packages: [{ ID: "openssl@3.0.17-1~deb12u3" }],
    Vulnerabilities: findings,
    ExperimentalModifiedFindings: [],
  };
}

function trivySecretReport(results?: unknown[]): JsonRecord {
  const report = trivyReport(results ?? []);
  if (results === undefined) delete report.Results;
  return report;
}

function trivyVersion(overrides: JsonRecord = {}): JsonRecord {
  return {
    Version: "0.72.0",
    VulnerabilityDB: {
      Version: 2,
      UpdatedAt: "2026-07-19T00:00:00.123456789Z",
      NextUpdate: "2026-07-20T00:00:00.000Z",
      DownloadedAt: "2026-07-19T00:01:00.000Z",
      ...overrides,
    },
    CheckBundle: {
      Digest: `sha256:${"7".repeat(64)}`,
      DownloadedAt: "2026-07-19T00:01:00.000Z",
    },
  };
}

function exception(overrides: JsonRecord = {}): JsonRecord {
  return {
    id: "SEC-2026-001",
    vulnerabilityId: "CVE-2026-12345",
    packageName: "openssl",
    installedVersion: "3.0.17-1~deb12u3",
    severity: "HIGH",
    owner: "platform-security",
    rationale: "Temporary exception while the fixed Debian package is prepared.",
    expiresOn: "2026-08-31",
    ...overrides,
  };
}

function makeArguments(directory: string, outputPath: string): string[] {
  return [
    "--trivy-report",
    join(directory, "trivy.json"),
    "--trivy-secret-report",
    join(directory, "trivy-secret.json"),
    "--trivy-version",
    join(directory, "trivy-version.json"),
    "--trivy-database",
    join(directory, "trivy.db"),
    "--policy",
    join(directory, "policy.json"),
    "--image-metadata",
    join(directory, "image-metadata.json"),
    "--cyclonedx",
    join(directory, "sbom.cdx.json"),
    "--spdx",
    join(directory, "sbom.spdx.json"),
    "--sbom-binding",
    join(directory, "sbom-binding.json"),
    "--surface",
    "crm",
    "--source-sha",
    sourceSha,
    "--evaluation-time",
    evaluationTime,
    "--output",
    outputPath,
  ];
}

function runScanner(mutation: RunMutation = {}) {
  const directory = mkdtempSync(join(tmpdir(), "crm-release-scan-"));
  temporaryDirectories.push(directory);
  const policyPath = join(directory, "policy.json");
  const reportPath = join(directory, "trivy.json");
  const outputPath = join(directory, "scan-report.json");
  const bindingPath = join(directory, "sbom-binding.json");
  const policySource = mutation.policySource ?? canonicalJson(mutation.policy ?? emptyPolicy);
  const reportSource = mutation.reportSource ?? canonicalJson(mutation.report ?? trivyReport());
  writeFileSync(policyPath, policySource, { encoding: "utf8", flag: "wx" });
  writeFileSync(reportPath, reportSource, { encoding: "utf8", flag: "wx" });
  writeFileSync(
    join(directory, "trivy-secret.json"),
    mutation.secretReportSource ?? canonicalJson(
      mutation.secretReport ?? trivySecretReport(),
    ),
    { encoding: "utf8", flag: "wx" },
  );
  writeFileSync(
    join(directory, "trivy-version.json"),
    mutation.trivyVersionSource ?? canonicalJson(mutation.trivyVersion ?? trivyVersion()),
    { encoding: "utf8", flag: "wx" },
  );
  writeFileSync(join(directory, "trivy.db"), vulnerabilityDatabaseSource, {
    encoding: "utf8",
    flag: "wx",
  });
  if (mutation.databaseSize !== undefined) {
    truncateSync(join(directory, "trivy.db"), mutation.databaseSize);
  }
  writeFileSync(
    join(directory, "image-metadata.json"),
    canonicalJson({
      schemaVersion: 1,
      sourceSha,
      surface: "crm",
      appVersion: sourceSha,
      baseImageDigest,
      baseImagePlatformDigest,
      platform: { os: "linux", architecture: "amd64" },
      imageReference: `crm-ci@${imageManifestDigest}`,
      imageManifestDigest,
      imageConfigDigest,
      imageArtifactSha256: sha256(imageArtifactSource),
    }),
    { encoding: "utf8", flag: "wx" },
  );
  const currentCyclonedxSource = canonicalJson(mutation.cyclonedx ?? cyclonedxSbom());
  const currentSpdxSource = canonicalJson(mutation.spdx ?? spdxSbom());
  writeFileSync(join(directory, "sbom.cdx.json"), currentCyclonedxSource, {
    encoding: "utf8",
    flag: "wx",
  });
  writeFileSync(join(directory, "sbom.spdx.json"), currentSpdxSource, {
    encoding: "utf8",
    flag: "wx",
  });
  if (mutation.outputSource !== undefined) {
    writeFileSync(outputPath, mutation.outputSource, { encoding: "utf8", flag: "wx" });
  }
  if (mutation.bindingOutputSource !== undefined) {
    writeFileSync(bindingPath, mutation.bindingOutputSource, {
      encoding: "utf8",
      flag: "wx",
    });
  }
  const args = makeArguments(directory, outputPath);
  const harness = `
    import { assertReleaseScan } from ${JSON.stringify(pathToFileURL(scannerPath).href)};
    try {
      await assertReleaseScan(process.argv.slice(1), {
        trustedClock: () => Date.parse(${JSON.stringify(mutation.trustedNow ?? evaluationTime)}),
      });
    } catch (error) {
      const code = error && typeof error === "object" && typeof error.code === "string"
        ? error.code
        : "RELEASE_SCAN_INTERNAL";
      process.stderr.write(code + "\\n");
      process.exitCode = 1;
    }
  `;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", harness, "--", ...(mutation.arguments ?? args)],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      timeout: mutation.timeout ?? 10_000,
      env: { ...process.env, PATH: process.env.PATH },
    },
  );
  return {
    directory,
    outputPath,
    bindingPath,
    policySource,
    cyclonedxSource: currentCyclonedxSource,
    spdxSource: currentSpdxSource,
    result,
  };
}

function expectSafeFailure(
  run: ReturnType<typeof runScanner>,
  code: string,
): void {
  expect(run.result.status).not.toBe(0);
  expect(run.result.stdout).toBe("");
  expect(run.result.stderr).toBe(`${code}\n`);
  expect(existsSync(run.outputPath)).toBe(false);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("container vulnerability allowlist", () => {
  it("is the exact canonical empty version-one policy", () => {
    expect(readFileSync(reviewedPolicyPath, "utf8")).toBe(canonicalJson(emptyPolicy));
  });
});

describe("release scan policy gate", () => {
  it(
    "accepts the measured official Trivy database within a finite production bound",
    () => {
      const run = runScanner({
        databaseSize: measuredTrivyDatabaseBytes,
        timeout: 25_000,
      });
      expect(run.result.status, run.result.stderr).toBe(0);
      expect(run.result.stdout).toBe("");
      expect(run.result.stderr).toBe("");
    },
    30_000,
  );

  it("rejects a Trivy database above the finite production bound", () => {
    const run = runScanner({ databaseSize: maximumTrivyDatabaseBytes + 1 });
    expectSafeFailure(run, "RELEASE_SCAN_INPUT_BOUNDS");
  });

  it("writes a canonical manifest-compatible pass report with exact provenance", () => {
    const run = runScanner();
    expect(run.result.status, run.result.stderr).toBe(0);
    expect(run.result.stdout).toBe("");
    expect(run.result.stderr).toBe("");
    const bindingSource = canonicalJson({
      schemaVersion: 1,
      sourceSha,
      surface: "crm",
      syft: {
        version: "1.48.0",
        command: "scan",
        source: "oci-archive:image.oci.tar",
        platform: "linux/amd64",
        sourceName: "crm",
        sourceVersion: sourceSha,
      },
      image: {
        manifestDigest: imageManifestDigest,
        configDigest: imageConfigDigest,
        artifactSha256: sha256(imageArtifactSource),
      },
      sboms: {
        cyclonedx: {
          filename: "sbom.cdx.json",
          format: "cyclonedx-json",
          specVersion: "1.6",
          sha256: sha256(cyclonedxSource),
        },
        spdx: {
          filename: "sbom.spdx.json",
          format: "spdx-json",
          specVersion: "2.3",
          sha256: sha256(spdxSource),
        },
      },
    });
    expect(readFileSync(run.bindingPath, "utf8")).toBe(bindingSource);
    expect(readFileSync(run.outputPath, "utf8")).toBe(
      canonicalJson({
        schemaVersion: 1,
        sourceSha,
        surface: "crm",
        imageManifestDigest,
        result: "pass",
        evaluatedAt: evaluationTime,
        findings: [],
        artifacts: {
          imageArtifactSha256: sha256(imageArtifactSource),
          sbomBindingSha256: sha256(bindingSource),
          cyclonedxSha256: sha256(cyclonedxSource),
          spdxSha256: sha256(spdxSource),
          trivyReportSha256: sha256(canonicalJson(trivyReport())),
          trivySecretReportSha256: sha256(canonicalJson(trivySecretReport())),
          trivyVersionSha256: sha256(canonicalJson(trivyVersion())),
        },
        scanner: { engine: "trivy", version: "0.72.0" },
        policy: { version: emptyPolicy.version, sha256: sha256(run.policySource) },
        vulnerabilityDatabase: {
          source: "ghcr.io/aquasecurity/trivy-db:2",
          version: "2",
          updatedAt: "2026-07-19T00:00:00.123Z",
          nextUpdate: "2026-07-20T00:00:00.000Z",
          downloadedAt: "2026-07-19T00:01:00.000Z",
          sha256: sha256(vulnerabilityDatabaseSource),
        },
      }),
    );
  });

  it("rejects a CycloneDX SBOM for a different source", () => {
    const run = runScanner({
      cyclonedx: cyclonedxSbom({
        metadata: {
          timestamp: "2026-07-19T00:00:00Z",
          tools: {
            components: [
              { type: "application", author: "anchore", name: "syft", version: "1.48.0" },
            ],
          },
          component: { type: "container", name: "crm", version: "8".repeat(40) },
        },
      }),
    });
    expectSafeFailure(run, "RELEASE_SCAN_SBOM_MISMATCH");
    expect(existsSync(run.bindingPath)).toBe(false);
  });

  it("rejects an SPDX SBOM for a different source", () => {
    const spdx = spdxSbom();
    const packages = spdx.packages as Array<JsonRecord>;
    packages[1] = { ...packages[1], versionInfo: "8".repeat(40) };
    const run = runScanner({ spdx });
    expectSafeFailure(run, "RELEASE_SCAN_SBOM_MISMATCH");
    expect(existsSync(run.bindingPath)).toBe(false);
  });

  it("rejects an SPDX SBOM for a different image manifest", () => {
    const spdx = spdxSbom();
    const packages = spdx.packages as Array<JsonRecord>;
    packages[1] = {
      ...packages[1],
      checksums: [{ algorithm: "SHA256", checksumValue: "9".repeat(64) }],
    };
    const run = runScanner({ spdx });
    expectSafeFailure(run, "RELEASE_SCAN_SBOM_MISMATCH");
    expect(existsSync(run.bindingPath)).toBe(false);
  });

  it("keeps only approved High/Critical findings in deterministic minimal form", () => {
    const critical = vulnerability({
      VulnerabilityID: "CVE-2026-99999",
      PkgName: "zlib1g",
      InstalledVersion: "1:1.2.13.dfsg-1",
      Severity: "CRITICAL",
      Title: "Scanner detail must not be copied",
      Description: "Potentially unbounded vendor prose",
      References: ["https://example.test/private-query"],
    });
    const high = vulnerability();
    const policy = {
      ...emptyPolicy,
      exceptions: [
        exception(),
        exception({
          id: "SEC-2026-002",
          vulnerabilityId: "CVE-2026-99999",
          packageName: "zlib1g",
          installedVersion: "1:1.2.13.dfsg-1",
          severity: "CRITICAL",
        }),
      ],
    };
    const run = runScanner({
      policy,
      report: trivyReport([vulnerabilityResult([critical, high])]),
    });

    expect(run.result.status, run.result.stderr).toBe(0);
    const report = JSON.parse(readFileSync(run.outputPath, "utf8")) as JsonRecord;
    expect(report.findings).toEqual([
      {
        vulnerabilityId: "CVE-2026-12345",
        packageName: "openssl",
        installedVersion: "3.0.17-1~deb12u3",
        severity: "HIGH",
        exceptionId: "SEC-2026-001",
        expiresOn: "2026-08-31",
      },
      {
        vulnerabilityId: "CVE-2026-99999",
        packageName: "zlib1g",
        installedVersion: "1:1.2.13.dfsg-1",
        severity: "CRITICAL",
        exceptionId: "SEC-2026-002",
        expiresOn: "2026-08-31",
      },
    ]);
    expect(readFileSync(run.outputPath, "utf8")).not.toContain("Scanner detail");
    expect(readFileSync(run.outputPath, "utf8")).not.toContain("private-query");
  });

  it("does not require exceptions for Unknown/Low/Medium findings", () => {
    const findings = [
      vulnerability({ VulnerabilityID: "TEMP-0000001", Severity: "UNKNOWN" }),
      vulnerability({ VulnerabilityID: "GHSA-abcd-efgh-ijkl", Severity: "LOW" }),
      vulnerability({ VulnerabilityID: "CVE-2026-12347", Severity: "MEDIUM" }),
    ];
    const run = runScanner({ report: trivyReport([vulnerabilityResult(findings)]) });
    expect(run.result.status, run.result.stderr).toBe(0);
    const report = JSON.parse(readFileSync(run.outputPath, "utf8")) as JsonRecord;
    expect(report.findings).toEqual([]);
  });

  it("accepts approved GHSA and TEMP advisory identifiers", () => {
    const policy = {
      ...emptyPolicy,
      exceptions: [
        exception({ vulnerabilityId: "GHSA-abcd-efgh-ijkl" }),
        exception({
          id: "SEC-2026-002",
          vulnerabilityId: "TEMP-0000001",
          packageName: "zlib1g",
          installedVersion: "1:1.2.13.dfsg-1",
          severity: "CRITICAL",
        }),
      ],
    };
    const run = runScanner({
      policy,
      report: trivyReport([
        vulnerabilityResult([
          vulnerability({ VulnerabilityID: "GHSA-abcd-efgh-ijkl" }),
          vulnerability({
            VulnerabilityID: "TEMP-0000001",
            PkgName: "zlib1g",
            InstalledVersion: "1:1.2.13.dfsg-1",
            Severity: "CRITICAL",
          }),
        ]),
      ]),
    });

    expect(run.result.status, run.result.stderr).toBe(0);
    const report = JSON.parse(readFileSync(run.outputPath, "utf8")) as JsonRecord;
    expect(report.findings).toEqual([
      {
        vulnerabilityId: "GHSA-abcd-efgh-ijkl",
        packageName: "openssl",
        installedVersion: "3.0.17-1~deb12u3",
        severity: "HIGH",
        exceptionId: "SEC-2026-001",
        expiresOn: "2026-08-31",
      },
      {
        vulnerabilityId: "TEMP-0000001",
        packageName: "zlib1g",
        installedVersion: "1:1.2.13.dfsg-1",
        severity: "CRITICAL",
        exceptionId: "SEC-2026-002",
        expiresOn: "2026-08-31",
      },
    ]);
  });

  it("rejects an empty Trivy Results array", () => {
    const run = runScanner({ report: trivyReport([]) });
    expectSafeFailure(run, "RELEASE_SCAN_REPORT_COVERAGE");
  });

  it("accepts a clean Trivy vulnerability result that omits the empty findings field", () => {
    const cleanResult = vulnerabilityResult([]);
    delete cleanResult.Vulnerabilities;
    const run = runScanner({ report: trivyReport([cleanResult]) });
    expect(run.result.status, run.result.stderr).toBe(0);
    expect(run.result.stdout).toBe("");
    expect(run.result.stderr).toBe("");
  });

  it("rejects Results without meaningful package vulnerability coverage", () => {
    const run = runScanner({
      report: trivyReport([
        {
          Target: "application licenses",
          Class: "license",
          Type: "npm",
          Packages: [{ ID: "react@19.1.0" }],
          Vulnerabilities: [],
        },
      ]),
    });
    expectSafeFailure(run, "RELEASE_SCAN_REPORT_COVERAGE");
  });

  it.each([
    ["stale UpdatedAt", { UpdatedAt: "2026-07-16T23:59:59.999Z" }],
    ["future UpdatedAt", { UpdatedAt: "2026-07-19T00:07:00.001Z" }],
    ["stale DownloadedAt", { DownloadedAt: "2026-07-17T23:59:59.999Z" }],
    ["future DownloadedAt", { DownloadedAt: "2026-07-19T00:07:00.001Z" }],
    [
      "DownloadedAt before the database publication window",
      {
        UpdatedAt: "2026-07-19T00:00:00.000Z",
        DownloadedAt: "2026-07-18T23:54:59.999Z",
      },
    ],
    ["stale NextUpdate", { NextUpdate: "2026-07-18T23:56:59.999Z" }],
    ["invalid NextUpdate order", { NextUpdate: "2026-07-18T23:59:59.000Z" }],
    ["unreasonably distant NextUpdate", { NextUpdate: "2026-07-21T00:00:00.124Z" }],
  ])("rejects a Trivy database with %s", (_label, overrides) => {
    const run = runScanner({ trivyVersion: trivyVersion(overrides) });
    expectSafeFailure(run, "RELEASE_SCAN_VULNERABILITY_DATABASE_FRESHNESS");
  });

  it("fails closed on any secret finding without leaking the secret", () => {
    const secret = "ci-canary-secret-value-must-never-appear";
    const run = runScanner({
      secretReport: trivySecretReport([
        {
          Target: "app/server.js",
          Class: "secret",
          Secrets: [
            {
              RuleID: "generic-secret",
              Category: "General",
              Severity: "HIGH",
              Title: "Generic Secret",
              StartLine: 1,
              EndLine: 1,
              Match: secret,
            },
          ],
        },
      ]),
    });
    expectSafeFailure(run, "RELEASE_SCAN_SECRET_FINDING");
    expect(run.result.stderr).not.toContain(secret);
  });

  it.each([
    ["absent Results", trivySecretReport()],
    ["an empty Results array", trivySecretReport([])],
  ])("accepts canonical clean Trivy secret output with %s", (_label, secretReport) => {
    const run = runScanner({ secretReport });
    expect(run.result.status, run.result.stderr).toBe(0);
    expect(run.result.stdout).toBe("");
    expect(run.result.stderr).toBe("");
  });

  it("rejects a vulnerability-only report passed as secret-scan evidence", () => {
    const run = runScanner({ secretReport: trivyReport() });
    expectSafeFailure(run, "RELEASE_SCAN_SECRET_COVERAGE");
  });

  it("rejects package-only results passed as clean secret-scan evidence", () => {
    const packageOnlyResult = vulnerabilityResult([]);
    delete packageOnlyResult.Vulnerabilities;
    const run = runScanner({
      secretReport: trivySecretReport([packageOnlyResult]),
    });
    expectSafeFailure(run, "RELEASE_SCAN_SECRET_COVERAGE");
  });

  it.each([
    ["stale vulnerability report", { report: trivyReport(), createdAt: "2026-07-18T22:00:00.000Z" }],
    ["future vulnerability report", { report: trivyReport(), createdAt: "2026-07-19T00:07:00.001Z" }],
    ["stale secret report", { secretReport: trivySecretReport(), createdAt: "2026-07-18T22:00:00.000Z" }],
  ])("rejects a %s", (_label, fixture) => {
    const run = "report" in fixture
      ? runScanner({
          report: { ...fixture.report, CreatedAt: fixture.createdAt },
        })
      : runScanner({
          secretReport: { ...fixture.secretReport, CreatedAt: fixture.createdAt },
        });
    expectSafeFailure(run, "RELEASE_SCAN_REPORT_FRESHNESS");
  });

  it.each(["HIGH", "CRITICAL"])(
    "fails closed on an unapproved %s vulnerability",
    (severity) => {
      const run = runScanner({
        report: trivyReport([vulnerabilityResult([vulnerability({ Severity: severity })])]),
      });
      expectSafeFailure(run, "RELEASE_SCAN_UNAPPROVED_VULNERABILITY");
    },
  );

  it("rejects unknown policy fields", () => {
    const run = runScanner({ policy: { ...emptyPolicy, environment: "production" } });
    expectSafeFailure(run, "RELEASE_SCAN_POLICY_UNKNOWN_FIELD");
  });

  it("rejects unknown exception fields", () => {
    const run = runScanner({
      policy: { ...emptyPolicy, exceptions: [{ ...exception(), ticketUrl: "private" }] },
    });
    expectSafeFailure(run, "RELEASE_SCAN_POLICY_UNKNOWN_FIELD");
  });

  it("rejects non-canonical policy bytes and key ordering", () => {
    const run = runScanner({
      policySource: JSON.stringify({
        version: emptyPolicy.version,
        schemaVersion: 1,
        exceptions: [],
      }),
    });
    expectSafeFailure(run, "RELEASE_SCAN_POLICY_CANONICAL");
  });

  it("rejects duplicate JSON object keys", () => {
    const run = runScanner({
      policySource:
        '{"schemaVersion":1,"version":"2026-07-18","version":"2026-07-18","exceptions":[]}\n',
    });
    expectSafeFailure(run, "RELEASE_SCAN_JSON_DUPLICATE_KEY");
  });

  it("rejects duplicate exception identifiers", () => {
    const run = runScanner({
      policy: {
        ...emptyPolicy,
        exceptions: [
          exception(),
          exception({ vulnerabilityId: "CVE-2026-12346" }),
        ],
      },
    });
    expectSafeFailure(run, "RELEASE_SCAN_POLICY_DUPLICATE");
  });

  it("rejects duplicate exception match tuples", () => {
    const run = runScanner({
      policy: {
        ...emptyPolicy,
        exceptions: [exception(), exception({ id: "SEC-2026-002" })],
      },
    });
    expectSafeFailure(run, "RELEASE_SCAN_POLICY_DUPLICATE");
  });

  it("rejects expired exceptions even when no current finding uses them", () => {
    const run = runScanner({
      policy: {
        ...emptyPolicy,
        exceptions: [exception({ expiresOn: "2000-01-01" })],
      },
    });
    expectSafeFailure(run, "RELEASE_SCAN_POLICY_EXPIRED");
  });

  it("rejects exceptions lasting more than 90 calendar days", () => {
    const run = runScanner({
      policy: {
        ...emptyPolicy,
        exceptions: [exception({ expiresOn: "2026-10-18" })],
      },
    });
    expectSafeFailure(run, "RELEASE_SCAN_POLICY_TTL");
  });

  it.each([
    ["severity", "MEDIUM"],
    ["packageName", "../openssl"],
    ["installedVersion", "3.0.17 customer@example.test"],
    ["vulnerabilityId", "GHSA/abcd/efgh/ijkl"],
    ["expiresOn", "19-07-2026"],
    ["owner", "x"],
    ["rationale", "short"],
  ])("rejects malformed exception %s", (field, value) => {
    const run = runScanner({
      policy: {
        ...emptyPolicy,
        exceptions: [exception({ [field]: value })],
      },
    });
    expectSafeFailure(run, "RELEASE_SCAN_POLICY_EXCEPTION");
  });

  it.each([
    ["Severity", "IMPORTANT"],
    ["PkgName", "../openssl"],
    ["InstalledVersion", "3.0.17 customer@example.test"],
    ["VulnerabilityID", "GHSA abcd efgh ijkl"],
  ])("rejects malformed Trivy vulnerability %s", (field, value) => {
    const run = runScanner({
      report: trivyReport([
        vulnerabilityResult([vulnerability({ [field]: value })]),
      ]),
    });
    expectSafeFailure(run, "RELEASE_SCAN_VULNERABILITY");
  });

  it("rejects unknown Trivy fields", () => {
    const run = runScanner({
      report: { ...trivyReport(), CustomerEmail: "customer@example.test" },
    });
    expectSafeFailure(run, "RELEASE_SCAN_REPORT_UNKNOWN_FIELD");
  });

  it("rejects a Trivy report for a different image digest", () => {
    const run = runScanner({
      report: {
        ...trivyReport(),
        Metadata: {
          ImageID: `sha256:${"9".repeat(64)}`,
          RepoDigests: [`crm-ci@sha256:${"8".repeat(64)}`],
        },
      },
    });
    expectSafeFailure(run, "RELEASE_SCAN_IMAGE_MISMATCH");
  });

  it("rejects malformed subject and provenance arguments", () => {
    const directory = mkdtempSync(join(tmpdir(), "crm-release-scan-arguments-"));
    temporaryDirectories.push(directory);
    const outputPath = join(directory, "scan-report.json");
    const args = makeArguments(directory, outputPath);
    const sourceIndex = args.indexOf("--source-sha") + 1;
    args[sourceIndex] = "not-a-source-sha";
    const run = runScanner({ arguments: args });
    expectSafeFailure(run, "RELEASE_SCAN_SUBJECT");
  });

  it("rejects a malformed explicit evaluation time", () => {
    const directory = mkdtempSync(join(tmpdir(), "crm-release-scan-evaluation-"));
    temporaryDirectories.push(directory);
    const outputPath = join(directory, "scan-report.json");
    const args = makeArguments(directory, outputPath);
    const evaluationIndex = args.indexOf("--evaluation-time") + 1;
    args[evaluationIndex] = "2026-07-19";
    const run = runScanner({ arguments: args });
    expectSafeFailure(run, "RELEASE_SCAN_EVALUATION_TIME");
  });

  it.each([
    ["older", "2026-07-18T23:56:59.999Z"],
    ["newer", "2026-07-19T00:07:00.001Z"],
  ])("rejects an evaluation time more than five minutes %s than the trusted clock", (_label, suppliedTime) => {
    const directory = mkdtempSync(join(tmpdir(), "crm-release-scan-evaluation-anchor-"));
    temporaryDirectories.push(directory);
    const outputPath = join(directory, "scan-report.json");
    const args = makeArguments(directory, outputPath);
    const evaluationIndex = args.indexOf("--evaluation-time") + 1;
    args[evaluationIndex] = suppliedTime;
    const run = runScanner({ arguments: args, trustedNow: evaluationTime });
    expectSafeFailure(run, "RELEASE_SCAN_EVALUATION_TIME");
  });

  it("never overwrites an existing scan report", () => {
    const run = runScanner({ outputSource: "reviewed\n" });
    expect(run.result.status).not.toBe(0);
    expect(run.result.stdout).toBe("");
    expect(run.result.stderr).toBe("RELEASE_SCAN_OUTPUT_EXISTS\n");
    expect(readFileSync(run.outputPath, "utf8")).toBe("reviewed\n");
  });
});

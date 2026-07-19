import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { EXPECTED_MIGRATIONS } from "@/server/db/migration-manifest";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const writerPath = `${repositoryRoot}scripts/ci/write-release-manifest.mjs`;
const writerExists = existsSync(writerPath);
const sourceSha = "1".repeat(40);
const baseDigest =
  "sha256:a2723a2817c5b01b8e7b98d567bc8b5a6b0e713e25bfb0a82b6ade4b9db06f50";
const basePlatformDigest =
  "sha256:6eae66c49774276f50ae1818db25bb89735971a909fb833633dd1400dbc450a1";
const imageManifestDigest = `sha256:${"3".repeat(64)}`;
const imageConfigDigest = `sha256:${"4".repeat(64)}`;
const vulnerabilityDatabaseSha256 = `sha256:${"7".repeat(64)}`;
const imageArtifactSource = "synthetic-oci-image-archive\n";
const imageArtifactSha256 = sha256(imageArtifactSource);
const trivyReportSource = '{"SchemaVersion":2,"Results":[{"Target":"crm"}]}\n';
const trivySecretReportSource =
  '{"SchemaVersion":2,"Results":[{"Target":"crm","Secrets":[]}]}\n';
const trivyVersionSource = '{"Version":"0.72.0"}\n';
const temporaryDirectories: string[] = [];

interface EvidenceMutation {
  image?: Record<string, unknown>;
  ledger?: Record<string, unknown>;
  scan?: Record<string, unknown>;
  cyclonedx?: Record<string, unknown>;
  spdx?: Record<string, unknown>;
  binding?: Record<string, unknown>;
}

function sha256(source: string): string {
  return `sha256:${createHash("sha256").update(source).digest("hex")}`;
}

function writeJson(path: string, value: unknown): string {
  const source = `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(path, source, { encoding: "utf8", flag: "wx" });
  return source;
}

function makeEvidence(mutation: EvidenceMutation = {}) {
  const directory = mkdtempSync(join(tmpdir(), "crm-release-manifest-"));
  temporaryDirectories.push(directory);

  const policy = {
    schemaVersion: 1,
    version: "2026-07-18",
    exceptions: [],
  };
  const policySource = writeJson(join(directory, "policy.json"), policy);

  const image = {
    schemaVersion: 1,
    sourceSha,
    surface: "crm",
    appVersion: sourceSha,
    baseImageDigest: baseDigest,
    baseImagePlatformDigest: basePlatformDigest,
    platform: { os: "linux", architecture: "amd64" },
    imageReference: `crm-ci@${imageManifestDigest}`,
    imageManifestDigest,
    imageConfigDigest,
    imageArtifactSha256,
    ...mutation.image,
  };
  writeJson(join(directory, "image-metadata.json"), image);
  writeFileSync(join(directory, "image.oci.tar"), imageArtifactSource, {
    encoding: "utf8",
    flag: "wx",
  });

  const ledger = {
    schemaVersion: 1,
    entries: EXPECTED_MIGRATIONS.map(({ filename, checksum }) => ({
      filename,
      checksum,
    })),
    ...mutation.ledger,
  };
  const ledgerSource = writeJson(join(directory, "migration-ledger.json"), ledger);

  const cyclonedx = {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    metadata: {
      timestamp: "2026-07-18T00:00:00.000Z",
      tools: {
        components: [
          { type: "application", author: "anchore", name: "syft", version: "1.48.0" },
        ],
      },
      component: { type: "container", name: "crm", version: sourceSha },
    },
    components: [{ type: "library", name: "next", version: "16.2.10" }],
    ...mutation.cyclonedx,
  };
  const cyclonedxSource = writeJson(join(directory, "sbom.cdx.json"), cyclonedx);

  const spdx = {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: "crm",
    documentNamespace: `https://salamland.example.test/sbom/crm/${sourceSha}`,
    creationInfo: {
      created: "2026-07-18T00:00:00.000Z",
      creators: ["Organization: Anchore, Inc.", "Tool: syft-1.48.0"],
    },
    packages: [
      {
        SPDXID: "SPDXRef-Package-next",
        name: "next",
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
    ...mutation.spdx,
  };
  const spdxSource = writeJson(join(directory, "sbom.spdx.json"), spdx);

  const binding = {
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
      artifactSha256: imageArtifactSha256,
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
    ...mutation.binding,
  };
  const bindingSource = writeJson(join(directory, "sbom-binding.json"), binding);
  writeFileSync(join(directory, "trivy-raw.json"), trivyReportSource, {
    encoding: "utf8",
    flag: "wx",
  });
  writeFileSync(join(directory, "trivy-secret-raw.json"), trivySecretReportSource, {
    encoding: "utf8",
    flag: "wx",
  });
  writeFileSync(join(directory, "trivy-version.json"), trivyVersionSource, {
    encoding: "utf8",
    flag: "wx",
  });

  const scan = {
    schemaVersion: 1,
    sourceSha,
    surface: "crm",
    imageManifestDigest,
    result: "pass",
    evaluatedAt: "2026-07-18T00:02:00.000Z",
    findings: [],
    artifacts: {
      imageArtifactSha256,
      sbomBindingSha256: sha256(bindingSource),
      cyclonedxSha256: sha256(cyclonedxSource),
      spdxSha256: sha256(spdxSource),
      trivyReportSha256: sha256(trivyReportSource),
      trivySecretReportSha256: sha256(trivySecretReportSource),
      trivyVersionSha256: sha256(trivyVersionSource),
    },
    scanner: { engine: "trivy", version: "0.69.3" },
    policy: { version: policy.version, sha256: sha256(policySource) },
    vulnerabilityDatabase: {
      source: "ghcr.io/aquasecurity/trivy-db:2",
      version: "2026-07-18",
      updatedAt: "2026-07-18T00:00:00.000Z",
      nextUpdate: "2026-07-19T00:00:00.000Z",
      downloadedAt: "2026-07-18T00:01:00.000Z",
      sha256: vulnerabilityDatabaseSha256,
    },
    ...mutation.scan,
  };
  const scanSource = writeJson(join(directory, "scan-report.json"), scan);

  return {
    directory,
    outputPath: join(directory, "release-manifest.json"),
    sources: {
      policy: policySource,
      ledger: ledgerSource,
      cyclonedx: cyclonedxSource,
      spdx: spdxSource,
      binding: bindingSource,
      scan: scanSource,
    },
  };
}

function runWriter(
  evidence: ReturnType<typeof makeEvidence>,
  overrides: { surface?: string; source?: string; output?: string } = {},
) {
  return spawnSync(
    process.execPath,
    [
      writerPath,
      "--evidence-dir",
      evidence.directory,
      "--surface",
      overrides.surface ?? "crm",
      "--source-sha",
      overrides.source ?? sourceSha,
      "--output",
      overrides.output ?? evidence.outputPath,
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      timeout: 10_000,
      env: { ...process.env, PATH: process.env.PATH },
    },
  );
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("release manifest writer contract", () => {
  it("requires the deterministic fail-closed writer", () => {
    expect(writerExists, "scripts/ci/write-release-manifest.mjs must exist").toBe(true);
  });

  it.skipIf(!writerExists)(
    "binds the exact image, ledger, SBOM, scan, policy and database evidence canonically",
    () => {
      const evidence = makeEvidence();
      const first = runWriter(evidence);
      expect(first.status, first.stderr).toBe(0);
      expect(first.stdout).toBe("");

      const expectedLedgerEntries = EXPECTED_MIGRATIONS.map(({ filename, checksum }) => ({
        filename,
        checksum,
      }));
      const expected = {
        schemaVersion: 1,
        sourceSha,
        surface: "crm",
        appVersion: sourceSha,
        baseImageDigest: baseDigest,
        baseImagePlatformDigest: basePlatformDigest,
        platform: { os: "linux", architecture: "amd64" },
        image: {
          reference: `crm-ci@${imageManifestDigest}`,
          manifestDigest: imageManifestDigest,
          configDigest: imageConfigDigest,
          artifactSha256: imageArtifactSha256,
        },
        migrationLedger: {
          entryCount: 7,
          sha256: sha256(evidence.sources.ledger),
          entries: expectedLedgerEntries,
        },
        sboms: {
          binding: {
            filename: "sbom-binding.json",
            sha256: sha256(evidence.sources.binding),
          },
          cyclonedx: {
            filename: "sbom.cdx.json",
            sha256: sha256(evidence.sources.cyclonedx),
          },
          spdx: {
            filename: "sbom.spdx.json",
            sha256: sha256(evidence.sources.spdx),
          },
        },
        scan: {
          result: "pass",
          evaluatedAt: "2026-07-18T00:02:00.000Z",
          reportSha256: sha256(evidence.sources.scan),
          rawReportSha256: sha256(trivyReportSource),
          secretReportSha256: sha256(trivySecretReportSource),
          versionReportSha256: sha256(trivyVersionSource),
          scanner: { engine: "trivy", version: "0.69.3" },
          policy: { version: "2026-07-18", sha256: sha256(evidence.sources.policy) },
          vulnerabilityDatabase: {
            source: "ghcr.io/aquasecurity/trivy-db:2",
            version: "2026-07-18",
            updatedAt: "2026-07-18T00:00:00.000Z",
            nextUpdate: "2026-07-19T00:00:00.000Z",
            downloadedAt: "2026-07-18T00:01:00.000Z",
            sha256: vulnerabilityDatabaseSha256,
          },
        },
      };
      const expectedSource = `${JSON.stringify(expected, null, 2)}\n`;
      expect(readFileSync(evidence.outputPath, "utf8")).toBe(expectedSource);

      unlinkSync(evidence.outputPath);
      const second = runWriter(evidence);
      expect(second.status, second.stderr).toBe(0);
      expect(readFileSync(evidence.outputPath, "utf8")).toBe(expectedSource);
    },
  );

  it.skipIf(!writerExists)("fails closed when an SBOM is missing", () => {
    const evidence = makeEvidence();
    unlinkSync(join(evidence.directory, "sbom.spdx.json"));

    const result = runWriter(evidence);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/RELEASE_MANIFEST_EVIDENCE_MISSING/);
    expect(existsSync(evidence.outputPath)).toBe(false);
  });

  it.skipIf(!writerExists)("fails closed when the scan report is missing", () => {
    const evidence = makeEvidence();
    unlinkSync(join(evidence.directory, "scan-report.json"));

    const result = runWriter(evidence);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/RELEASE_MANIFEST_EVIDENCE_MISSING/);
    expect(existsSync(evidence.outputPath)).toBe(false);
  });

  it.skipIf(!writerExists)("rejects changed SBOM bytes", () => {
    const evidence = makeEvidence();
    const path = join(evidence.directory, "sbom.cdx.json");
    const sbom = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    sbom.serialNumber = "urn:uuid:00000000-0000-4000-8000-000000000000";
    writeFileSync(path, `${JSON.stringify(sbom, null, 2)}\n`, {
      encoding: "utf8",
    });

    const result = runWriter(evidence);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/RELEASE_MANIFEST_SBOM_MISMATCH/);
    expect(existsSync(evidence.outputPath)).toBe(false);
  });

  it.skipIf(!writerExists)("rejects a CycloneDX SBOM for a different source", () => {
    const evidence = makeEvidence({
      cyclonedx: {
        metadata: {
          timestamp: "2026-07-18T00:00:00.000Z",
          tools: {
            components: [
              { type: "application", author: "anchore", name: "syft", version: "1.48.0" },
            ],
          },
          component: { type: "container", name: "crm", version: "8".repeat(40) },
        },
      },
    });

    const result = runWriter(evidence);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/RELEASE_MANIFEST_SBOM_MISMATCH/);
    expect(existsSync(evidence.outputPath)).toBe(false);
  });

  it.skipIf(!writerExists)("rejects an SPDX SBOM for a different source", () => {
    const evidence = makeEvidence();
    const path = join(evidence.directory, "sbom.spdx.json");
    const sbom = JSON.parse(readFileSync(path, "utf8")) as {
      packages: Array<Record<string, unknown>>;
    };
    const rootPackage = sbom.packages.find(
      (value) => value.SPDXID === "SPDXRef-DocumentRoot-Image-crm",
    );
    rootPackage!.versionInfo = "8".repeat(40);
    const changedSource = `${JSON.stringify(sbom, null, 2)}\n`;
    writeFileSync(path, changedSource, "utf8");

    const bindingPath = join(evidence.directory, "sbom-binding.json");
    const binding = JSON.parse(readFileSync(bindingPath, "utf8")) as {
      sboms: { spdx: Record<string, unknown> };
    };
    binding.sboms.spdx.sha256 = sha256(changedSource);
    const changedBindingSource = `${JSON.stringify(binding, null, 2)}\n`;
    writeFileSync(bindingPath, changedBindingSource, "utf8");

    const scanPath = join(evidence.directory, "scan-report.json");
    const scan = JSON.parse(readFileSync(scanPath, "utf8")) as {
      artifacts: Record<string, unknown>;
    };
    scan.artifacts.spdxSha256 = sha256(changedSource);
    scan.artifacts.sbomBindingSha256 = sha256(changedBindingSource);
    writeFileSync(scanPath, `${JSON.stringify(scan, null, 2)}\n`, "utf8");

    const result = runWriter(evidence);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/RELEASE_MANIFEST_SBOM_MISMATCH/);
    expect(existsSync(evidence.outputPath)).toBe(false);
  });

  it.skipIf(!writerExists)("rejects an SPDX SBOM for a different image manifest", () => {
    const evidence = makeEvidence();
    const path = join(evidence.directory, "sbom.spdx.json");
    const sbom = JSON.parse(readFileSync(path, "utf8")) as {
      packages: Array<Record<string, unknown>>;
    };
    const rootPackage = sbom.packages.find(
      (value) => value.SPDXID === "SPDXRef-DocumentRoot-Image-crm",
    );
    rootPackage!.checksums = [
      { algorithm: "SHA256", checksumValue: "9".repeat(64) },
    ];
    const changedSource = `${JSON.stringify(sbom, null, 2)}\n`;
    writeFileSync(path, changedSource, "utf8");

    const bindingPath = join(evidence.directory, "sbom-binding.json");
    const binding = JSON.parse(readFileSync(bindingPath, "utf8")) as {
      sboms: { spdx: Record<string, unknown> };
    };
    binding.sboms.spdx.sha256 = sha256(changedSource);
    const changedBindingSource = `${JSON.stringify(binding, null, 2)}\n`;
    writeFileSync(bindingPath, changedBindingSource, "utf8");

    const scanPath = join(evidence.directory, "scan-report.json");
    const scan = JSON.parse(readFileSync(scanPath, "utf8")) as {
      artifacts: Record<string, unknown>;
    };
    scan.artifacts.spdxSha256 = sha256(changedSource);
    scan.artifacts.sbomBindingSha256 = sha256(changedBindingSource);
    writeFileSync(scanPath, `${JSON.stringify(scan, null, 2)}\n`, "utf8");

    const result = runWriter(evidence);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/RELEASE_MANIFEST_SBOM_MISMATCH/);
    expect(existsSync(evidence.outputPath)).toBe(false);
  });

  it.skipIf(!writerExists)("rejects a binding sidecar for a different image", () => {
    const evidence = makeEvidence({
      binding: {
        image: {
          manifestDigest: `sha256:${"9".repeat(64)}`,
          configDigest: imageConfigDigest,
          artifactSha256: imageArtifactSha256,
        },
      },
    });

    const result = runWriter(evidence);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/RELEASE_MANIFEST_SBOM_MISMATCH/);
    expect(existsSync(evidence.outputPath)).toBe(false);
  });

  it.skipIf(!writerExists)("rejects empty or non-Syft SBOM inventories", () => {
    const emptyCycloneDx = makeEvidence({ cyclonedx: { components: [] } });
    let result = runWriter(emptyCycloneDx);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/RELEASE_MANIFEST_SBOM_INVALID/);

    const emptySpdx = makeEvidence({ spdx: { packages: [] } });
    result = runWriter(emptySpdx);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/RELEASE_MANIFEST_SBOM_INVALID/);

    const wrongTool = makeEvidence({
      cyclonedx: {
        metadata: {
          timestamp: "2026-07-18T00:00:00.000Z",
          tools: { components: [{ type: "application", name: "other", version: "1.0.0" }] },
          component: { type: "container", name: "crm", version: sourceSha },
        },
      },
    });
    result = runWriter(wrongTool);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/RELEASE_MANIFEST_SBOM_INVALID/);
  });

  it.skipIf(!writerExists)("rejects stale CycloneDX or SPDX generation evidence", () => {
    const staleCycloneDx = makeEvidence({
      cyclonedx: {
        metadata: {
          timestamp: "2026-07-17T20:00:00.000Z",
          tools: {
            components: [
              { type: "application", author: "anchore", name: "syft", version: "1.48.0" },
            ],
          },
          component: { type: "container", name: "crm", version: sourceSha },
        },
      },
    });
    let result = runWriter(staleCycloneDx);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/RELEASE_MANIFEST_SBOM_FRESHNESS/);

    const staleSpdx = makeEvidence({
      spdx: {
        creationInfo: {
          created: "2026-07-17T20:00:00Z",
          creators: ["Organization: Anchore, Inc.", "Tool: syft-1.48.0"],
        },
      },
    });
    result = runWriter(staleSpdx);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/RELEASE_MANIFEST_SBOM_FRESHNESS/);
  });

  it.skipIf(!writerExists)("rejects duplicate evidence JSON keys", () => {
    const evidence = makeEvidence();
    const path = join(evidence.directory, "image-metadata.json");
    const source = readFileSync(path, "utf8").replace(
      '  "surface": "crm",',
      '  "surface": "crm",\n  "surface": "crm",',
    );
    writeFileSync(path, source, "utf8");

    const result = runWriter(evidence);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/RELEASE_MANIFEST_IMAGE_METADATA/);
    expect(existsSync(evidence.outputPath)).toBe(false);
  });

  it.skipIf(!writerExists)("rejects a mutable image reference", () => {
    const evidence = makeEvidence({ image: { imageReference: "crm-ci:latest" } });

    const result = runWriter(evidence);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/RELEASE_MANIFEST_IMAGE_REFERENCE/);
    expect(existsSync(evidence.outputPath)).toBe(false);
  });

  it.skipIf(!writerExists)("rejects image archive bytes that differ from metadata", () => {
    const evidence = makeEvidence();
    writeFileSync(join(evidence.directory, "image.oci.tar"), "changed\n", {
      encoding: "utf8",
    });

    const result = runWriter(evidence);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/RELEASE_MANIFEST_IMAGE_ARTIFACT/);
    expect(existsSync(evidence.outputPath)).toBe(false);
  });

  it.skipIf(!writerExists)("rejects a surface mismatch", () => {
    const evidence = makeEvidence({ image: { surface: "tasha" } });

    const result = runWriter(evidence);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/RELEASE_MANIFEST_SURFACE_MISMATCH/);
    expect(existsSync(evidence.outputPath)).toBe(false);
  });

  it.skipIf(!writerExists)("rejects a source mismatch", () => {
    const evidence = makeEvidence({ scan: { sourceSha: "8".repeat(40) } });

    const result = runWriter(evidence);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/RELEASE_MANIFEST_SOURCE_MISMATCH/);
    expect(existsSync(evidence.outputPath)).toBe(false);
  });

  it.skipIf(!writerExists)("rejects a manifest/image digest mismatch", () => {
    const evidence = makeEvidence({
      scan: { imageManifestDigest: `sha256:${"9".repeat(64)}` },
    });

    const result = runWriter(evidence);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/RELEASE_MANIFEST_IMAGE_MISMATCH/);
    expect(existsSync(evidence.outputPath)).toBe(false);
  });

  it.skipIf(!writerExists)("rejects an altered seven-row migration identity", () => {
    const entries = EXPECTED_MIGRATIONS.map<{ filename: string; checksum: string }>(
      ({ filename, checksum }) => ({ filename, checksum }),
    );
    entries[6] = { ...entries[6]!, checksum: "0".repeat(64) };
    const evidence = makeEvidence({ ledger: { entries } });

    const result = runWriter(evidence);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/RELEASE_MANIFEST_MIGRATION_LEDGER/);
    expect(existsSync(evidence.outputPath)).toBe(false);
  });

  it.skipIf(!writerExists)("rejects unknown evidence fields", () => {
    const secretCanary = "must-not-appear-in-release-manifest-errors";
    const evidence = makeEvidence({ image: { unreviewed: secretCanary } });

    const result = runWriter(evidence);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/RELEASE_MANIFEST_UNKNOWN_FIELD/);
    expect(result.stderr).not.toContain(secretCanary);
    expect(existsSync(evidence.outputPath)).toBe(false);
  });

  it.skipIf(!writerExists)("never overwrites an existing manifest", () => {
    const evidence = makeEvidence();
    writeFileSync(evidence.outputPath, "reviewed\n", { encoding: "utf8", flag: "wx" });

    const result = runWriter(evidence);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/RELEASE_MANIFEST_OUTPUT_EXISTS/);
    expect(readFileSync(evidence.outputPath, "utf8")).toBe("reviewed\n");
  });
});

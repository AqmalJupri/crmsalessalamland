import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const inspectorPath = `${repositoryRoot}scripts/ci/assert-release-image.mjs`;
const inspectorExists = existsSync(inspectorPath);
const sourceSha = "a".repeat(40);
const expectedSource = "https://github.com/AqmalJupri/crmsalessalamland";
const canary = "SALAMLAND_CI_CANARY_7F3C9A1E5B2D";
const runtimeBaseLock = JSON.parse(
  readFileSync(`${repositoryRoot}security/runtime-base-lock.json`, "utf8"),
) as {
  layers: Array<{ mediaType: string; digest: string; size: number }>;
  diffIds: string[];
};
const baseImageDigest =
  "sha256:a2723a2817c5b01b8e7b98d567bc8b5a6b0e713e25bfb0a82b6ade4b9db06f50";
const baseImagePlatformDigest =
  "sha256:6eae66c49774276f50ae1818db25bb89735971a909fb833633dd1400dbc450a1";
const temporaryDirectories: string[] = [];

interface TarEntry {
  path: string;
  content?: Buffer | string;
  type?:
    | "file"
    | "directory"
    | "symlink"
    | "hardlink"
    | "pax"
    | "gnu-long-name"
    | "gnu-long-link";
  linkname?: string;
  mode?: number;
  uid?: number;
  gid?: number;
}

interface OciFixtureOptions {
  readonly surface?: "crm" | "tasha";
  readonly layerEntries?: readonly TarEntry[];
  readonly compressedLayer?: boolean;
  readonly mutateConfig?: (config: Record<string, unknown>) => void;
  readonly mutateManifest?: (manifest: Record<string, unknown>) => void;
  readonly mutateIndex?: (index: Record<string, unknown>) => void;
  readonly mutateOuterEntries?: (entries: TarEntry[]) => void;
  readonly malformedIndex?: string;
}

interface OciFixture {
  readonly directory: string;
  readonly archivePath: string;
  readonly outputPath: string;
  readonly manifestDigest: string;
  readonly archiveDigest: string;
  readonly surface: "crm" | "tasha";
}

function sha256(bytes: Buffer | string): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function writeTarString(header: Buffer, value: string, offset: number, length: number): void {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength > length) throw new Error(`tar field is too long: ${value}`);
  bytes.copy(header, offset);
}

function writeTarOctal(header: Buffer, value: number, offset: number, length: number): void {
  const source = value.toString(8).padStart(length - 1, "0");
  if (source.length !== length - 1) throw new Error(`tar octal field overflow: ${value}`);
  writeTarString(header, `${source}\0`, offset, length);
}

function tarHeader(entry: TarEntry, size: number): Buffer {
  const header = Buffer.alloc(512);
  writeTarString(header, entry.path, 0, 100);
  writeTarOctal(header, entry.mode ?? (entry.type === "directory" ? 0o755 : 0o644), 100, 8);
  writeTarOctal(header, entry.uid ?? 0, 108, 8);
  writeTarOctal(header, entry.gid ?? 0, 116, 8);
  writeTarOctal(header, size, 124, 12);
  writeTarOctal(header, 0, 136, 12);
  header.fill(0x20, 148, 156);
  const type = entry.type ?? "file";
  header[156] = {
    file: 0x30,
    directory: 0x35,
    symlink: 0x32,
    hardlink: 0x31,
    pax: 0x78,
    "gnu-long-name": 0x4c,
    "gnu-long-link": 0x4b,
  }[type];
  if (entry.linkname) writeTarString(header, entry.linkname, 157, 100);
  writeTarString(header, "ustar\0", 257, 6);
  writeTarString(header, "00", 263, 2);
  writeTarString(header, "root", 265, 32);
  writeTarString(header, "root", 297, 32);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  const checksumSource = checksum.toString(8).padStart(6, "0");
  writeTarString(header, `${checksumSource}\0 `, 148, 8);
  return header;
}

function makeTar(entries: readonly TarEntry[]): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const type = entry.type ?? "file";
    const content =
      ["file", "pax", "gnu-long-name", "gnu-long-link"].includes(type)
        ? Buffer.isBuffer(entry.content)
          ? entry.content
          : Buffer.from(entry.content ?? "", "utf8")
        : Buffer.alloc(0);
    chunks.push(tarHeader(entry, content.byteLength), content);
    const padding = (512 - (content.byteLength % 512)) % 512;
    if (padding) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

function paxRecord(key: string, value: string): Buffer {
  const body = `${key}=${value}\n`;
  let length = Buffer.byteLength(body, "utf8") + 2;
  while (true) {
    const source = `${length} ${body}`;
    const actual = Buffer.byteLength(source, "utf8");
    if (actual === length) return Buffer.from(source, "utf8");
    length = actual;
  }
}

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), "utf8");
}

function defaultLayerEntries(): TarEntry[] {
  return [
    { path: "app/server.js", content: "console.log('synthetic runtime');\n", uid: 0, gid: 0 },
    {
      path: "app/package.json",
      content: '{"name":"crm-salam-fortress","private":true}',
      uid: 0,
      gid: 0,
    },
    {
      path: "app/.next/required-server-files.json",
      content: "{}",
      uid: 0,
      gid: 0,
    },
    {
      path: "app/.next/static/chunks/app.js",
      content: "self.webpackChunk_N_E=[];\n",
      uid: 0,
      gid: 0,
    },
    { path: "app/public/favicon.ico", content: Buffer.from([0, 1, 2]), uid: 0, gid: 0 },
    {
      path: "app/node_modules/next/package.json",
      content: '{"name":"next","version":"16.2.10"}',
      uid: 0,
      gid: 0,
    },
  ];
}

function makeOciFixture(options: OciFixtureOptions = {}): OciFixture {
  const directory = mkdtempSync(join(tmpdir(), "crm-release-image-inspection-"));
  temporaryDirectories.push(directory);
  const surface = options.surface ?? "crm";
  const uncompressedLayer = makeTar(options.layerEntries ?? defaultLayerEntries());
  const layerBytes = options.compressedLayer === false ? uncompressedLayer : gzipSync(uncompressedLayer);
  const layerMediaType =
    options.compressedLayer === false
      ? "application/vnd.oci.image.layer.v1.tar"
      : "application/vnd.oci.image.layer.v1.tar+gzip";
  const layerDigest = sha256(layerBytes);

  const config: Record<string, unknown> = {
    architecture: "amd64",
    config: {
      Env: [
        "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt",
        "HOME=/tmp",
        "HOSTNAME=0.0.0.0",
        "NEXT_TELEMETRY_DISABLED=1",
        "NODE_ENV=production",
        "PORT=3000",
        `APP_VERSION=${sourceSha}`,
        `PRODUCT_SURFACE=${surface}`,
      ],
      ExposedPorts: { "3000/tcp": {} },
      Labels: {
        "org.opencontainers.image.source": expectedSource,
        "org.opencontainers.image.revision": sourceSha,
        "org.opencontainers.image.version": sourceSha,
        "com.salamland.product-surface": surface,
      },
      User: "65532:65532",
      WorkingDir: "/app",
      Cmd: ["/nodejs/bin/node", "server.js"],
      ArgsEscaped: true,
    },
    created: "2026-07-19T00:00:00.000Z",
    history: [{ created_by: "synthetic reviewed fixture" }],
    os: "linux",
    rootfs: {
      type: "layers",
      diff_ids: [...runtimeBaseLock.diffIds, sha256(uncompressedLayer)],
    },
  };
  options.mutateConfig?.(config);
  const configBytes = jsonBytes(config);
  const configDigest = sha256(configBytes);

  const manifest: Record<string, unknown> = {
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: {
      mediaType: "application/vnd.oci.image.config.v1+json",
      digest: configDigest,
      size: configBytes.byteLength,
    },
    layers: [
      ...runtimeBaseLock.layers,
      { mediaType: layerMediaType, digest: layerDigest, size: layerBytes.byteLength },
    ],
  };
  options.mutateManifest?.(manifest);
  const manifestBytes = jsonBytes(manifest);
  const manifestDigest = sha256(manifestBytes);

  const index: Record<string, unknown> = {
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.index.v1+json",
    manifests: [
      {
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        digest: manifestDigest,
        size: manifestBytes.byteLength,
        platform: { architecture: "amd64", os: "linux" },
      },
    ],
  };
  options.mutateIndex?.(index);

  const outerEntries: TarEntry[] = [
    { path: "oci-layout", content: '{"imageLayoutVersion":"1.0.0"}' },
    { path: "index.json", content: options.malformedIndex ?? JSON.stringify(index) },
    { path: `blobs/sha256/${configDigest.slice(7)}`, content: configBytes },
    { path: `blobs/sha256/${manifestDigest.slice(7)}`, content: manifestBytes },
    { path: `blobs/sha256/${layerDigest.slice(7)}`, content: layerBytes },
  ];
  options.mutateOuterEntries?.(outerEntries);
  const archive = makeTar(outerEntries);
  const archivePath = join(directory, "image.oci.tar");
  const outputPath = join(directory, "image-metadata.json");
  writeFileSync(archivePath, archive, { flag: "wx" });
  return {
    directory,
    archivePath,
    outputPath,
    manifestDigest,
    archiveDigest: sha256(archive),
    surface,
  };
}

function runInspector(
  fixture: OciFixture,
  overrides: {
    readonly archive?: string;
    readonly surface?: string;
    readonly source?: string;
    readonly output?: string;
    readonly canary?: string;
    readonly extraArguments?: readonly string[];
  } = {},
) {
  return spawnSync(
    process.execPath,
    [
      inspectorPath,
      "--archive",
      overrides.archive ?? fixture.archivePath,
      "--surface",
      overrides.surface ?? fixture.surface,
      "--source-sha",
      overrides.source ?? sourceSha,
      "--output",
      overrides.output ?? fixture.outputPath,
      "--canary",
      overrides.canary ?? canary,
      ...(overrides.extraArguments ?? []),
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      timeout: 15_000,
      env: { NODE_ENV: process.env.NODE_ENV ?? "test", PATH: process.env.PATH },
    },
  );
}

function expectRejected(
  fixture: OciFixture,
  code: RegExp,
  overrides: Parameters<typeof runInspector>[1] = {},
): void {
  const result = runInspector(fixture, overrides);
  expect(result.status).not.toBe(0);
  expect(result.signal).toBeNull();
  expect(result.stdout).toBe("");
  expect(result.stderr).toMatch(code);
  expect(result.stderr).not.toContain(canary);
  expect(existsSync(overrides.output ?? fixture.outputPath)).toBe(false);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("release image inspection contract", () => {
  it("requires the bounded OCI archive inspector", () => {
    expect(inspectorExists, "scripts/ci/assert-release-image.mjs must exist").toBe(true);
  });

  it.skipIf(!inspectorExists)(
    "writes only canonical metadata bound to the exact inspected gzip image",
    () => {
      const fixture = makeOciFixture();
      const result = runInspector(fixture);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
      const metadataSource = readFileSync(fixture.outputPath, "utf8");
      const metadata = JSON.parse(metadataSource) as Record<
        string,
        unknown
      >;
      expect(metadataSource).toBe(`${JSON.stringify(metadata, null, 2)}\n`);
      expect(metadata).toEqual({
        schemaVersion: 1,
        sourceSha,
        surface: "crm",
        appVersion: sourceSha,
        baseImageDigest,
        baseImagePlatformDigest,
        platform: { os: "linux", architecture: "amd64" },
        imageReference: `crm-ci@${fixture.manifestDigest}`,
        imageManifestDigest: fixture.manifestDigest,
        imageConfigDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        imageArtifactSha256: fixture.archiveDigest,
      });
      expect(Object.keys(metadata)).toEqual([
        "schemaVersion",
        "sourceSha",
        "surface",
        "appVersion",
        "baseImageDigest",
        "baseImagePlatformDigest",
        "platform",
        "imageReference",
        "imageManifestDigest",
        "imageConfigDigest",
        "imageArtifactSha256",
      ]);
    },
  );

  it.skipIf(!inspectorExists)("accepts an uncompressed OCI layer", () => {
    const fixture = makeOciFixture({ compressedLayer: false, surface: "tasha" });
    const result = runInspector(fixture);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(fixture.outputPath, "utf8"))).toMatchObject({
      surface: "tasha",
      imageReference: `tasha-ci@${fixture.manifestDigest}`,
    });
  });

  it.skipIf(!inspectorExists)("accepts bounded PAX and GNU extended paths for real pnpm links", () => {
    const longLink = `.pnpm/next@${"a".repeat(96)}/node_modules/next`;
    expect(Buffer.byteLength(longLink, "utf8")).toBeGreaterThan(100);
    const target = `app/node_modules/${longLink}/package.json`;
    const longPath = `app/node_modules/.pnpm/${"p".repeat(240)}/package.json`;

    const pax = makeOciFixture({
      layerEntries: [
        ...defaultLayerEntries(),
        {
          path: "PaxHeaders/next-target",
          type: "pax",
          content: paxRecord("path", target),
          uid: 0,
          gid: 0,
        },
        {
          path: "app/node_modules/target-placeholder",
          content: '{"name":"next"}',
          uid: 0,
          gid: 0,
        },
        {
          path: "PaxHeaders/next-link",
          type: "pax",
          content: paxRecord("linkpath", longLink),
          uid: 0,
          gid: 0,
        },
        {
          path: "app/node_modules/next-long",
          type: "symlink",
          linkname: "placeholder",
          uid: 0,
          gid: 0,
        },
        {
          path: "PaxHeaders/next-path",
          type: "pax",
          content: paxRecord("path", longPath),
          uid: 0,
          gid: 0,
        },
        {
          path: "app/node_modules/path-placeholder",
          content: '{"name":"pax-path"}',
          uid: 0,
          gid: 0,
        },
      ],
    });
    const paxResult = runInspector(pax);
    expect(paxResult.status, paxResult.stderr).toBe(0);

    const gnu = makeOciFixture({
      layerEntries: [
        ...defaultLayerEntries(),
        {
          path: "././@LongLink",
          type: "gnu-long-name",
          content: Buffer.concat([Buffer.from(target, "utf8"), Buffer.from([0])]),
          uid: 0,
          gid: 0,
        },
        {
          path: "app/node_modules/target-placeholder",
          content: '{"name":"next"}',
          uid: 0,
          gid: 0,
        },
        {
          path: "././@LongLink",
          type: "gnu-long-link",
          content: Buffer.concat([Buffer.from(longLink, "utf8"), Buffer.from([0])]),
          uid: 0,
          gid: 0,
        },
        {
          path: "app/node_modules/next-long",
          type: "symlink",
          linkname: "placeholder",
          uid: 0,
          gid: 0,
        },
      ],
    });
    const gnuResult = runInspector(gnu);
    expect(gnuResult.status, gnuResult.stderr).toBe(0);
  });

  it.skipIf(!inspectorExists)("rejects malformed, unsafe, repeated, or dangling tar extensions", () => {
    const cases: readonly TarEntry[][] = [
      [
        ...defaultLayerEntries(),
        { path: "PaxHeaders/dangling", type: "pax", content: paxRecord("path", "app/server.js") },
      ],
      [
        ...defaultLayerEntries(),
        { path: "PaxHeaders/first", type: "pax", content: paxRecord("path", "app/server-one.js") },
        { path: "PaxHeaders/second", type: "pax", content: paxRecord("path", "app/server-two.js") },
        { path: "app/server-placeholder.js", content: "blocked" },
      ],
      [
        ...defaultLayerEntries(),
        { path: "PaxHeaders/malformed", type: "pax", content: "11 path=bad\n" },
        { path: "app/server-placeholder.js", content: "blocked" },
      ],
      [
        ...defaultLayerEntries(),
        { path: "PaxHeaders/key", type: "pax", content: paxRecord("size", "1") },
        { path: "app/server-placeholder.js", content: "blocked" },
      ],
      [
        ...defaultLayerEntries(),
        { path: "PaxHeaders/link-on-file", type: "pax", content: paxRecord("linkpath", "app/server.js") },
        { path: "app/server-placeholder.js", content: "blocked" },
      ],
      [
        ...defaultLayerEntries(),
        { path: "././@LongLink", type: "gnu-long-link", content: Buffer.from("missing-nul", "utf8") },
        { path: "app/node_modules/link", type: "symlink", linkname: "placeholder" },
      ],
    ];

    for (const layerEntries of cases) {
      expectRejected(makeOciFixture({ layerEntries }), /RELEASE_IMAGE_TAR_EXTENSION/);
    }

    expectRejected(
      makeOciFixture({
        layerEntries: [
          ...defaultLayerEntries(),
          {
            path: "PaxHeaders/traversal",
            type: "pax",
            content: paxRecord("path", "app/../etc/shadow"),
          },
          { path: "app/server-placeholder.js", content: "blocked" },
        ],
      }),
      /RELEASE_IMAGE_TAR_PATH/,
    );
  });

  it.skipIf(!inspectorExists)("rejects malformed inspection JSON", () => {
    const fixture = makeOciFixture({ malformedIndex: '{"schemaVersion":2,' });
    expectRejected(fixture, /RELEASE_IMAGE_JSON_INVALID/);
  });

  it.skipIf(!inspectorExists)("rejects duplicate inspection JSON keys", () => {
    const fixture = makeOciFixture({
      malformedIndex: `{"schemaVersion":2,"schemaVersion":2,"mediaType":"application/vnd.oci.image.index.v1+json","manifests":[]}`,
    });
    expectRejected(fixture, /RELEASE_IMAGE_JSON_INVALID/);
  });

  it.skipIf(!inspectorExists)("rejects malformed and mismatched blob digests", () => {
    const malformed = makeOciFixture({
      mutateIndex: (index) => {
        const descriptor = (index.manifests as Record<string, unknown>[])[0]!;
        descriptor.digest = "sha256:not-a-digest";
      },
    });
    expectRejected(malformed, /RELEASE_IMAGE_DIGEST_INVALID/);

    const mismatch = makeOciFixture({
      mutateOuterEntries: (entries) => {
        const config = entries.find((entry) => entry.path.startsWith("blobs/sha256/"))!;
        config.content = Buffer.from(`${Buffer.from(config.content as Buffer).toString("utf8")} `);
      },
    });
    expectRejected(mismatch, /RELEASE_IMAGE_BLOB_(?:DIGEST|SIZE)/);
  });

  it.skipIf(!inspectorExists)("requires exactly one manifest and one referenced config", () => {
    const twoManifests = makeOciFixture({
      mutateIndex: (index) => {
        const manifests = index.manifests as Record<string, unknown>[];
        manifests.push({ ...manifests[0] });
      },
    });
    expectRejected(twoManifests, /RELEASE_IMAGE_MANIFEST_COUNT/);

    const orphanConfig = makeOciFixture({
      mutateOuterEntries: (entries) => {
        entries.push({ path: `blobs/sha256/${"f".repeat(64)}`, content: "{}" });
      },
    });
    expectRejected(orphanConfig, /RELEASE_IMAGE_ORPHAN_BLOB/);
  });

  it.skipIf(!inspectorExists)("proves the exact runtime-base ancestry", () => {
    const changedLayer = makeOciFixture({
      mutateManifest: (manifest) => {
        const layers = manifest.layers as Record<string, unknown>[];
        layers[0] = { ...layers[0], digest: `sha256:${"f".repeat(64)}` };
      },
    });
    expectRejected(changedLayer, /RELEASE_IMAGE_BASE_ANCESTRY/);

    const changedDiffId = makeOciFixture({
      mutateConfig: (config) => {
        const rootfs = config.rootfs as { diff_ids: string[] };
        rootfs.diff_ids[0] = `sha256:${"e".repeat(64)}`;
      },
    });
    expectRejected(changedDiffId, /RELEASE_IMAGE_BASE_ANCESTRY/);

    const outsideApp = makeOciFixture({
      layerEntries: [
        ...defaultLayerEntries(),
        { path: "usr/local/bin/node", content: "replacement", uid: 0, gid: 0 },
      ],
    });
    expectRejected(outsideApp, /RELEASE_IMAGE_NON_BASE_PATH/);
  });

  it.skipIf(!inspectorExists)("rejects traversal and duplicate tar paths", () => {
    const traversal = makeOciFixture({
      layerEntries: [
        ...defaultLayerEntries(),
        { path: "app/../etc/shadow", content: "blocked", uid: 0, gid: 0 },
      ],
    });
    expectRejected(traversal, /RELEASE_IMAGE_TAR_PATH/);

    const duplicate = makeOciFixture({
      layerEntries: [
        ...defaultLayerEntries(),
        { path: "app/server.js", content: "second", uid: 0, gid: 0 },
      ],
    });
    expectRejected(duplicate, /RELEASE_IMAGE_TAR_DUPLICATE/);
  });

  it.skipIf(!inspectorExists)("accepts only contained, resolvable application links", () => {
    const safe = makeOciFixture({
      layerEntries: [
        ...defaultLayerEntries(),
        {
          path: "app/node_modules/.pnpm/react@19.2.7/node_modules/react/index.js",
          content: "export {};\n",
          uid: 0,
          gid: 0,
        },
        {
          path: "app/node_modules/react",
          type: "symlink",
          linkname: ".pnpm/react@19.2.7/node_modules/react",
          mode: 0o777,
          uid: 0,
          gid: 0,
        },
        {
          path: "app/node_modules/next/package-copy.json",
          type: "hardlink",
          linkname: "app/node_modules/next/package.json",
          uid: 0,
          gid: 0,
        },
      ],
    });
    const result = runInspector(safe);
    expect(result.status, result.stderr).toBe(0);

    for (const [type, linkname] of [
      ["symlink", "../../etc/passwd"],
      ["hardlink", "app/../../etc/passwd"],
    ] as const) {
      const escaping = makeOciFixture({
        layerEntries: [
          ...defaultLayerEntries(),
          { path: "app/public/escape", type, linkname, uid: 0, gid: 0 },
        ],
      });
      expectRejected(escaping, /RELEASE_IMAGE_APP_LINK/);
    }

    const missing = makeOciFixture({
      layerEntries: [
        ...defaultLayerEntries(),
        {
          path: "app/node_modules/missing",
          type: "symlink",
          linkname: ".pnpm/missing/node_modules/missing",
          uid: 0,
          gid: 0,
        },
      ],
    });
    expectRejected(missing, /RELEASE_IMAGE_APP_LINK/);

    const cycle = makeOciFixture({
      layerEntries: [
        ...defaultLayerEntries(),
        { path: "app/node_modules/a", type: "symlink", linkname: "b", uid: 0, gid: 0 },
        { path: "app/node_modules/b", type: "symlink", linkname: "a", uid: 0, gid: 0 },
      ],
    });
    expectRejected(cycle, /RELEASE_IMAGE_APP_LINK/);
  });

  it.skipIf(!inspectorExists)("rejects hostile outer-archive links", () => {
    const fixture = makeOciFixture({
      mutateOuterEntries: (entries) => {
        entries.push({ path: "index-copy.json", type: "symlink", linkname: "index.json" });
      },
    });
    expectRejected(fixture, /RELEASE_IMAGE_TAR_TYPE/);
  });

  it.skipIf(!inspectorExists)("rejects oversized archive evidence before parsing", () => {
    const fixture = makeOciFixture();
    const oversizedPath = join(fixture.directory, "oversized.oci.tar");
    writeFileSync(oversizedPath, "x", { flag: "wx" });
    truncateSync(oversizedPath, 4 * 1024 * 1024 * 1024 + 1);
    expectRejected(fixture, /RELEASE_IMAGE_ARCHIVE_BOUNDS/, { archive: oversizedPath });
  });

  it.skipIf(!inspectorExists)("rejects the wrong platform, root user and startup contract", () => {
    const wrongPlatform = makeOciFixture({
      mutateConfig: (config) => {
        config.architecture = "arm64";
      },
    });
    expectRejected(wrongPlatform, /RELEASE_IMAGE_PLATFORM/);

    const root = makeOciFixture({
      mutateConfig: (config) => {
        (config.config as Record<string, unknown>).User = "0:0";
      },
    });
    expectRejected(root, /RELEASE_IMAGE_USER/);

    const shellStartup = makeOciFixture({
      mutateConfig: (config) => {
        const runtime = config.config as Record<string, unknown>;
        runtime.Entrypoint = ["/bin/sh", "-c"];
        runtime.Cmd = ["node server.js"];
      },
    });
    expectRejected(shellStartup, /RELEASE_IMAGE_(?:ENTRYPOINT|COMMAND)/);
  });

  it.skipIf(!inspectorExists)("accepts the exact BuildKit CMD compatibility marker", () => {
    const fixture = makeOciFixture();
    const result = runInspector(fixture);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  it.skipIf(!inspectorExists)("requires the exact BuildKit CMD compatibility marker", () => {
    const missing = makeOciFixture({
      mutateConfig: (config) => {
        delete (config.config as Record<string, unknown>).ArgsEscaped;
      },
    });
    expectRejected(missing, /RELEASE_IMAGE_ARGS_ESCAPED/);

    for (const value of [false, null, "true", 1]) {
      const fixture = makeOciFixture({
        mutateConfig: (config) => {
          (config.config as Record<string, unknown>).ArgsEscaped = value;
        },
      });
      expectRejected(fixture, /RELEASE_IMAGE_ARGS_ESCAPED/);
    }
  });

  it.skipIf(!inspectorExists)("rejects environment entries outside the exact surface contract", () => {
    for (const [surface, entry] of [
      ["crm", "DATABASE_URL=postgresql://crm_user:synthetic-password@db.internal/crm"],
      ["tasha", "API_KEY=synthetic-api-key-value"],
    ] as const) {
      const fixture = makeOciFixture({
        surface,
        mutateConfig: (config) => {
          const runtime = config.config as { Env: string[] };
          runtime.Env.push(entry);
        },
      });
      expectRejected(fixture, /RELEASE_IMAGE_ENVIRONMENT/);
    }

    const mutableNodeEnvironment = makeOciFixture({
      mutateConfig: (config) => {
        const runtime = config.config as { Env: string[] };
        runtime.Env = runtime.Env.map((entry) =>
          entry === "NODE_ENV=production" ? "NODE_ENV=development" : entry,
        );
      },
    });
    expectRejected(mutableNodeEnvironment, /RELEASE_IMAGE_ENVIRONMENT/);
  });

  it.skipIf(!inspectorExists)("requires exactly the reviewed application port", () => {
    const mutations = [
      (runtime: Record<string, unknown>) => {
        delete runtime.ExposedPorts;
      },
      (runtime: Record<string, unknown>) => {
        runtime.ExposedPorts = { "3000/tcp": {}, "22/tcp": {} };
      },
      (runtime: Record<string, unknown>) => {
        runtime.ExposedPorts = ["3000/tcp"];
      },
      (runtime: Record<string, unknown>) => {
        runtime.ExposedPorts = { "3000/tcp": { unsafe: true } };
      },
    ];

    for (const mutate of mutations) {
      const fixture = makeOciFixture({
        mutateConfig: (config) => mutate(config.config as Record<string, unknown>),
      });
      expectRejected(fixture, /RELEASE_IMAGE_EXPOSED_PORTS/);
    }
  });

  it.skipIf(!inspectorExists)("rejects volumes and every unknown runtime config field", () => {
    for (const [field, value] of [
      ["Volumes", { "/tmp/uploads": {} }],
      ["Shell", ["/bin/sh", "-c"]],
      ["Healthcheck", { Test: ["CMD", "/nodejs/bin/node", "healthcheck.js"] }],
      ["OnBuild", ["RUN synthetic-unsafe-command"]],
      ["StopSignal", "SIGKILL"],
      ["UnreviewedRuntimeField", true],
    ] as const) {
      const fixture = makeOciFixture({
        mutateConfig: (config) => {
          const runtime = config.config as Record<string, unknown>;
          runtime[field] = value;
        },
      });
      expectRejected(fixture, /RELEASE_IMAGE_CONFIG/);
    }
  });

  it.skipIf(!inspectorExists)("rejects wrong or mutable release labels", () => {
    for (const [label, value] of [
      ["com.salamland.product-surface", "tasha"],
      ["org.opencontainers.image.revision", "b".repeat(64)],
      ["org.opencontainers.image.version", "latest"],
      ["org.opencontainers.image.source", `${expectedSource}/tree/main`],
    ] as const) {
      const fixture = makeOciFixture({
        mutateConfig: (config) => {
          const runtime = config.config as Record<string, unknown>;
          (runtime.Labels as Record<string, string>)[label] = value;
        },
      });
      expectRejected(fixture, /RELEASE_IMAGE_LABELS/);
    }
  });

  it.skipIf(!inspectorExists)("rejects forbidden source, test, docs, env, Git and cache paths", () => {
    for (const path of [
      "app/src/server/db.ts",
      "app/tests/runtime.test.js",
      "app/docs/runbook.md",
      "app/.env.production",
      "app/.git/config",
      "app/.next/cache/build.json",
      "app/unreviewed.txt",
    ]) {
      const fixture = makeOciFixture({
        layerEntries: [
          ...defaultLayerEntries(),
          { path, content: "forbidden", uid: 0, gid: 0 },
        ],
      });
      expectRejected(fixture, /RELEASE_IMAGE_FORBIDDEN_PATH/);
    }
  });

  it.skipIf(!inspectorExists)("rejects writable or incorrectly owned application files", () => {
    const writable = makeOciFixture({
      layerEntries: defaultLayerEntries().map((entry) =>
        entry.path === "app/server.js" ? { ...entry, mode: 0o666 } : entry,
      ),
    });
    expectRejected(writable, /RELEASE_IMAGE_APP_MODE/);

    const runtimeOwned = makeOciFixture({
      layerEntries: defaultLayerEntries().map((entry) =>
        entry.path === "app/server.js" ? { ...entry, uid: 65532, gid: 65532 } : entry,
      ),
    });
    expectRejected(runtimeOwned, /RELEASE_IMAGE_APP_OWNER/);

    const runtimeOwnedRoot = makeOciFixture({
      layerEntries: [
        { path: "app", type: "directory", mode: 0o755, uid: 65532, gid: 65532 },
        ...defaultLayerEntries(),
      ],
    });
    expectRejected(runtimeOwnedRoot, /RELEASE_IMAGE_APP_OWNER/);

    for (const mode of [0o4755, 0o2755, 0o1755]) {
      const privileged = makeOciFixture({
        layerEntries: defaultLayerEntries().map((entry) =>
          entry.path === "app/server.js" ? { ...entry, mode } : entry,
        ),
      });
      expectRejected(privileged, /RELEASE_IMAGE_APP_MODE/);
    }
  });

  it.skipIf(!inspectorExists)("rejects exact canary and credential content without logging values", () => {
    for (const content of [
      canary,
      "-----BEGIN OPENSSH PRIVATE KEY-----\nnot-real\n-----END OPENSSH PRIVATE KEY-----",
      "DATABASE_PASSWORD=synthetic-but-forbidden-value",
      "DATABASE_URL=postgresql://crm_user:synthetic-password@db.internal/crm",
      "postgresql://crm_user:synthetic-password@db.internal/crm",
      "API_KEY=synthetic-api-key-value",
      "AKIAIOSFODNN7EXAMPLE",
    ]) {
      const fixture = makeOciFixture({
        layerEntries: defaultLayerEntries().map((entry) =>
          entry.path === "app/server.js" ? { ...entry, content } : entry,
        ),
      });
      expectRejected(fixture, /RELEASE_IMAGE_SENSITIVE_CONTENT/);
    }

    const canaryPath = makeOciFixture({
      layerEntries: [
        ...defaultLayerEntries(),
        { path: `app/${canary}/leak.txt`, content: "blocked", uid: 0, gid: 0 },
      ],
    });
    expectRejected(canaryPath, /RELEASE_IMAGE_FORBIDDEN_PATH/);
  });

  it.skipIf(!inspectorExists)("accepts only exact fail-closed arguments", () => {
    const fixture = makeOciFixture();
    expectRejected(fixture, /RELEASE_IMAGE_ARGUMENTS/, { surface: "admin" });
    expectRejected(fixture, /RELEASE_IMAGE_ARGUMENTS/, { source: "main" });
    expectRejected(fixture, /RELEASE_IMAGE_ARGUMENTS/, { canary: "short" });
    expectRejected(fixture, /RELEASE_IMAGE_ARGUMENTS/, {
      extraArguments: ["--unknown", "value"],
    });
  });

  it.skipIf(!inspectorExists)("does not follow archive symlinks or overwrite output", () => {
    const fixture = makeOciFixture();
    const archiveLink = join(fixture.directory, "linked.oci.tar");
    symlinkSync(basename(fixture.archivePath), archiveLink);
    expectRejected(fixture, /RELEASE_IMAGE_ARCHIVE_PATH/, { archive: archiveLink });

    writeFileSync(fixture.outputPath, "reviewed\n", { flag: "wx" });
    const result = runInspector(fixture);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/RELEASE_IMAGE_OUTPUT_EXISTS/);
    expect(readFileSync(fixture.outputPath, "utf8")).toBe("reviewed\n");
  });

  it.skipIf(!inspectorExists)("writes only the canonical image-metadata filename", () => {
    const fixture = makeOciFixture();
    const alternate = join(fixture.directory, "other.json");
    expectRejected(fixture, /RELEASE_IMAGE_OUTPUT_PATH/, { output: alternate });
  });
});

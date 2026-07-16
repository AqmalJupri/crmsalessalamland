import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const referenceRoot = `${repositoryRoot}docs/design/reference/2026-07-16`;

const requiredArtifacts = [
  "REFERENCE.md",
  "fonts.json",
  "tasha-desktop-1440.png",
  "tasha-mobile-390.png",
  "tasya-unavailable.png",
  "tokens.json",
] as const;

const requiredTokens = {
  canvas: "#F8FAFC",
  surface: "#FFFFFF",
  sidebar: "#0B172A",
  sidebarRaised: "#1E293B",
  text: "#1E293B",
  muted: "#64748B",
  divider: "#E2E8F0",
  action: "#2563EB",
  actionHover: "#1D4ED8",
  brandAttention: "#F59E0B",
};

const requiredFontFiles = [
  {
    weight: 400,
    targetFilename: "inter-400.woff2",
    upstreamFilename: "docs/font-files/Inter-Regular.woff2",
    url: "https://raw.githubusercontent.com/rsms/inter/e3a3d4c57d5ecc01453a575621882a384c1995a3/docs/font-files/Inter-Regular.woff2",
    sizeBytes: 111268,
    sha256: "e06f6b1bc553aaea4e4668023ed0ab0a147129c3107f511bc7d03d361b0ae085",
  },
  {
    weight: 500,
    targetFilename: "inter-500.woff2",
    upstreamFilename: "docs/font-files/Inter-Medium.woff2",
    url: "https://raw.githubusercontent.com/rsms/inter/e3a3d4c57d5ecc01453a575621882a384c1995a3/docs/font-files/Inter-Medium.woff2",
    sizeBytes: 114348,
    sha256: "0ff3e94614e1493eb556314fd247ae6c4a85a7783b4cc86be539940cf83f2a48",
  },
  {
    weight: 600,
    targetFilename: "inter-600.woff2",
    upstreamFilename: "docs/font-files/Inter-SemiBold.woff2",
    url: "https://raw.githubusercontent.com/rsms/inter/e3a3d4c57d5ecc01453a575621882a384c1995a3/docs/font-files/Inter-SemiBold.woff2",
    sizeBytes: 114812,
    sha256: "5cb7103e4e605989afebc03d989c79201e54b21b5183db33981f70db9178a301",
  },
  {
    weight: 700,
    targetFilename: "inter-700.woff2",
    upstreamFilename: "docs/font-files/Inter-Bold.woff2",
    url: "https://raw.githubusercontent.com/rsms/inter/e3a3d4c57d5ecc01453a575621882a384c1995a3/docs/font-files/Inter-Bold.woff2",
    sizeBytes: 114840,
    sha256: "fa888127b6da015b65569f0351f3b5c391ad928904951f1c20e9f8462a8d95ea",
  },
] as const;

function readJson<T>(filename: string): T {
  return JSON.parse(readFileSync(`${referenceRoot}/${filename}`, "utf8")) as T;
}

function pngWidth(filename: string): number {
  const bytes = readFileSync(`${referenceRoot}/${filename}`);
  expect(bytes.subarray(0, 8)).toEqual(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );
  return bytes.readUInt32BE(16);
}

describe("Immutable UI reference pack", () => {
  it("locks the exact PRD 1.8 semantic token roles", () => {
    const tokens = readJson<{ captureDate: string; tokens: Record<string, string> }>(
      "tokens.json",
    );

    expect(tokens.captureDate).toBe("2026-07-16");
    expect(tokens.tokens).toEqual(requiredTokens);
  });

  it("records the reference caveat and irreversible privacy treatment", () => {
    const reference = readFileSync(`${referenceRoot}/REFERENCE.md`, "utf8");

    expect(reference).toContain("2026-07-16");
    expect(reference).toContain("https://tasha.salamland.my/");
    expect(reference).toContain("tasya.salamdev.my");
    expect(reference).toMatch(/redirect loop/i);
    expect(reference).toMatch(/not assumed to be the Tasha product/i);
    expect(reference).toMatch(/logged-out/i);
    expect(reference).toMatch(/irreversibly (redacted|sanitised)/i);
    expect(reference).toMatch(/PRD 1\.8/i);
    expect(reference).toMatch(/compact operational/i);
  });

  it("pins official Inter 4.1 files and their verified bytes", () => {
    const fonts = readJson<{
      family: string;
      license: {
        spdx: string;
        targetFilename: string;
        upstreamFilename: string;
        url: string;
        sizeBytes: number;
        sha256: string;
      };
      release: { tag: string; commit: string; url: string };
      fonts: typeof requiredFontFiles;
    }>("fonts.json");

    expect(fonts.family).toBe("Inter");
    expect(fonts.release).toMatchObject({
      tag: "v4.1",
      commit: "e3a3d4c57d5ecc01453a575621882a384c1995a3",
      url: "https://github.com/rsms/inter/releases/tag/v4.1",
    });
    expect(fonts.fonts).toEqual(requiredFontFiles);
    expect(fonts.license).toMatchObject({
      spdx: "OFL-1.1",
      targetFilename: "OFL.txt",
      upstreamFilename: "LICENSE.txt",
      url: "https://raw.githubusercontent.com/rsms/inter/e3a3d4c57d5ecc01453a575621882a384c1995a3/LICENSE.txt",
      sizeBytes: 4380,
      sha256: "262481e844521b326f5ecd053e59b98c8b2da78c8ee1bdbb6e8174305e54935a",
    });
  });

  it("commits privacy-safe evidence at the locked viewport widths", () => {
    expect(pngWidth("tasha-desktop-1440.png")).toBe(1440);
    expect(pngWidth("tasha-mobile-390.png")).toBe(390);
    expect(pngWidth("tasya-unavailable.png")).toBeGreaterThanOrEqual(390);
  });

  it("registers every artifact once without hashing the manifest itself", () => {
    const manifestPath = `${referenceRoot}/sha256.txt`;
    expect(existsSync(manifestPath)).toBe(true);

    const entries = new Map(
      readFileSync(manifestPath, "utf8")
        .trimEnd()
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const match = line.match(/^([a-f0-9]{64})  ([^/]+)$/);
          expect(match, `invalid SHA-256 manifest line: ${line}`).not.toBeNull();
          return [match?.[2] ?? "", match?.[1] ?? ""] as const;
        }),
    );

    expect([...entries.keys()]).toEqual(requiredArtifacts);
    expect(entries.has("sha256.txt")).toBe(false);

    const directoryFiles = readdirSync(referenceRoot).sort((a, b) =>
      Buffer.from(a).compare(Buffer.from(b)),
    );
    expect(directoryFiles).toEqual([...requiredArtifacts, "sha256.txt"].sort((a, b) =>
      Buffer.from(a).compare(Buffer.from(b)),
    ));

    for (const filename of requiredArtifacts) {
      const digest = createHash("sha256")
        .update(readFileSync(`${referenceRoot}/${filename}`))
        .digest("hex");
      expect(entries.get(filename), filename).toBe(digest);
    }
  });

  it("refuses an explicit request to hash the manifest into itself", () => {
    const hashScript = `${repositoryRoot}scripts/design/hash-reference-pack.mjs`;
    expect(existsSync(hashScript)).toBe(true);

    const result = spawnSync(process.execPath, [hashScript, "sha256.txt"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/refus.*sha256\.txt/i);
  });
});

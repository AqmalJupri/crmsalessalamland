import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const publicFontsRoot = `${repositoryRoot}public/fonts`;
const themeSource = readFileSync(`${repositoryRoot}src/styles/theme.css`, "utf8");
const productSource = readFileSync(`${repositoryRoot}src/styles/product.css`, "utf8");

const lockedFonts = [
  {
    weight: 400,
    filename: "inter-400.woff2",
    sizeBytes: 111268,
    sha256: "e06f6b1bc553aaea4e4668023ed0ab0a147129c3107f511bc7d03d361b0ae085",
  },
  {
    weight: 500,
    filename: "inter-500.woff2",
    sizeBytes: 114348,
    sha256: "0ff3e94614e1493eb556314fd247ae6c4a85a7783b4cc86be539940cf83f2a48",
  },
  {
    weight: 600,
    filename: "inter-600.woff2",
    sizeBytes: 114812,
    sha256: "5cb7103e4e605989afebc03d989c79201e54b21b5183db33981f70db9178a301",
  },
  {
    weight: 700,
    filename: "inter-700.woff2",
    sizeBytes: 114840,
    sha256: "fa888127b6da015b65569f0351f3b5c391ad928904951f1c20e9f8462a8d95ea",
  },
] as const;

const lockedLicense = {
  filename: "OFL.txt",
  sizeBytes: 4380,
  sha256: "262481e844521b326f5ecd053e59b98c8b2da78c8ee1bdbb6e8174305e54935a",
} as const;

function sha256(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

type ProductionSource = {
  path: string;
  source: string;
};

function productionSources(directory: string): ProductionSource[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__") return [];
      return productionSources(path);
    }
    if (/\.(?:test|spec)\./.test(entry.name)) return [];
    if (![".css", ".ts", ".tsx"].includes(extname(entry.name))) return [];
    return [
      {
        path: path.slice(repositoryRoot.length),
        source: readFileSync(path, "utf8"),
      },
    ];
  });
}

const remoteFontRequestPatterns = [
  /fonts\.(?:googleapis|gstatic)\.com/i,
  /next\/font\/google/i,
  /@import\s+(?:url\()?\s*["']?(?:https?:)?\/\//i,
  /url\(\s*["']?(?:https?:)?\/\//i,
  /new\s+FontFace\s*\([^,]+,\s*["'`]url\(\s*(?:https?:)?\/\//i,
  /WebFont\.load\s*\(/i,
  /<link\b(?=[^>]*\brel=["']stylesheet["'])(?=[^>]*\bhref=["'](?:https?:)?\/\/)[^>]*>/i,
  /<link\b(?=[^>]*\bas=["']font["'])(?=[^>]*\bhref=["'](?:https?:)?\/\/)[^>]*>/i,
] as const;

describe("Self-hosted Inter assets", () => {
  it("matches the four immutable official WOFF2 files", () => {
    for (const font of lockedFonts) {
      const path = `${publicFontsRoot}/${font.filename}`;
      expect(existsSync(path), font.filename).toBe(true);
      const bytes = readFileSync(path);

      expect(bytes.subarray(0, 4).toString("ascii"), font.filename).toBe("wOF2");
      expect(bytes.byteLength, font.filename).toBe(font.sizeBytes);
      expect(sha256(bytes), font.filename).toBe(font.sha256);
    }
  });

  it("declares exactly the locked local weights with swap rendering", () => {
    const faces = themeSource.match(/@font-face\s*\{[^}]+\}/g) ?? [];
    expect(faces).toHaveLength(lockedFonts.length);

    const declarations = faces.map((face) => ({
      weight: Number(face.match(/font-weight:\s*(\d+)/)?.[1]),
      url: face.match(/url\(["']?([^"')]+)["']?\)/)?.[1],
      source: face,
    }));

    expect(declarations.map(({ weight }) => weight).sort()).toEqual(
      lockedFonts.map(({ weight }) => weight),
    );

    for (const font of lockedFonts) {
      const face = declarations.find(({ weight }) => weight === font.weight);
      expect(face?.url, `${font.weight} local URL`).toBe(`/fonts/${font.filename}`);
      expect(face?.source, `${font.weight} family`).toMatch(/font-family:\s*["']Inter["']/);
      expect(face?.source, `${font.weight} format`).toMatch(/format\(["']woff2["']\)/);
      expect(face?.source, `${font.weight} display`).toMatch(/font-display:\s*swap/);
    }

    const implementationCss = `${themeSource.replace(/@font-face\s*\{[^}]+\}/g, "")}\n${productSource}`;
    const requestedWeights = [...implementationCss.matchAll(/font-weight:\s*(\d+)/g)].map(
      (match) => Number(match[1]),
    );
    expect(requestedWeights.every((weight) => [400, 500, 600, 700].includes(weight))).toBe(
      true,
    );
  });

  it("ships the locked OFL license", () => {
    const path = `${publicFontsRoot}/${lockedLicense.filename}`;
    expect(existsSync(path), lockedLicense.filename).toBe(true);
    const bytes = readFileSync(path);

    expect(bytes.byteLength).toBe(lockedLicense.sizeBytes);
    expect(sha256(bytes)).toBe(lockedLicense.sha256);
    expect(bytes.toString("utf8")).toMatch(/SIL OPEN FONT LICENSE Version 1\.1/);
  });

  it("uses local fonts without Google or runtime font requests", () => {
    const sources = productionSources(`${repositoryRoot}src`);
    expect(sources.map(({ path }) => path)).toEqual(
      expect.arrayContaining([
        "src/app/layout.tsx",
        "src/proxy.ts",
        "src/styles/product.css",
      ]),
    );

    for (const file of sources) {
      for (const pattern of remoteFontRequestPatterns) {
        expect(file.source, `${file.path} must not request a remote font`).not.toMatch(pattern);
      }
    }

    for (const remoteFontSource of [
      '@import url("https://fonts.example.test/inter.css");',
      '@font-face { src: url("https://fonts.example.test/inter.woff2"); }',
      'import { Inter } from "next/font/google";',
      'new FontFace("Inter", "url(https://fonts.example.test/inter.woff2)")',
      'WebFont.load({ google: { families: ["Inter"] } });',
      '<link rel="stylesheet" href="https://fonts.example.test/inter.css" />',
      '<link rel="preload" as="font" href="//fonts.example.test/inter.woff2" />',
    ]) {
      expect(
        remoteFontRequestPatterns.some((pattern) => pattern.test(remoteFontSource)),
        remoteFontSource,
      ).toBe(true);
    }
  });
});

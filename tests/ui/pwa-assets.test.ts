import { inflateSync } from "node:zlib";
import { existsSync, readFileSync, statSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import nextConfig from "../../next.config";
import { resetRuntimeConfigForTests } from "@/server/env";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const privateRobots = "noindex, nofollow, noarchive";
const offlineLine = "Aplikasi tidak tersedia di luar talian.";
const maskableSafeZone = "centered artwork within 80% diameter circle";
const oidcEnvironmentKeys = [
  "OIDC_ISSUER",
  "OIDC_CLIENT_ID",
  "OIDC_CLIENT_SECRET",
  "OIDC_REDIRECT_URI",
] as const;

const surfaces = {
  crm: { name: "Salam CRM", shortName: "Salam CRM", mark: "S" },
  tasha: { name: "Tasha", shortName: "Tasha", mark: "T" },
} as const;

const routeTitles = {
  "src/app/(crm)/page.tsx": "Utama",
  "src/app/(crm)/finance/page.tsx": "Kewangan",
  "src/app/(crm)/inventory/page.tsx": "Inventori",
  "src/app/(crm)/leads/page.tsx": "Lead",
  "src/app/(crm)/marketing/page.tsx": "Pemasaran",
  "src/app/(crm)/orders/page.tsx": "Pesanan",
  "src/app/(crm)/pipeline/page.tsx": "Pipeline",
  "src/app/(crm)/reports/page.tsx": "Laporan",
  "src/app/(crm)/settings/page.tsx": "Tetapan",
  "src/app/(crm)/tasks/page.tsx": "Tugasan",
  "src/app/(crm)/team/page.tsx": "Pasukan",
} as const;

interface PngChunk {
  data: Buffer;
  type: string;
}

interface PngDetails {
  bitDepth: number;
  chunks: readonly PngChunk[];
  colorType: number;
  height: number;
  width: number;
}

function assetPath(relativePath: string): string {
  return `${repositoryRoot}${relativePath}`;
}

function readPng(relativePath: string): PngDetails {
  const bytes = readFileSync(assetPath(relativePath));
  expect(bytes.subarray(0, 8), relativePath).toEqual(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );

  const chunks: PngChunk[] = [];
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    expect(dataEnd + 4, `${relativePath}:${type}`).toBeLessThanOrEqual(bytes.length);
    chunks.push({ type, data: bytes.subarray(dataStart, dataEnd) });
    offset = dataEnd + 4;
    if (type === "IEND") break;
  }

  const ihdr = chunks.find((chunk) => chunk.type === "IHDR")?.data;
  expect(ihdr, `${relativePath}:IHDR`).toBeDefined();
  expect(chunks.at(-1)?.type, `${relativePath}:IEND`).toBe("IEND");

  return {
    width: ihdr?.readUInt32BE(0) ?? 0,
    height: ihdr?.readUInt32BE(4) ?? 0,
    bitDepth: ihdr?.readUInt8(8) ?? 0,
    colorType: ihdr?.readUInt8(9) ?? 0,
    chunks,
  };
}

function readUnfilteredRgba(details: PngDetails, relativePath: string): Buffer {
  expect(details.bitDepth, relativePath).toBe(8);
  expect(details.colorType, relativePath).toBe(6);
  const compressed = Buffer.concat(
    details.chunks.filter((chunk) => chunk.type === "IDAT").map((chunk) => chunk.data),
  );
  const scanlines = inflateSync(compressed);
  const rowLength = details.width * 4 + 1;
  expect(scanlines.length, relativePath).toBe(rowLength * details.height);

  const pixels = Buffer.alloc(details.width * details.height * 4);
  for (let y = 0; y < details.height; y += 1) {
    const rowStart = y * rowLength;
    expect(scanlines[rowStart], `${relativePath}:filter:${y}`).toBe(0);
    scanlines.copy(
      pixels,
      y * details.width * 4,
      rowStart + 1,
      rowStart + rowLength,
    );
  }
  return pixels;
}

function textMetadata(details: PngDetails): Map<string, string> {
  return new Map(
    details.chunks
      .filter((chunk) => chunk.type === "tEXt")
      .map((chunk) => {
        const separator = chunk.data.indexOf(0);
        expect(separator).toBeGreaterThan(0);
        return [
          chunk.data.toString("latin1", 0, separator),
          chunk.data.toString("latin1", separator + 1),
        ] as const;
      }),
  );
}

function setRuntimeSurface(surface: keyof typeof surfaces): void {
  const environment = {
    NODE_ENV: "test",
    PRODUCT_SURFACE: surface,
    DEPLOYMENT_ENVIRONMENT: "local",
    DATABASE_URL: "postgresql://crm:crm@localhost:5432/crm",
    APP_URL: "http://localhost:3000",
    CRM_DEMO_MODE: "true",
    AUTH_HASH_KEY: "test-auth-hash-key-that-is-at-least-32-characters",
  } as const;

  for (const key of oidcEnvironmentKeys) vi.stubEnv(key, undefined);
  for (const [key, value] of Object.entries(environment)) vi.stubEnv(key, value);
  resetRuntimeConfigForTests();
}

afterEach(() => {
  resetRuntimeConfigForTests();
  vi.unstubAllEnvs();
});

describe("host-specific private metadata", () => {
  for (const [surface, expected] of Object.entries(surfaces) as [
    keyof typeof surfaces,
    (typeof surfaces)[keyof typeof surfaces],
  ][]) {
    it(`uses the explicit ${surface} surface for root metadata`, async () => {
      setRuntimeSurface(surface);
      const { generateMetadata, viewport } = await import("@/app/layout");

      expect(generateMetadata()).toEqual({
        title: {
          default: expected.name,
          template: `%s · ${expected.name}`,
        },
        robots: privateRobots,
        manifest: "/manifest.webmanifest",
        icons: {
          icon: [
            {
              url: `/icons/${surface}-favicon.ico`,
              type: "image/x-icon",
            },
          ],
          apple: [
            {
              url: `/icons/${surface}-apple-touch-icon.png`,
              sizes: "180x180",
              type: "image/png",
            },
          ],
        },
      });
      expect(generateMetadata()).not.toHaveProperty("description");
      expect(viewport).toMatchObject({ colorScheme: "light", themeColor: "#0B172A" });
    });

    it(`uses the exact ${surface} manifest contract`, async () => {
      setRuntimeSurface(surface);
      const { default: manifest } = await import("@/app/manifest");

      expect(manifest()).toEqual({
        name: expected.name,
        short_name: expected.shortName,
        lang: "ms",
        start_url: "/",
        scope: "/",
        display: "standalone",
        background_color: "#F8FAFC",
        theme_color: "#0B172A",
        icons: [
          {
            src: `/icons/${surface}-192.png`,
            sizes: "192x192",
            type: "image/png",
            purpose: "any",
          },
          {
            src: `/icons/${surface}-512.png`,
            sizes: "512x512",
            type: "image/png",
            purpose: "any",
          },
          {
            src: `/icons/${surface}-maskable-512.png`,
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      });
    });
  }

  it("uses fixed PII-free navigation nouns for every protected route", () => {
    for (const [relativePath, title] of Object.entries(routeTitles)) {
      const source = readFileSync(assetPath(relativePath), "utf8");
      expect(source, relativePath).toContain('import type { Metadata } from "next";');
      expect(source, relativePath).toContain(
        `export const metadata: Metadata = { title: "${title}" };`,
      );
    }
  });

  it("mounts one registration and retains the Malay/light root shell", () => {
    const source = readFileSync(assetPath("src/app/layout.tsx"), "utf8");
    expect(source.match(/<ServiceWorkerRegistration\s*\/>/g)).toHaveLength(1);
    expect(source).toContain('<html lang="ms">');
    expect(source).not.toContain("description:");
  });

  it("adds the exact private robots header to the global response rule", async () => {
    const rules = await nextConfig.headers?.();
    expect(rules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "/(.*)",
          headers: expect.arrayContaining([
            { key: "X-Robots-Tag", value: privateRobots },
          ]),
        }),
      ]),
    );
  });
});

describe("deterministic surface assets", () => {
  for (const surface of Object.keys(surfaces) as (keyof typeof surfaces)[]) {
    it(`ships exact ${surface} standard icon dimensions`, () => {
      expect(readPng(`public/icons/${surface}-192.png`)).toMatchObject({
        width: 192,
        height: 192,
      });
      expect(readPng(`public/icons/${surface}-512.png`)).toMatchObject({
        width: 512,
        height: 512,
      });
    });

    it(`keeps the ${surface} maskable artwork inside the declared safe zone`, () => {
      const relativePath = `public/icons/${surface}-maskable-512.png`;
      const details = readPng(relativePath);
      expect(details).toMatchObject({ width: 512, height: 512 });
      expect(textMetadata(details).get("maskable-safe-zone")).toBe(maskableSafeZone);

      const pixels = readUnfilteredRgba(details, relativePath);
      const center = details.width / 2;
      const safeRadius = details.width * 0.4;
      let artworkPixels = 0;

      for (let y = 0; y < details.height; y += 1) {
        for (let x = 0; x < details.width; x += 1) {
          const offset = (y * details.width + x) * 4;
          const isNavy =
            pixels[offset] === 0x0b &&
            pixels[offset + 1] === 0x17 &&
            pixels[offset + 2] === 0x2a &&
            pixels[offset + 3] === 0xff;
          if (isNavy) continue;

          artworkPixels += 1;
          expect(Math.hypot(x + 0.5 - center, y + 0.5 - center), `${x},${y}`).toBeLessThanOrEqual(
            safeRadius,
          );
        }
      }
      expect(artworkPixels).toBeGreaterThan(1_000);
    });

    it(`ships non-empty ${surface} Apple and favicon assets`, () => {
      const apple = `public/icons/${surface}-apple-touch-icon.png`;
      const favicon = `public/icons/${surface}-favicon.ico`;
      expect(existsSync(assetPath(apple))).toBe(true);
      expect(statSync(assetPath(apple)).size).toBeGreaterThan(100);
      expect(readPng(apple)).toMatchObject({ width: 180, height: 180 });
      expect(existsSync(assetPath(favicon))).toBe(true);
      expect(statSync(assetPath(favicon)).size).toBeGreaterThan(100);
      expect(readFileSync(assetPath(favicon)).subarray(0, 4)).toEqual(
        Buffer.from([0x00, 0x00, 0x01, 0x00]),
      );
    });
  }
});

interface WorkerRequest {
  mode: string;
  url: string;
}

interface WorkerFetchEvent {
  request: WorkerRequest;
  respondWith(response: Promise<Response>): void;
}

function loadFetchListener(fetchImplementation: ReturnType<typeof vi.fn>) {
  const source = readFileSync(assetPath("public/sw.js"), "utf8");
  let listener: ((event: WorkerFetchEvent) => void) | undefined;
  const worker = {
    addEventListener(type: string, candidate: unknown) {
      if (type === "fetch") listener = candidate as (event: WorkerFetchEvent) => void;
    },
    clients: { claim: vi.fn() },
    skipWaiting: vi.fn(),
  };

  runInNewContext(source, { Response, fetch: fetchImplementation, self: worker });
  expect(listener).toBeDefined();

  return (request: WorkerRequest): Promise<Response> => {
    let response: Promise<Response> | undefined;
    listener?.({
      request,
      respondWith(candidate) {
        response = candidate;
      },
    });
    expect(response).toBeDefined();
    return response ?? Promise.reject(new Error("Worker did not provide a response."));
  };
}

describe("no-store service worker", () => {
  it("contains no CacheStorage access", () => {
    const source = readFileSync(assetPath("public/sw.js"), "utf8");
    expect(source).not.toMatch(/\bcaches\b|CacheStorage|cache\.(?:match|put)|caches\.open/);
  });

  it.each([
    ["navigation", { mode: "navigate", url: "https://crm.salamland.my/" }],
    ["API", { mode: "cors", url: "https://crm.salamland.my/api/v1/leads" }],
    ["file", { mode: "same-origin", url: "https://crm.salamland.my/files/document.pdf" }],
    ["asset", { mode: "no-cors", url: "https://crm.salamland.my/_next/app.js" }],
  ])("always fetches a %s request with no-store", async (_label, request) => {
    const networkResponse = new Response("network");
    const fetchImplementation = vi.fn().mockResolvedValue(networkResponse);
    const dispatch = loadFetchListener(fetchImplementation);

    await expect(dispatch(request)).resolves.toBe(networkResponse);
    expect(fetchImplementation).toHaveBeenCalledOnce();
    expect(fetchImplementation).toHaveBeenCalledWith(request, { cache: "no-store" });
  });

  it("returns only the private Malay fallback when navigation fails", async () => {
    const fetchImplementation = vi.fn().mockRejectedValue(new TypeError("offline"));
    const dispatch = loadFetchListener(fetchImplementation);

    const response = await dispatch({
      mode: "navigate",
      url: "https://crm.salamland.my/leads/private-record",
    });
    const body = await response.text();

    expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Robots-Tag")).toBe(privateRobots);
    expect(response.headers.get("Content-Security-Policy")).toBe(
      "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'",
    );
    expect(body).toContain('<meta name="robots" content="noindex,nofollow,noarchive">');
    expect(body).toContain(offlineLine);
    expect(body).not.toContain("private-record");
    expect(body).not.toMatch(/lead|rekod|pengguna|metrik|baris gilir|cuba lagi/i);
  });

  it("does not replace a failed non-navigation request with HTML", async () => {
    const error = new TypeError("offline");
    const dispatch = loadFetchListener(vi.fn().mockRejectedValue(error));
    await expect(
      dispatch({ mode: "cors", url: "https://crm.salamland.my/api/v1/leads" }),
    ).rejects.toBe(error);
  });
});

describe("safe offline page", () => {
  it("renders exactly one context-free Malay line", async () => {
    const { default: OfflinePage } = await import("@/app/offline/page");
    const markup = renderToStaticMarkup(createElement(OfflinePage));
    const visibleText = markup.replace(/<[^>]*>/g, "").trim();

    expect(visibleText).toBe(offlineLine);
    expect(visibleText).not.toMatch(/rekod|pengguna|https?:|metrik|baris gilir|cuba lagi/i);
  });
});

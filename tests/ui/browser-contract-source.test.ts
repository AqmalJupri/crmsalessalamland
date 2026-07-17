import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");

function source(relativePath: string): string {
  return readFileSync(resolve(repositoryRoot, relativePath), "utf8");
}

describe("B1 browser contract sources", () => {
  it("ignores only generated Playwright output, not committed snapshots", () => {
    const ignoreLines = source(".gitignore")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));

    expect(ignoreLines).toContain(".playwright/");
    expect(ignoreLines.some((line) => line.includes("__snapshots__"))).toBe(false);
  });

  it.each([
    ["tests/e2e/crm.spec.ts", 8],
    ["tests/e2e/task6-ui.spec.ts", 4],
  ] as const)("keeps every CRM test in %s behind one file-level surface gate", (path, count) => {
    const specSource = source(path);
    const gateIndex = specSource.search(
      /test\.skip\(\s*process\.env\.E2E_PRODUCT_SURFACE\s*!==\s*["']crm["']/,
    );
    const firstTestIndex = specSource.search(/^test\(["']/m);

    expect(gateIndex).toBeGreaterThan(-1);
    expect(gateIndex).toBeLessThan(firstTestIndex);
    expect(specSource.match(/^test\(/gm)).toHaveLength(count);
  });

  it("consolidates all state checks in one surface-neutral suite", () => {
    const currentPath = resolve(repositoryRoot, "tests/e2e/ui-states.spec.ts");
    expect(existsSync(currentPath)).toBe(true);
    expect(existsSync(resolve(repositoryRoot, "tests/e2e/task7-states.spec.ts"))).toBe(false);
    if (!existsSync(currentPath)) return;

    const specSource = readFileSync(currentPath, "utf8");
    for (const kind of [
      "loading", "empty", "filtered-empty", "stale", "syncing", "queued", "partial",
      "success", "failed", "conflict", "offline", "forbidden", "unknown",
    ]) {
      expect(specSource).toContain(`"${kind}"`);
    }
    expect(specSource).toContain('locator("svg")).toHaveAttribute("aria-hidden", "true")');
    expect(specSource).toContain('getByRole("status")).toHaveCount(5)');
    expect(specSource).toContain('getByRole("alert")).toHaveCount(4)');
    expect(specSource).toContain('getByRole("region")).toHaveCount(4)');
    expect(specSource).toContain("document.documentElement.scrollWidth");
    expect(specSource).toContain("new AxeBuilder({ page }).analyze()");
    expect(specSource).not.toContain("E2E_PRODUCT_SURFACE");
  });

  it("keeps a service-worker-free dual-surface route, metadata, manifest, axe, and overflow suite", () => {
    const contractPath = resolve(repositoryRoot, "tests/e2e/ui-contract.spec.ts");
    expect(existsSync(contractPath)).toBe(true);
    if (!existsSync(contractPath)) return;

    const specSource = readFileSync(contractPath, "utf8");
    for (const requiredSource of [
      'test.use({ serviceWorkers: "block" })',
      "process.env.E2E_PRODUCT_SURFACE",
      "expectNoHorizontalOverflow",
      "expectNoCriticalOrSeriousAxeViolations",
      '"/login"',
      '"Akses ditolak"',
      '"Halaman tidak ditemui"',
      '"/manifest.webmanifest"',
      "start_url",
      "icons",
      '"Lead"',
      '"Pipeline"',
      '"Integrasi"',
      '"Inventori"',
      '"Pesanan"',
      '"Kewangan"',
      '"Tugasan"',
      '"Laporan"',
      '"Tetapan"',
    ]) {
      expect(specSource).toContain(requiredSource);
    }
    expect(specSource).toMatch(/value\s*!==\s*["']crm["']\s*&&\s*value\s*!==\s*["']tasha["']/);
  });
});

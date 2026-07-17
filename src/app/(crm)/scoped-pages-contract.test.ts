import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const pages = [
  ["page.tsx", undefined],
  ["finance/page.tsx", "finance"],
  ["inventory/page.tsx", "inventory"],
  ["leads/page.tsx", "leads"],
  ["marketing/page.tsx", "marketing"],
  ["orders/page.tsx", "orders"],
  ["pipeline/page.tsx", "pipeline"],
  ["reports/page.tsx", "reports"],
  ["settings/page.tsx", "settings"],
  ["tasks/page.tsx", "tasks"],
  ["team/page.tsx", "team"],
] as const;

describe("scoped page source contract", () => {
  it.each(pages)("keeps %s behind the query-aware scope helper", (relativePath, moduleKey) => {
    const source = readFileSync(resolve(__dirname, relativePath), "utf8");

    expect(source).toContain("requireScopedPageViewer");
    expect(source).toMatch(/searchParams\s*:\s*Promise</);
    expect(source).toMatch(/const query = await searchParams/);
    expect(source).toMatch(/requireScopedPageViewer\([\s\S]*?query\.bu[\s\S]*?query[\s\S]*?\)/);
    expect(source).not.toMatch(/searchParams.*get\(["']bu["']\)/s);
    expect(source).not.toMatch(/Array\.isArray\([^)]*bu/);
    expect(source).not.toMatch(/viewer\.businessUnitId/);
    if (moduleKey) {
      expect(source).toContain(`CRM_MODULE_ACCESS.${moduleKey}.capability`);
      expect(source).toContain(`"/${moduleKey}"`);
    }
  });

  it("reduces every module layout to the immutable surface boundary", () => {
    for (const [, moduleKey] of pages) {
      if (!moduleKey) continue;
      const source = readFileSync(resolve(__dirname, moduleKey, "layout.tsx"), "utf8");
      expect(source).toContain(`createCrmModuleLayout("${moduleKey}")`);
      expect(source).not.toContain("requirePageViewer");
      expect(source).not.toContain("getViewer");
    }
  });
});

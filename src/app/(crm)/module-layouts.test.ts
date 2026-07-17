import { readFile, readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CRM_MODULE_ACCESS } from "@/server/auth/module-access";

describe("protected CRM module layouts", () => {
  it("has one immutable surface boundary for every declared module route", async () => {
    const crmRoot = resolve(process.cwd(), "src/app/(crm)");

    for (const moduleKey of Object.keys(CRM_MODULE_ACCESS)) {
      const layoutPath = resolve(crmRoot, moduleKey, "layout.tsx");
      await expect(stat(layoutPath)).resolves.toMatchObject({});
      await expect(readFile(layoutPath, "utf8")).resolves.toContain(
        `createCrmModuleLayout("${moduleKey}")`,
      );
    }
  });

  it("keeps the access map exhaustive for every first-level CRM page", async () => {
    const crmRoot = resolve(process.cwd(), "src/app/(crm)");
    const routeKeys: string[] = [];

    for (const entry of await readdir(crmRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        await stat(resolve(crmRoot, entry.name, "page.tsx"));
        routeKeys.push(entry.name);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }

    expect(routeKeys.sort()).toEqual(Object.keys(CRM_MODULE_ACCESS).sort());
    const rootPage = await readFile(resolve(crmRoot, "page.tsx"), "utf8");
    expect(rootPage).toContain("requireScopedPageViewer");
    expect(rootPage).toContain("const query = await searchParams");
    expect(rootPage).toContain("query.bu");
    expect(rootPage).toMatch(/requireScopedPageViewer\([\s\S]*?undefined,[\s\S]*?["']\/["']/);
    expect(rootPage).not.toContain("requirePageViewer");
  });
});

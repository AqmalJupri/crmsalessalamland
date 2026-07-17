import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getProductNavigationSections } from "@/config/product-navigation";

const mocks = vi.hoisted(() => ({ notFound: vi.fn() }));

vi.mock("next/navigation", () => ({ notFound: mocks.notFound }));

import OperationStatesPage, { canRenderOperationStateGallery } from "./page";

const originalEnvironment = { ...process.env };

type GalleryEnvironmentOverrides = Partial<Record<
  "CRM_DEMO_MODE" | "DEPLOYMENT_ENVIRONMENT" | "NODE_ENV",
  string | undefined
>>;

function useGalleryEnvironment(overrides: GalleryEnvironmentOverrides = {}): void {
  const environment: Record<string, string | undefined> = { ...originalEnvironment };
  environment.NODE_ENV = "test";
  environment.CRM_DEMO_MODE = "true";
  environment.DEPLOYMENT_ENVIRONMENT = "ci";
  Object.assign(environment, overrides);
  process.env = environment as NodeJS.ProcessEnv;
}

beforeEach(() => {
  useGalleryEnvironment();
  mocks.notFound.mockReset();
  mocks.notFound.mockImplementation(() => {
    throw new Error("not-found");
  });
});

afterEach(() => {
  process.env = { ...originalEnvironment };
});

describe("synthetic operation-state gallery", () => {
  it.each([
    ["production", { NODE_ENV: "production" }],
    ["staging", { DEPLOYMENT_ENVIRONMENT: "staging" }],
    ["non-demo", { CRM_DEMO_MODE: "false" }],
    ["non-exact demo", { CRM_DEMO_MODE: "TRUE" }],
    ["unknown environment", { DEPLOYMENT_ENVIRONMENT: "preview" }],
    ["missing environment", { DEPLOYMENT_ENVIRONMENT: undefined }],
    ["unknown node environment", { NODE_ENV: "preview" }],
    ["missing node environment", { NODE_ENV: undefined }],
  ])("fails closed in %s", (_label, overrides) => {
    useGalleryEnvironment(overrides);

    expect(canRenderOperationStateGallery(process.env)).toBe(false);
    expect(() => OperationStatesPage()).toThrow("not-found");
    expect(mocks.notFound).toHaveBeenCalledOnce();
  });

  it.each(["local", "ci"] as const)(
    "allows only an explicit non-production demo %s environment",
    (deploymentEnvironment) => {
      useGalleryEnvironment({ DEPLOYMENT_ENVIRONMENT: deploymentEnvironment });
      expect(canRenderOperationStateGallery(process.env)).toBe(true);
    },
  );

  it("renders one fixed synthetic instance of every state", () => {
    const html = renderToStaticMarkup(OperationStatesPage());
    const stateKinds = Array.from(html.matchAll(/data-state-kind="([^"]+)"/g), (match) => match[1]);

    expect(stateKinds).toEqual([
      "loading",
      "empty",
      "filtered-empty",
      "stale",
      "syncing",
      "queued",
      "partial",
      "success",
      "failed",
      "conflict",
      "offline",
      "forbidden",
      "unknown",
    ]);
    expect(html).toContain("Bayaran Pesanan SL-TEST-001 gagal");
    expect(html).toContain("Rujukan bank ditolak oleh sistem");
    expect(html).toContain("Semak rekod bayaran dan rujukan bank sebelum cuba semula");
    expect(html).toContain(
      "Selepas talian pulih, semak rekod atau status terkini sebelum cuba semula",
    );
    expect(html).not.toContain("Sambung semula dan cuba lagi");
    expect(html).not.toMatch(/<form|<input|<textarea|<select/i);
  });

  it("has no request, query, body, database, or session boundary", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/app/__ui-test__/states/page.tsx"),
      "utf8",
    );

    expect(OperationStatesPage.length).toBe(0);
    expect(source).not.toMatch(/searchParams|Request\b|FormData|next\/headers|cookies\s*\(|headers\s*\(/);
    expect(source).not.toMatch(/@\/server\/|getViewer|getSession|database|\bdb\b/i);
  });

  it("guards with notFound before any state render path", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/app/__ui-test__/states/page.tsx"),
      "utf8",
    );
    const guardIndex = source.indexOf("if (!canRenderOperationStateGallery(process.env)) notFound()");
    const firstStateIndex = source.indexOf("<OperationState key=");

    expect(guardIndex).toBeGreaterThan(-1);
    expect(firstStateIndex).toBeGreaterThan(guardIndex);
  });

  it("exposes the guarded page through Next's encoded underscore route", () => {
    const routeSource = readFileSync(
      resolve(process.cwd(), "src/app/%5F_ui-test__/states/page.tsx"),
      "utf8",
    );

    expect(routeSource).toContain('export { default } from "@/app/__ui-test__/states/page"');
    expect(routeSource).not.toContain("OperationState");
  });

  it.each(["crm", "tasha"] as const)(
    "never exposes the gallery in %s navigation",
    (surface) => {
      const hrefs = getProductNavigationSections(surface)
        .flatMap((section) => section.items)
        .map((item) => item.href);

      expect(hrefs).not.toContain("/__ui-test__/states");
      expect(hrefs.every((href) => !href.startsWith("/__ui-test__"))).toBe(true);
    },
  );
});

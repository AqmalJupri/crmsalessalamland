/** @vitest-environment jsdom */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ForbiddenPage from "./forbidden";
import NotFound from "./not-found";

const notFoundSource = readFileSync(resolve(process.cwd(), "src/app/not-found.tsx"), "utf8");

const runtimeOnlyEnvironmentKeys = [
  "APP_URL",
  "AUTH_HASH_KEY",
  "DATABASE_URL",
  "DEPLOYMENT_ENVIRONMENT",
  "OIDC_ISSUER",
  "OIDC_CLIENT_ID",
  "OIDC_CLIENT_SECRET",
  "OIDC_REDIRECT_URI",
] as const;

function setPublicSurface(surface: "crm" | "tasha"): void {
  for (const key of runtimeOnlyEnvironmentKeys) vi.stubEnv(key, undefined);
  vi.stubEnv("PRODUCT_SURFACE", undefined);
  vi.stubEnv("CRM_BUILD_SURFACE", surface);
}

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe("surface error pages", () => {
  beforeEach(() => {
    document.title = "";
    setPublicSurface("tasha");
  });

  it("renders a compact surface-aware forbidden recovery path without runtime secrets", () => {
    const { container } = render(createElement(ForbiddenPage));

    expect(screen.getByText("Tasha")).toBeTruthy();
    expect(container.querySelector(".crm-login-card__mark")?.textContent).toBe("T");
    expect(screen.getByRole("heading", { name: "Akses ditolak" })).toBeTruthy();
    expect(screen.getByText("Anda tiada akses ke modul ini.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Ke utama" }).getAttribute("href")).toBe("/");
    expect(screen.queryByText(/kebenaran untuk membuka/)).toBeNull();
    expect(document.title).toBe("Akses ditolak · Tasha");
  });

  it("renders a compact surface-aware not-found recovery path without runtime secrets", () => {
    const { container } = render(createElement(NotFound));

    expect(screen.getByText("Tasha")).toBeTruthy();
    expect(container.querySelector(".crm-login-card__mark")?.textContent).toBe("T");
    expect(screen.getByRole("heading", { name: "Halaman tidak ditemui" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Ke utama" }).getAttribute("href")).toBe("/");
    expect(notFoundSource).toContain(
      'export const metadata: Metadata = { title: "Halaman tidak ditemui" };',
    );
  });

  it("keeps the CRM brand when the runtime surface is CRM", () => {
    setPublicSurface("crm");

    render(createElement(ForbiddenPage));

    expect(screen.getByText("Salam CRM")).toBeTruthy();
    expect(document.title).toBe("Akses ditolak · Salam CRM");
  });
});

/** @vitest-environment jsdom */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetRuntimeConfigForTests } from "@/server/env";

import LoginPage, { metadata } from "./page";

const optionalOidcEnvironmentKeys = [
  "OIDC_ISSUER",
  "OIDC_CLIENT_ID",
  "OIDC_CLIENT_SECRET",
  "OIDC_REDIRECT_URI",
] as const;

function setRuntimeSurface(surface: "crm" | "tasha"): void {
  for (const key of optionalOidcEnvironmentKeys) vi.stubEnv(key, undefined);
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("CRM_BUILD_SURFACE", surface);
  vi.stubEnv("PRODUCT_SURFACE", surface);
  vi.stubEnv("DEPLOYMENT_ENVIRONMENT", "local");
  vi.stubEnv("DATABASE_URL", "postgresql://crm:crm@127.0.0.1:5432/crm_salam_test_login");
  vi.stubEnv("APP_URL", "http://127.0.0.1:3000");
  vi.stubEnv("CRM_DEMO_MODE", "true");
  vi.stubEnv("AUTH_HASH_KEY", "test-auth-hash-key-at-least-32-characters");
  resetRuntimeConfigForTests();
}

afterEach(() => {
  cleanup();
  resetRuntimeConfigForTests();
  vi.unstubAllEnvs();
});

describe("LoginPage", () => {
  beforeEach(() => {
    setRuntimeSurface("crm");
  });

  it("uses the validated CRM runtime and preserves a safe deep return path", async () => {
    const { container } = render(
      await LoginPage({
        searchParams: Promise.resolve({ returnTo: "/finance?tab=aging#overdue" }),
      }),
    );

    expect(metadata).toEqual({ title: "Log masuk" });
    expect(screen.getByText("Salam CRM")).toBeTruthy();
    expect(
      screen
        .getByRole("heading", { level: 1, name: "Log masuk" })
        .classList.contains("crm-visually-hidden"),
    ).toBe(true);
    expect(container.querySelector(".crm-login-card__mark")?.textContent).toBe("S");
    expect(screen.getByRole("link", { name: "Log masuk" }).getAttribute("href")).toBe(
      "/api/v1/auth/oidc/start?returnTo=%2Ffinance%3Ftab%3Daging%23overdue",
    );
  });

  it("uses the validated Tasha runtime and rejects an external return target", async () => {
    setRuntimeSurface("tasha");
    const { container } = render(
      await LoginPage({
        searchParams: Promise.resolve({ returnTo: "https://evil.example/steal" }),
      }),
    );

    expect(screen.getByText("Tasha")).toBeTruthy();
    expect(container.querySelector(".crm-login-card__mark")?.textContent).toBe("T");
    expect(screen.getByRole("link", { name: "Log masuk" }).getAttribute("href")).toBe(
      "/api/v1/auth/oidc/start?returnTo=%2F",
    );
  });

  it("fails closed instead of rendering a working-looking login without runtime secrets", async () => {
    vi.stubEnv("DATABASE_URL", undefined);
    vi.stubEnv("APP_URL", undefined);
    vi.stubEnv("AUTH_HASH_KEY", undefined);
    resetRuntimeConfigForTests();

    await expect(LoginPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(
      /Invalid runtime configuration/,
    );
  });
});

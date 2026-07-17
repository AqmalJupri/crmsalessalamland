/** @vitest-environment jsdom */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getRuntimeConfig: vi.fn() }));

vi.mock("@/server/env", () => ({
  getRuntimeConfig: mocks.getRuntimeConfig,
}));

import LoginPage, { metadata } from "./page";

afterEach(cleanup);

describe("LoginPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getRuntimeConfig.mockReturnValue({ productSurface: "crm" });
  });

  it("uses the runtime CRM brand and preserves a safe deep return path", async () => {
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

  it("uses the runtime Tasha brand and rejects an external return target", async () => {
    mocks.getRuntimeConfig.mockReturnValue({ productSurface: "tasha" });
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
});

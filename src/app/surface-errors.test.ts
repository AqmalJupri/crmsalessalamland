/** @vitest-environment jsdom */

import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getRuntimeConfig: vi.fn() }));

vi.mock("@/server/env", () => ({
  getRuntimeConfig: mocks.getRuntimeConfig,
}));

import ForbiddenPage from "./forbidden";
import NotFound from "./not-found";

afterEach(cleanup);

describe("surface error pages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getRuntimeConfig.mockReturnValue({ productSurface: "tasha" });
  });

  it("renders a compact surface-aware forbidden recovery path", () => {
    const { container } = render(createElement(ForbiddenPage));

    expect(screen.getByText("Tasha")).toBeTruthy();
    expect(container.querySelector(".crm-login-card__mark")?.textContent).toBe("T");
    expect(screen.getByRole("heading", { name: "Akses ditolak" })).toBeTruthy();
    expect(screen.getByText("Anda tiada akses ke modul ini.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Ke utama" }).getAttribute("href")).toBe("/");
    expect(screen.queryByText(/kebenaran untuk membuka/)).toBeNull();
  });

  it("renders a compact surface-aware not-found recovery path", () => {
    const { container } = render(createElement(NotFound));

    expect(screen.getByText("Tasha")).toBeTruthy();
    expect(container.querySelector(".crm-login-card__mark")?.textContent).toBe("T");
    expect(screen.getByRole("heading", { name: "Halaman tidak ditemui" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Ke utama" }).getAttribute("href")).toBe("/");
  });

  it("keeps the CRM brand when the runtime surface is CRM", () => {
    mocks.getRuntimeConfig.mockReturnValue({ productSurface: "crm" });

    render(createElement(ForbiddenPage));

    expect(screen.getByText("Salam CRM")).toBeTruthy();
  });
});

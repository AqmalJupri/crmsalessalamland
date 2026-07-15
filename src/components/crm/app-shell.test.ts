/** @vitest-environment jsdom */

import { createElement, type ComponentType } from "react";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LayoutDashboard } from "lucide-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppShell, type AppShellProps } from "./app-shell";

const AppShellWithPositionalChildren = AppShell as ComponentType<
  Omit<AppShellProps, "children">
>;

function renderShell() {
  return render(
    createElement(
      AppShellWithPositionalChildren,
      {
        title: "Utama",
        navigation: [{ items: [{ label: "Utama", href: "/", icon: LayoutDashboard }] }],
      },
      createElement("button", { type: "button" }, "Kandungan luar"),
    ),
  );
}

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({
      matches: false,
      media: "(min-width: 901px)",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
  vi.stubGlobal(
    "requestAnimationFrame",
    (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AppShell mobile drawer", () => {
  it("makes every background shell region inert and hidden while the drawer is open", async () => {
    const user = userEvent.setup();
    const { container } = renderShell();
    const menuButton = screen.getByRole("button", { name: "Buka menu navigasi" });

    await user.click(menuButton);

    expect(screen.getByRole("dialog", { name: "Navigasi utama" })).toBeTruthy();
    for (const selector of [
      ".crm-skip-link",
      ".crm-shell__desktop-sidebar",
      ".crm-shell__workspace",
    ]) {
      const region = container.querySelector(selector);
      expect(region?.hasAttribute("inert"), selector).toBe(true);
      expect(region?.getAttribute("aria-hidden"), selector).toBe("true");
    }
  });

  it("recaptures escaped focus and restores the menu opener after close", async () => {
    const user = userEvent.setup();
    const { container } = renderShell();
    const menuButton = screen.getByRole("button", { name: "Buka menu navigasi" });
    const outside = screen.getByRole("button", { name: "Kandungan luar" });

    await user.click(menuButton);

    const dialog = screen.getByRole("dialog", { name: "Navigasi utama" });
    const close = within(dialog).getByRole("button", { name: "Tutup menu navigasi" });
    await waitFor(() => expect(document.activeElement).toBe(close));

    outside.focus();
    await waitFor(() => expect(document.activeElement).toBe(close));

    await user.click(close);
    await waitFor(() => expect(document.activeElement).toBe(menuButton));
    expect(screen.queryByRole("dialog", { name: "Navigasi utama" })).toBeNull();
    expect(container.querySelector(".crm-shell__workspace")?.hasAttribute("inert")).toBe(false);
  });
});

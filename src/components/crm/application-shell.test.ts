/** @vitest-environment jsdom */

import { createElement } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ pathname: "/", push: vi.fn(), search: "bu=salam-land" }));

vi.mock("next/navigation", () => ({
  usePathname: () => mocks.pathname,
  useRouter: () => ({ push: mocks.push }),
  useSearchParams: () => new URLSearchParams(mocks.search),
}));

import { ApplicationShell, type ShellViewer } from "./application-shell";

const businessUnitAccess: ShellViewer["businessUnitAccess"] = [
  {
    id: "00000000-0000-4000-8000-000000000101",
    name: "Salam Land",
    code: "salam-land",
    capabilities: [
      "lead.read", "lead.create", "marketing.read", "inventory.read", "order.read",
      "finance.read", "task.read", "report.read",
    ],
  },
  {
    id: "00000000-0000-4000-8000-000000000102",
    name: "Bumi Hayat Printing",
    code: "bumi-hayat",
    capabilities: ["task.read"],
  },
  {
    id: "00000000-0000-4000-8000-000000000103",
    name: "Barakah Emas",
    code: "barakah-emas",
    capabilities: ["lead.read", "opportunity.read"],
  },
];

function props(overrides: Partial<ShellViewer> = {}): Parameters<typeof ApplicationShell>[0] {
  return {
    surface: "crm",
    viewer: {
      displayName: "Aqmal Jupri",
      sessionExpiresAt: "2026-07-17T12:00:00.000Z",
      businessUnitId: businessUnitAccess[0]!.id,
      businessUnitAccess,
      demo: false,
      ...overrides,
    },
    children: createElement("p", null, "Kandungan"),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.pathname = "/";
  mocks.search = "bu=salam-land";
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
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
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ApplicationShell", () => {
  it("filters navigation from the selected unit projection and preserves its code", () => {
    mocks.pathname = "/leads";
    render(createElement(ApplicationShell, props()));

    const navigation = screen.getByRole("navigation", { name: "Navigasi utama" });
    expect(within(navigation).getByRole("link", { name: "Lead" }).getAttribute("href"))
      .toBe("/leads?bu=salam-land");
    expect(within(navigation).getByText("Pemasaran")).toBeTruthy();
    expect(within(navigation).queryByText("Pasukan")).toBeNull();
    expect(within(navigation).queryByLabelText("8 rekod")).toBeNull();
  });

  it("never authorises another unit from active-cookie capabilities", () => {
    mocks.search = "bu=bumi-hayat";
    render(createElement(ApplicationShell, props({ businessUnitId: businessUnitAccess[0]!.id })));

    const navigation = screen.getByRole("navigation", { name: "Navigasi utama" });
    expect(within(navigation).getByText("Tugasan")).toBeTruthy();
    expect(within(navigation).queryByText("Lead")).toBeNull();
    expect(within(navigation).queryByText("Pemasaran")).toBeNull();
  });

  it("shows a module in Semua when at least one included unit grants it", () => {
    mocks.search = "bu=all";
    render(createElement(ApplicationShell, props()));

    const navigation = screen.getByRole("navigation", { name: "Navigasi utama" });
    expect(within(navigation).getByRole("link", { name: "Lead" }).getAttribute("href"))
      .toBe("/leads?bu=all");
    expect(within(navigation).getByRole("link", { name: "Pipeline" }).getAttribute("href"))
      .toBe("/pipeline?bu=all");
    expect(screen.getByRole("button", { name: "Tukar syarikat. Semasa: Semua" })).toBeTruthy();
  });

  it("offers only units granting the active module capability", async () => {
    mocks.pathname = "/leads";
    const user = userEvent.setup();
    render(createElement(ApplicationShell, props()));

    await user.click(screen.getByRole("button", { name: /Tukar syarikat/ }));
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "Semua",
      "Salam Land",
      "Barakah Emas",
    ]);
    expect(screen.queryByRole("option", { name: "Bumi Hayat Printing" })).toBeNull();
  });

  it.each(["bu=salam-land", "bu=bumi-hayat", "bu=all"])(
    "never shows a global demo count for scoped navigation (%s)",
    (search) => {
      mocks.search = search;
      render(createElement(ApplicationShell, props({ demo: true })));
      const navigation = screen.getByRole("navigation", { name: "Navigasi utama" });
      expect(within(navigation).queryByLabelText(/rekod$/)).toBeNull();
    },
  );

  it("omits invented production health and labels only local demo mode", () => {
    const { rerender } = render(createElement(ApplicationShell, props()));

    expect(screen.queryByText("Tersambung", { exact: true })).toBeNull();
    expect(screen.queryByText("Tidak diketahui", { exact: true })).toBeNull();
    expect(screen.queryByText("Demo", { exact: true })).toBeNull();

    rerender(createElement(ApplicationShell, props({ demo: true })));
    expect(screen.getByText("Demo", { exact: true })).toBeTruthy();
    expect(screen.queryByText("Tersambung", { exact: true })).toBeNull();
  });

  it("enforces Tasha's Salam-only boundary and compact navigation", async () => {
    const user = userEvent.setup();
    const tashaProps = { ...props(), surface: "tasha" as const };
    const { container } = render(createElement(ApplicationShell, tashaProps));
    const navigation = screen.getByRole("navigation", { name: "Navigasi utama" });

    expect(within(navigation).getAllByRole("link").map((link) => link.textContent?.trim()))
      .toEqual(["Utama", "Inventori", "Pesanan", "Kewangan", "Tugasan", "Laporan"]);
    expect(within(navigation).queryByText("Lead")).toBeNull();
    expect(screen.queryByText("Demo tempatan")).toBeNull();
    expect(screen.getByText("Tasha")).toBeTruthy();
    expect(container.querySelector(".crm-sidebar__brand-mark")?.textContent).toBe("T");

    await user.click(screen.getByRole("button", { name: /Tukar syarikat/ }));
    expect(screen.getAllByRole("option").map((option) => option.textContent))
      .toEqual(["Semua", "Salam Land"]);
  });

  it("uses surface-safe nested titles and product fallback", () => {
    mocks.pathname = "/inventory/stock-123";
    const tashaProps = { ...props(), surface: "tasha" as const };
    const { rerender } = render(createElement(ApplicationShell, tashaProps));
    expect(screen.getByRole("heading", { level: 1, name: "Inventori" })).toBeTruthy();

    mocks.pathname = "/leads/hidden-on-tasha";
    rerender(createElement(ApplicationShell, tashaProps));
    expect(screen.getByRole("heading", { level: 1, name: "Tasha" })).toBeTruthy();
  });

  it("renders one page title and exposes the actual viewer session from the user menu", async () => {
    const user = userEvent.setup();
    render(createElement(ApplicationShell, props()));

    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Menu pengguna Aqmal Jupri" }));
    const menu = screen.getByRole("menu", { name: "Akaun Aqmal Jupri" });
    expect(within(menu).getByText("Sesi aktif")).toBeTruthy();
    expect(within(menu).getByText(/Tamat/).closest("time")?.getAttribute("datetime"))
      .toBe("2026-07-17T12:00:00.000Z");
  });
});

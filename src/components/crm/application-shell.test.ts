/** @vitest-environment jsdom */

import { createElement } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ pathname: "/", refresh: vi.fn() }));

vi.mock("next/navigation", () => ({
  usePathname: () => mocks.pathname,
  useRouter: () => ({ refresh: mocks.refresh }),
}));

import { ApplicationShell } from "./application-shell";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.pathname = "/";
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

afterEach(cleanup);

describe("ApplicationShell", () => {
  it("uses concise Malay labels for primary navigation", () => {
    const props: Parameters<typeof ApplicationShell>[0] = {
      surface: "crm",
      viewer: {
        displayName: "Aqmal Jupri",
        businessUnitId: "00000000-0000-4000-8000-000000000101",
        businessUnits: [{
          id: "00000000-0000-4000-8000-000000000101",
          name: "Salam Land",
          slug: "salam-land",
          code: "salam-land",
        }],
        capabilities: ["lead.read", "marketing.read"],
        demo: false,
      },
      children: createElement("p", null, "Kandungan"),
    };
    render(createElement(ApplicationShell, props));

    const navigation = screen.getByRole("navigation", { name: "Navigasi utama" });
    expect(within(navigation).getByRole("link", { name: "Lead" })).toBeTruthy();
    expect(within(navigation).getByText("Pemasaran")).toBeTruthy();
    expect(within(navigation).queryByLabelText("8 rekod")).toBeNull();
    expect(within(navigation).queryByText("Leads")).toBeNull();
    expect(within(navigation).queryByText("Marketing")).toBeNull();
    expect(screen.queryByRole("button", { name: /Tukar syarikat/ })).toBeNull();
    expect(screen.getByText("Salam Land")).toBeTruthy();
  });

  it("uses explicit capabilities in demo mode instead of bypassing navigation policy", () => {
    const props: Parameters<typeof ApplicationShell>[0] = {
      surface: "crm",
      viewer: {
        displayName: "Demo Viewer",
        businessUnitId: "00000000-0000-4000-8000-000000000101",
        businessUnits: [{
          id: "00000000-0000-4000-8000-000000000101",
          name: "Salam Land",
          slug: "salam-land",
          code: "salam-land",
        }],
        capabilities: ["lead.read"],
        demo: true,
      },
      children: createElement("p", null, "Kandungan"),
    };
    render(createElement(ApplicationShell, props));

    const navigation = screen.getByRole("navigation", { name: "Navigasi utama" });
    expect(within(navigation).getByText("Lead")).toBeTruthy();
    expect(within(navigation).getByLabelText("8 rekod")).toBeTruthy();
    expect(within(navigation).queryByText("Kewangan")).toBeNull();
  });

  it("keeps the workspace switcher functional when another business unit exists", async () => {
    const user = userEvent.setup();
    const props: Parameters<typeof ApplicationShell>[0] = {
      surface: "tasha",
      viewer: {
        displayName: "Aqmal Jupri",
        businessUnitId: "00000000-0000-4000-8000-000000000101",
        businessUnits: [
          {
            id: "00000000-0000-4000-8000-000000000101",
            name: "Salam Land",
            slug: "salam-land",
            code: "salam-land",
          },
          {
            id: "00000000-0000-4000-8000-000000000102",
            name: "Bumi Hayat Printing",
            slug: "bumi-hayat",
            code: "bumi-hayat",
          },
        ],
        capabilities: [],
        demo: false,
      },
      children: createElement("p", null, "Kandungan"),
    };
    render(createElement(ApplicationShell, props));

    await user.click(
      screen.getByRole("button", { name: "Tukar syarikat. Semasa: Salam Land" }),
    );

    expect(
      screen.getByRole("button", { name: "Tukar syarikat. Semasa: Bumi Hayat Printing" }),
    ).toBeTruthy();
    expect(mocks.refresh).toHaveBeenCalledOnce();
  });

  it("renders only the compact ordered Tasha modules with its own brand and no CRM badges", () => {
    const props: Parameters<typeof ApplicationShell>[0] = {
      surface: "tasha",
      viewer: {
        displayName: "Admin Jualan",
        businessUnitId: "00000000-0000-4000-8000-000000000101",
        businessUnits: [{
          id: "00000000-0000-4000-8000-000000000101",
          name: "Salam Land",
          slug: "salam-land",
          code: "salam-land",
        }],
        capabilities: [
          "inventory.read",
          "order.read",
          "finance.read",
          "task.read",
          "report.read",
          "lead.read",
          "settings.read",
        ],
        demo: true,
      },
      children: createElement("p", null, "Kandungan"),
    };

    const { container } = render(createElement(ApplicationShell, props));
    const navigation = screen.getByRole("navigation", { name: "Navigasi utama" });

    expect(
      within(navigation)
        .getAllByRole("link")
        .map((link) => link.textContent?.trim()),
    ).toEqual(["Utama", "Inventori", "Pesanan", "Kewangan", "Tugasan", "Laporan"]);
    expect(within(navigation).queryByText("Lead")).toBeNull();
    expect(within(navigation).queryByText("Tetapan")).toBeNull();
    expect(within(navigation).queryByLabelText(/rekod/)).toBeNull();
    expect(screen.queryByText("Demo tempatan")).toBeNull();
    expect(screen.queryByText("Tersambung")).toBeNull();
    expect(screen.getByText("Tasha")).toBeTruthy();
    expect(container.querySelector(".crm-sidebar__brand-mark")?.textContent).toBe("T");
  });

  it("uses surface-safe nested titles and the product name as an unknown-route fallback", () => {
    mocks.pathname = "/inventory/stock-123";
    const props: Parameters<typeof ApplicationShell>[0] = {
      surface: "tasha",
      viewer: {
        displayName: "Admin Jualan",
        businessUnitId: "00000000-0000-4000-8000-000000000101",
        businessUnits: [{
          id: "00000000-0000-4000-8000-000000000101",
          name: "Salam Land",
          slug: "salam-land",
          code: "salam-land",
        }],
        capabilities: ["inventory.read"],
        demo: false,
      },
      children: createElement("p", null, "Kandungan"),
    };

    const { rerender } = render(createElement(ApplicationShell, props));
    expect(screen.getByRole("heading", { level: 1, name: "Inventori" })).toBeTruthy();

    mocks.pathname = "/leads/hidden-on-tasha";
    rerender(createElement(ApplicationShell, props));
    expect(screen.getByRole("heading", { level: 1, name: "Tasha" })).toBeTruthy();
  });
});

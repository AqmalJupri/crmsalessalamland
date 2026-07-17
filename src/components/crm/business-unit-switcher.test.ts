/** @vitest-environment jsdom */

import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  pathname: "/leads",
  push: vi.fn(),
  search: "bu=salam-land&status=new",
}));

vi.mock("next/navigation", () => ({
  usePathname: () => mocks.pathname,
  useRouter: () => ({ push: mocks.push }),
  useSearchParams: () => new URLSearchParams(mocks.search),
}));

import { BusinessUnitSwitcher } from "./business-unit-switcher";

const units = [
  { id: "unit-salam", code: "salam-land", name: "Salam Land", capabilities: ["lead.read"] },
  { id: "unit-bumi", code: "bumi-hayat", name: "Bumi Hayat Printing", capabilities: ["lead.read"] },
  { id: "unit-barakah", code: "barakah-emas", name: "Barakah Emas", capabilities: ["lead.read"] },
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.pathname = "/leads";
  mocks.search = "bu=salam-land&status=new";
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("BusinessUnitSwitcher", () => {
  it("exposes an explicit selected listbox with all authorised companies", async () => {
    const user = userEvent.setup();
    render(createElement(BusinessUnitSwitcher, { units, selectedCode: "salam-land" }));

    const trigger = screen.getByRole("button", { name: "Tukar syarikat. Semasa: Salam Land" });
    expect(trigger.getAttribute("aria-haspopup")).toBe("listbox");
    await user.click(trigger);

    const listbox = screen.getByRole("listbox", { name: "Syarikat" });
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "Semua",
      "Salam Land",
      "Bumi Hayat Printing",
      "Barakah Emas",
    ]);
    expect(screen.getByRole("option", { name: "Salam Land" }).getAttribute("aria-selected"))
      .toBe("true");
    expect(listbox).toBeTruthy();
  });

  it("supports arrow navigation, Escape, outside click, and focus return", async () => {
    const user = userEvent.setup();
    render(createElement("div", null,
      createElement(BusinessUnitSwitcher, { units, selectedCode: "salam-land" }),
      createElement("button", { type: "button" }, "Di luar"),
    ));
    const trigger = screen.getByRole("button", { name: /Tukar syarikat/ });

    await user.click(trigger);
    expect(document.activeElement).toBe(screen.getByRole("option", { name: "Salam Land" }));
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(screen.getByRole("option", { name: "Bumi Hayat Printing" }));
    await user.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(screen.getByRole("option", { name: "Salam Land" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(trigger);

    await user.click(trigger);
    fireEvent.pointerDown(screen.getByRole("button", { name: "Di luar" }));
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("uses roving tab stops and closes on Tab without trapping focus", async () => {
    const user = userEvent.setup();
    render(createElement("div", null,
      createElement(BusinessUnitSwitcher, { units, selectedCode: "salam-land" }),
      createElement("button", { type: "button" }, "Selepas syarikat"),
    ));

    await user.click(screen.getByRole("button", { name: /Tukar syarikat/ }));
    const salam = screen.getByRole("option", { name: "Salam Land" });
    const bumi = screen.getByRole("option", { name: "Bumi Hayat Printing" });
    expect(salam.getAttribute("tabindex")).toBe("0");
    expect(bumi.getAttribute("tabindex")).toBe("-1");

    await user.keyboard("{ArrowDown}");
    expect(salam.getAttribute("tabindex")).toBe("-1");
    expect(bumi.getAttribute("tabindex")).toBe("0");
    await user.tab();

    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Selepas syarikat" }));
  });

  it.each([
    { selectedCode: "salam-land", option: "Salam Land" },
    { selectedCode: "all", option: "Semua" },
  ])("closes without fetch or history when $option is already selected", async ({ selectedCode, option }) => {
    const user = userEvent.setup();
    render(createElement(BusinessUnitSwitcher, { units, selectedCode }));
    const trigger = screen.getByRole("button", { name: /Tukar syarikat/ });

    await user.click(trigger);
    await user.click(screen.getByRole("option", { name: option }));

    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.push).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("changes Semua in the URL without changing the active write preference", async () => {
    const user = userEvent.setup();
    render(createElement(BusinessUnitSwitcher, { units, selectedCode: "salam-land" }));

    await user.click(screen.getByRole("button", { name: /Tukar syarikat/ }));
    await user.click(screen.getByRole("option", { name: "Semua" }));

    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.push).toHaveBeenCalledWith("/leads?bu=all&status=new");
  });

  it("stores a unit preference server-side before navigating with its code", async () => {
    const user = userEvent.setup();
    render(createElement(BusinessUnitSwitcher, { units, selectedCode: "salam-land" }));

    await user.click(screen.getByRole("button", { name: /Tukar syarikat/ }));
    await user.click(screen.getByRole("option", { name: "Barakah Emas" }));

    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      "/api/v1/auth/business-unit",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ businessUnitId: "unit-barakah" }),
      }),
    ));
    expect(mocks.push).toHaveBeenCalledWith("/leads?bu=barakah-emas&status=new");
  });

  it("keeps the current scope on a failed preference update", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json({ error: { message: "Akses ditolak." } }, { status: 403 }),
    );
    const user = userEvent.setup();
    render(createElement(BusinessUnitSwitcher, { units, selectedCode: "salam-land" }));

    await user.click(screen.getByRole("button", { name: /Tukar syarikat/ }));
    await user.click(screen.getByRole("option", { name: "Bumi Hayat Printing" }));

    expect((await screen.findByRole("status")).textContent).toBe("Akses ditolak.");
    expect(mocks.push).not.toHaveBeenCalled();
  });
});

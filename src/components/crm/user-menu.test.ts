/** @vitest-environment jsdom */

import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { UserMenu } from "./user-menu";

const activeSessionReferenceTime = Date.parse("2026-07-17T11:00:00.000Z");

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("UserMenu", () => {
  it("shows the real display name and actual session expiry", async () => {
    vi.spyOn(Date, "now").mockReturnValue(activeSessionReferenceTime);
    const user = userEvent.setup();
    render(createElement(UserMenu, {
      displayName: "Aqmal Jupri",
      sessionExpiresAt: "2026-07-17T12:00:00.000Z",
    }));

    const trigger = screen.getByRole("button", { name: "Menu pengguna Aqmal Jupri" });
    expect(trigger.textContent).toContain("Aqmal Jupri");
    await user.click(trigger);

    const menu = screen.getByRole("menu", { name: "Akaun Aqmal Jupri" });
    expect(within(menu).getByText("Aqmal Jupri")).toBeTruthy();
    expect(within(menu).getByText("Sesi aktif")).toBeTruthy();
    const expiry = within(menu).getByText(/Tamat/).closest("time");
    expect(expiry?.getAttribute("datetime")).toBe("2026-07-17T12:00:00.000Z");
  });

  it("dismisses with Escape and returns focus to the trigger", async () => {
    const user = userEvent.setup();
    render(createElement(UserMenu, {
      displayName: "Aqmal Jupri",
      sessionExpiresAt: "2026-07-17T12:00:00.000Z",
    }));
    const trigger = screen.getByRole("button", { name: "Menu pengguna Aqmal Jupri" });

    await user.click(trigger);
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("menu")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("dismisses on forward and reverse Tab without trapping page focus", async () => {
    const user = userEvent.setup();
    render(createElement(
      "div",
      null,
      createElement(UserMenu, {
        displayName: "Aqmal Jupri",
        sessionExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
      createElement("button", { type: "button" }, "Tindakan seterusnya"),
    ));
    const trigger = screen.getByRole("button", { name: "Menu pengguna Aqmal Jupri" });
    const nextAction = screen.getByRole("button", { name: "Tindakan seterusnya" });

    await user.click(trigger);
    await user.tab();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(nextAction);

    await user.click(trigger);
    await user.tab({ shift: true });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("changes a long-lived session from active to expired at the real deadline", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-17T09:00:00.000Z"));
    render(createElement(UserMenu, {
      displayName: "Aqmal Jupri",
      sessionExpiresAt: "2026-07-17T09:00:01.000Z",
    }));
    fireEvent.click(screen.getByRole("button", { name: "Menu pengguna Aqmal Jupri" }));

    expect(screen.getByText("Sesi aktif")).toBeTruthy();
    act(() => vi.advanceTimersByTime(1_001));

    expect(screen.getByText("Sesi tamat")).toBeTruthy();
    expect(screen.queryByText("Sesi aktif")).toBeNull();
  });

  it("does not invent an active state when expiry is unavailable", async () => {
    const user = userEvent.setup();
    render(createElement(UserMenu, {
      displayName: "Aqmal Jupri",
      sessionExpiresAt: null,
    }));

    await user.click(screen.getByRole("button", { name: "Menu pengguna Aqmal Jupri" }));

    expect(screen.getByText("Status sesi tidak tersedia")).toBeTruthy();
    expect(screen.queryByText("Sesi aktif")).toBeNull();
  });

  it("keeps the current screen and reports a logout failure", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(
      JSON.stringify({ error: { message: "Log keluar gagal." } }),
      { status: 503, headers: { "Content-Type": "application/json" } },
    ));
    const onLoggedOut = vi.fn();
    const user = userEvent.setup();
    render(createElement(UserMenu, {
      displayName: "Aqmal Jupri",
      onLoggedOut,
      sessionExpiresAt: "2026-07-17T12:00:00.000Z",
    }));

    await user.click(screen.getByRole("button", { name: "Menu pengguna Aqmal Jupri" }));
    await user.click(screen.getByRole("menuitem", { name: "Log keluar" }));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Log keluar gagal."));
    expect(screen.getByRole("menu", { name: "Akaun Aqmal Jupri" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Menu pengguna Aqmal Jupri" })).toBeTruthy();
    expect(onLoggedOut).not.toHaveBeenCalled();
  });

  it("posts to the same-origin logout route before leaving", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    const onLoggedOut = vi.fn();
    const user = userEvent.setup();
    render(createElement(UserMenu, {
      displayName: "Aqmal Jupri",
      onLoggedOut,
      sessionExpiresAt: "2026-07-17T12:00:00.000Z",
    }));

    await user.click(screen.getByRole("button", { name: "Menu pengguna Aqmal Jupri" }));
    await user.click(screen.getByRole("menuitem", { name: "Log keluar" }));

    await waitFor(() => expect(onLoggedOut).toHaveBeenCalledOnce());
    expect(fetch).toHaveBeenCalledWith("/api/v1/auth/logout", {
      credentials: "same-origin",
      method: "POST",
    });
  });
});

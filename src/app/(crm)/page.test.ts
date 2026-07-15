/** @vitest-environment jsdom */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ requirePageViewer: vi.fn() }));

vi.mock("@/server/auth/page-access", () => ({
  requirePageViewer: mocks.requirePageViewer,
}));

import DashboardPage from "./page";

afterEach(cleanup);

describe("DashboardPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requirePageViewer.mockResolvedValue({ demo: true });
  });

  it("uses an auth-only root boundary, Malay task copy, and no unavailable task actions", async () => {
    render(await DashboardPage());

    expect(mocks.requirePageViewer).toHaveBeenCalledWith(undefined, "/");
    expect(screen.getByText("Susulan lewat")).toBeTruthy();
    expect(screen.getByText("Kewangan")).toBeTruthy();
    expect(screen.queryByText("Follow-up lewat")).toBeNull();
    expect(screen.queryByText("Finance")).toBeNull();
    expect(screen.queryByRole("button", { name: "Buka" })).toBeNull();
  });

  it("never presents synthetic metrics, tasks, or activity to a non-demo viewer", async () => {
    mocks.requirePageViewer.mockResolvedValue({ demo: false });

    render(await DashboardPage());

    expect(screen.getByText("Belum ada data.")).toBeTruthy();
    expect(screen.queryByText("Lead baharu")).toBeNull();
    expect(screen.queryByText("RM1.24j")).toBeNull();
    expect(screen.queryByText("Nur Aisyah")).toBeNull();
    expect(screen.queryByText("Daniel Wong")).toBeNull();
  });
});

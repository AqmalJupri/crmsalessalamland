import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ canRenderDemoFixtures: vi.fn() }));

vi.mock("@/server/auth/page-access", () => ({
  canRenderDemoFixtures: mocks.canRenderDemoFixtures,
}));

import FinancePage from "./finance/page";
import InventoryPage from "./inventory/page";
import MarketingPage from "./marketing/page";
import OrdersPage from "./orders/page";
import ReportsPage from "./reports/page";
import SettingsPage from "./settings/page";
import TasksPage from "./tasks/page";
import TeamPage from "./team/page";

type Page = () => ReactNode | Promise<ReactNode>;

const operationalPages: Array<{
  name: string;
  Page: Page;
  fixture: string;
}> = [
  { name: "finance", Page: FinancePage, fixture: "RM286k" },
  { name: "inventory", Page: InventoryPage, fixture: "A-118" },
  { name: "marketing", Page: MarketingPage, fixture: "Salam Land Julai" },
  { name: "orders", Page: OrdersPage, fixture: "SL-2026-0481" },
  { name: "reports", Page: ReportsPage, fixture: "Prestasi jualan" },
  { name: "settings", Page: SettingsPage, fixture: "Meta Lead Ads" },
  { name: "tasks", Page: TasksPage, fixture: "Hubungi pelanggan" },
  { name: "team", Page: TeamPage, fixture: "Pengurus Jualan" },
];

describe("operational fixture boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(operationalPages)(
    "$name renders no static operational data for a non-demo viewer",
    async ({ Page, fixture }) => {
      mocks.canRenderDemoFixtures.mockReturnValue(false);

      const html = renderToStaticMarkup(await Page());

      expect(mocks.canRenderDemoFixtures).toHaveBeenCalledWith();
      expect(html).toContain("Belum ada data.");
      expect(html).not.toContain(fixture);
    },
  );

  it.each(operationalPages)(
    "$name preserves its fixtures for the explicit demo viewer",
    async ({ Page, fixture }) => {
      mocks.canRenderDemoFixtures.mockReturnValue(true);

      const html = renderToStaticMarkup(await Page());

      expect(html).toContain(fixture);
    },
  );
});

import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { demoActivities, demoTasks, leadProviderOptions } from "@/lib/demo-crm";

const mocks = vi.hoisted(() => ({ canRenderDemoFixtures: vi.fn() }));

vi.mock("@/server/auth/page-access", () => ({
  canRenderDemoFixtures: mocks.canRenderDemoFixtures,
}));

import InventoryPage from "./inventory/page";
import MarketingPage from "./marketing/page";
import ReportsPage from "./reports/page";
import SettingsPage from "./settings/page";
import TasksPage from "./tasks/page";
import TeamPage from "./team/page";

async function pageText(Page: () => ReactNode | Promise<ReactNode>): Promise<string> {
  return renderToStaticMarkup(await Page()).replace(/<[^>]*>/g, " ");
}

describe("visible CRM demo copy", () => {
  beforeEach(() => {
    mocks.canRenderDemoFixtures.mockReturnValue(true);
  });

  it("uses concise Malay labels and role names across operational pages", async () => {
    const text = (await Promise.all(
      [TeamPage, MarketingPage, ReportsPage, SettingsPage, InventoryPage, TasksPage]
        .map(pageText),
    ))
      .concat(
        demoTasks.map((task) => task.title),
        demoActivities.flatMap((activity) => [activity.action, activity.actor]),
        leadProviderOptions.map((provider) => provider.label),
      )
      .join(" ");

    expect(text).toContain("Susulan lewat");
    expect(text).toContain("Sasaran dicapai");
    expect(text).toContain("Eksekutif Jualan");
    expect(text).toContain("Pengurus Jualan");
    expect(text).toContain("Kadar menang");
    expect(text).toContain("Atribusi pemasaran");
    expect(text).toContain("Kewangan");
    expect(text).toContain("Pemasaran");
    expect(text).toContain("Operasi");
    expect(text).toContain("Pegangan");
    expect(text).toContain("sebut harga");
    expect(text).toContain("Rujukan");
    expect(text).toContain("Laman web");
    expect(text).toContain("Datang terus");
    expect(text).not.toMatch(/Follow-up lewat|\bLeads\b|\bMarketing\b|\bFinance\b|\bOperations\b|Sales Executive|Sales Manager|Win rate|Marketing attribution|\bHold\b|quotation|\bReferral\b|\bWebsite\b|Walk-in/);
  });
});

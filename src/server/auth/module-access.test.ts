import { describe, expect, it } from "vitest";
import { CRM_MODULE_ACCESS, CRM_MODULE_READ_CAPABILITIES } from "./module-access";

describe("CRM module access map", () => {
  it("defines the exact protected route, read capability, and return path for every module", () => {
    expect(CRM_MODULE_ACCESS).toEqual({
      finance: { capability: "finance.read", returnTo: "/finance" },
      inventory: { capability: "inventory.read", returnTo: "/inventory" },
      leads: { capability: "lead.read", returnTo: "/leads" },
      marketing: { capability: "marketing.read", returnTo: "/marketing" },
      orders: { capability: "order.read", returnTo: "/orders" },
      pipeline: { capability: "opportunity.read", returnTo: "/pipeline" },
      reports: { capability: "report.read", returnTo: "/reports" },
      settings: { capability: "settings.read", returnTo: "/settings" },
      tasks: { capability: "task.read", returnTo: "/tasks" },
      team: { capability: "team.read", returnTo: "/team" },
    });
    expect(CRM_MODULE_READ_CAPABILITIES).toEqual([
      "finance.read",
      "inventory.read",
      "lead.read",
      "marketing.read",
      "order.read",
      "opportunity.read",
      "report.read",
      "settings.read",
      "task.read",
      "team.read",
    ]);
  });
});

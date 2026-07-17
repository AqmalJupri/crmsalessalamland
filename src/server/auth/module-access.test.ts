import { afterEach, describe, expect, it, vi } from "vitest";
import { PRODUCT_NAVIGATION } from "@/config/product-navigation";
import { CRM_MODULE_ACCESS, CRM_MODULE_READ_CAPABILITIES } from "./module-access";

describe("CRM module access map", () => {
  it("defines the exact protected route, read capability, and return path for every module", () => {
    expect(CRM_MODULE_ACCESS).toEqual({
      finance: { capability: "finance.read", returnTo: "/finance", surfaces: ["crm", "tasha"] },
      inventory: { capability: "inventory.read", returnTo: "/inventory", surfaces: ["crm", "tasha"] },
      leads: { capability: "lead.read", returnTo: "/leads", surfaces: ["crm"] },
      marketing: { capability: "marketing.read", returnTo: "/marketing", surfaces: ["crm"] },
      orders: { capability: "order.read", returnTo: "/orders", surfaces: ["crm", "tasha"] },
      pipeline: { capability: "opportunity.read", returnTo: "/pipeline", surfaces: ["crm"] },
      reports: { capability: "report.read", returnTo: "/reports", surfaces: ["crm", "tasha"] },
      settings: { capability: "settings.read", returnTo: "/settings", surfaces: ["crm"] },
      tasks: { capability: "task.read", returnTo: "/tasks", surfaces: ["crm", "tasha"] },
      team: { capability: "team.read", returnTo: "/team", surfaces: ["crm"] },
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

    expect(
      Object.entries(CRM_MODULE_ACCESS)
        .map(([key, access]) => ({ key, ...access }))
        .sort((left, right) => left.key.localeCompare(right.key)),
    ).toEqual(
      PRODUCT_NAVIGATION
        .filter((item) => "capability" in item)
        .map((item) => ({
          key: item.href.slice(1),
          capability: item.capability,
          returnTo: item.href,
          surfaces: item.surfaces,
        }))
        .sort((left, right) => left.key.localeCompare(right.key)),
    );
  });

  it("deeply freezes the derived map, entries, and surface lists", () => {
    expect(Object.isFrozen(CRM_MODULE_ACCESS)).toBe(true);
    expect(Object.isFrozen(CRM_MODULE_READ_CAPABILITIES)).toBe(true);

    for (const access of Object.values(CRM_MODULE_ACCESS)) {
      expect(Object.isFrozen(access)).toBe(true);
      expect(Object.isFrozen(access.surfaces)).toBe(true);
    }

    expect(Reflect.set(CRM_MODULE_ACCESS.finance, "capability", "lead.read")).toBe(false);
    expect(Reflect.set(CRM_MODULE_ACCESS, "finance", CRM_MODULE_ACCESS.leads)).toBe(false);
    expect(CRM_MODULE_ACCESS.finance.capability).toBe("finance.read");
  });
});

describe.sequential("CRM module access builder invariants", () => {
  afterEach(() => {
    vi.doUnmock("@/config/product-navigation");
    vi.resetModules();
  });

  it("rejects duplicate protected module keys instead of silently overwriting", async () => {
    vi.resetModules();
    vi.doMock("@/config/product-navigation", () => ({
      PRODUCT_NAVIGATION: [
        {
          href: "/leads",
          capability: "lead.read",
          surfaces: ["crm"],
        },
        {
          href: "/leads",
          capability: "opportunity.read",
          surfaces: ["crm"],
        },
      ],
    }));

    await expect(import("./module-access")).rejects.toThrow(/duplicate.*leads/i);
  });

  it("rejects a protected item without a non-empty module key", async () => {
    vi.resetModules();
    vi.doMock("@/config/product-navigation", () => ({
      PRODUCT_NAVIGATION: [
        {
          href: "/",
          capability: "root.read",
          surfaces: ["crm"],
        },
      ],
    }));

    await expect(import("./module-access")).rejects.toThrow(/module key/i);
  });
});

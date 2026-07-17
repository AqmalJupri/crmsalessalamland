import { describe, expect, it } from "vitest";
import {
  PRODUCT_NAVIGATION,
  getProductNavigationSections,
  getProductRouteTitle,
  isProductPathAvailable,
} from "./product-navigation";

describe("product navigation contract", () => {
  it("declares the exact route, copy, capability, surfaces, title, and surface order once", () => {
    expect(PRODUCT_NAVIGATION).toEqual([
      {
        label: "Utama",
        title: "Utama",
        href: "/",
        surfaces: ["crm", "tasha"],
        order: { crm: [0, 0], tasha: [0, 0] },
      },
      {
        label: "Lead",
        title: "Lead",
        href: "/leads",
        capability: "lead.read",
        surfaces: ["crm"],
        order: { crm: [0, 1] },
      },
      {
        label: "Pipeline",
        title: "Pipeline",
        href: "/pipeline",
        capability: "opportunity.read",
        surfaces: ["crm"],
        order: { crm: [0, 2] },
      },
      {
        label: "Tugasan",
        title: "Tugasan",
        href: "/tasks",
        capability: "task.read",
        surfaces: ["crm", "tasha"],
        order: { crm: [0, 3], tasha: [0, 4] },
      },
      {
        label: "Pesanan",
        title: "Pesanan",
        href: "/orders",
        capability: "order.read",
        surfaces: ["crm", "tasha"],
        order: { crm: [1, 0], tasha: [0, 2] },
      },
      {
        label: "Inventori",
        title: "Inventori",
        href: "/inventory",
        capability: "inventory.read",
        surfaces: ["crm", "tasha"],
        order: { crm: [1, 1], tasha: [0, 1] },
      },
      {
        label: "Kewangan",
        title: "Kewangan",
        href: "/finance",
        capability: "finance.read",
        surfaces: ["crm", "tasha"],
        order: { crm: [1, 2], tasha: [0, 3] },
      },
      {
        label: "Pemasaran",
        title: "Pemasaran",
        href: "/marketing",
        capability: "marketing.read",
        surfaces: ["crm"],
        order: { crm: [2, 0] },
      },
      {
        label: "Laporan",
        title: "Laporan",
        href: "/reports",
        capability: "report.read",
        surfaces: ["crm", "tasha"],
        order: { crm: [2, 1], tasha: [0, 5] },
      },
      {
        label: "Pasukan",
        title: "Pasukan",
        href: "/team",
        capability: "team.read",
        surfaces: ["crm"],
        order: { crm: [3, 0] },
      },
      {
        label: "Tetapan",
        title: "Tetapan",
        href: "/settings",
        capability: "settings.read",
        surfaces: ["crm"],
        order: { crm: [3, 1] },
      },
    ]);
  });

  it("preserves CRM sections while exposing one compact ordered Tasha list", () => {
    expect(
      getProductNavigationSections("crm").map((section) => ({
        label: section.label,
        items: section.items.map((item) => item.label),
      })),
    ).toEqual([
      { label: undefined, items: ["Utama", "Lead", "Pipeline", "Tugasan"] },
      { label: "Operasi", items: ["Pesanan", "Inventori", "Kewangan"] },
      { label: "Pertumbuhan", items: ["Pemasaran", "Laporan"] },
      { label: "Pentadbiran", items: ["Pasukan", "Tetapan"] },
    ]);

    expect(
      getProductNavigationSections("tasha").map((section) => ({
        label: section.label,
        items: section.items.map((item) => item.label),
      })),
    ).toEqual([
      {
        label: undefined,
        items: ["Utama", "Inventori", "Pesanan", "Kewangan", "Tugasan", "Laporan"],
      },
    ]);
  });

  it("resolves nested route titles without leaking a route hidden from the surface", () => {
    expect(getProductRouteTitle("crm", "/leads/lead-123")).toBe("Lead");
    expect(getProductRouteTitle("tasha", "/inventory/stock-123")).toBe("Inventori");
    expect(getProductRouteTitle("tasha", "/leads/lead-123")).toBe("Tasha");
    expect(getProductRouteTitle("crm", "/unknown")).toBe("Salam CRM");
    expect(getProductRouteTitle("crm", "/leadership")).toBe("Salam CRM");
  });

  it("fails closed for unknown paths while allowing only routes declared for the surface", () => {
    expect(isProductPathAvailable("crm", "/")).toBe(true);
    expect(isProductPathAvailable("tasha", "/")).toBe(true);
    expect(isProductPathAvailable("tasha", "/inventory/stock-123")).toBe(true);
    expect(isProductPathAvailable("tasha", "/leads")).toBe(false);
    expect(isProductPathAvailable("tasha", "/leads/lead-123")).toBe(false);
    expect(isProductPathAvailable("crm", "/leads/lead-123")).toBe(true);
    expect(isProductPathAvailable("crm", "/leadership")).toBe(false);
    expect(isProductPathAvailable("crm", "/unknown")).toBe(false);
    expect(isProductPathAvailable("crm", "")).toBe(false);
  });
});

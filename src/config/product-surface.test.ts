import { describe, expect, it } from "vitest";
import { getProductSurfaceSpec, productSurfaceSpecs } from "./product-surface";

describe("product surface deployment contract", () => {
  it("declares only the CRM and Tasha surfaces", () => {
    expect(Object.keys(productSurfaceSpecs)).toEqual(["crm", "tasha"]);
  });

  it.each([
    [
      "crm",
      {
        key: "crm",
        productName: "Salam CRM",
        canonicalHost: "crm.salamland.my",
        titleTemplate: "%s · Salam CRM",
        defaultBusinessUnitCode: "salam-land",
      },
    ],
    [
      "tasha",
      {
        key: "tasha",
        productName: "Tasha",
        canonicalHost: "tasha.salamland.my",
        titleTemplate: "%s · Tasha",
        defaultBusinessUnitCode: null,
      },
    ],
  ] as const)("resolves the %s deployment surface", (surface, expected) => {
    expect(getProductSurfaceSpec(surface)).toEqual(expected);
  });
});

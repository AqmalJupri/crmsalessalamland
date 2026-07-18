import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getProductSurfaceFromEnvironment,
  getProductSurfaceSpec,
  productSurfaceSpecs,
} from "./product-surface";

afterEach(() => vi.unstubAllEnvs());

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

  it.each(["crm", "tasha"] as const)("reads the immutable %s artifact surface", (surface) => {
    vi.stubEnv("CRM_BUILD_SURFACE", surface);

    expect(getProductSurfaceFromEnvironment()).toBe(surface);
  });

  it.each([undefined, "", "CRM", "backoffice"])(
    "rejects a missing or invalid immutable artifact surface: %s",
    (surface) => {
      vi.stubEnv("CRM_BUILD_SURFACE", surface);

      expect(() => getProductSurfaceFromEnvironment()).toThrow(/CRM_BUILD_SURFACE/);
    },
  );
});

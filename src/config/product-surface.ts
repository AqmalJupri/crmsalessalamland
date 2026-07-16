export type ProductSurface = "crm" | "tasha";
export type DeploymentEnvironment = "local" | "ci" | "staging" | "production";

export interface ProductSurfaceSpec {
  key: ProductSurface;
  productName: "Salam CRM" | "Tasha";
  canonicalHost: "crm.salamland.my" | "tasha.salamland.my";
  titleTemplate: string;
  defaultBusinessUnitCode: "salam-land" | null;
}

export const productSurfaceSpecs = {
  crm: {
    key: "crm",
    productName: "Salam CRM",
    canonicalHost: "crm.salamland.my",
    titleTemplate: "%s · Salam CRM",
    defaultBusinessUnitCode: "salam-land",
  },
  tasha: {
    key: "tasha",
    productName: "Tasha",
    canonicalHost: "tasha.salamland.my",
    titleTemplate: "%s · Tasha",
    defaultBusinessUnitCode: null,
  },
} as const satisfies Record<ProductSurface, ProductSurfaceSpec>;

export function getProductSurfaceSpec(surface: ProductSurface): ProductSurfaceSpec {
  return productSurfaceSpecs[surface];
}

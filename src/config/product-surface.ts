export const PRODUCT_SURFACES = ["crm", "tasha"] as const;
export type ProductSurface = (typeof PRODUCT_SURFACES)[number];
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

export function getProductSurfaceFromEnvironment(
  environment?: Readonly<Record<string, string | undefined>>,
): ProductSurface {
  const surface = environment === undefined
    ? process.env.CRM_BUILD_SURFACE
    : environment.CRM_BUILD_SURFACE;
  if (!PRODUCT_SURFACES.includes(surface as ProductSurface)) {
    throw new Error("CRM_BUILD_SURFACE must be exactly crm or tasha.");
  }
  return surface as ProductSurface;
}

export function getProductSurfaceSpec(surface: ProductSurface): ProductSurfaceSpec {
  return productSurfaceSpecs[surface];
}

import { PRODUCT_NAVIGATION } from "@/config/product-navigation";
import type { ProductSurface } from "@/config/product-surface";

type ProtectedNavigationItem = Extract<
  (typeof PRODUCT_NAVIGATION)[number],
  { capability: string }
>;
type StripLeadingSlash<Path extends string> = Path extends `/${infer Key}`
  ? Key
  : never;

export type CrmModuleKey = StripLeadingSlash<ProtectedNavigationItem["href"]>;

export interface CrmModuleAccess {
  capability: string;
  returnTo: string;
  surfaces: readonly ProductSurface[];
}

function isProtectedNavigationItem(
  item: (typeof PRODUCT_NAVIGATION)[number],
): item is ProtectedNavigationItem {
  return "capability" in item;
}

function buildCrmModuleAccess(): Readonly<Record<CrmModuleKey, CrmModuleAccess>> {
  const protectedItems = PRODUCT_NAVIGATION
    .filter(isProtectedNavigationItem)
    .map((item) => {
      const moduleKey = item.href.slice(1);
      if (!moduleKey || moduleKey.includes("/")) {
        throw new Error(`Protected navigation path ${item.href} has no valid module key.`);
      }
      return { item, moduleKey: moduleKey as CrmModuleKey };
    })
    .sort((left, right) => left.moduleKey.localeCompare(right.moduleKey));

  const accessMap: Partial<Record<CrmModuleKey, CrmModuleAccess>> = {};
  for (const { item, moduleKey } of protectedItems) {
    if (Object.hasOwn(accessMap, moduleKey)) {
      throw new Error(`Duplicate CRM module key: ${moduleKey}.`);
    }

    accessMap[moduleKey] = Object.freeze({
      capability: item.capability,
      returnTo: item.href,
      surfaces: Object.freeze([...item.surfaces]),
    });
  }

  const builtKeys = Object.keys(accessMap);
  if (
    builtKeys.length !== protectedItems.length ||
    protectedItems.some(({ moduleKey }) => !Object.hasOwn(accessMap, moduleKey))
  ) {
    throw new Error("CRM module access map is missing a protected module key.");
  }

  return Object.freeze(accessMap) as Readonly<
    Record<CrmModuleKey, CrmModuleAccess>
  >;
}

export const CRM_MODULE_ACCESS = buildCrmModuleAccess();

export const CRM_MODULE_READ_CAPABILITIES = Object.freeze(
  Object.values(CRM_MODULE_ACCESS).map(({ capability }) => capability),
);

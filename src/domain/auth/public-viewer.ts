import type { ProductSurface } from "@/config/product-surface";
import type { Viewer } from "@/server/auth/viewer";

export interface PublicBusinessUnitAccess {
  id: string;
  name: string;
  code: string;
  capabilities: readonly string[];
}

export interface PublicViewer {
  displayName: string;
  businessUnitId: string | null;
  businessUnitAccess: readonly PublicBusinessUnitAccess[];
  demo: boolean;
}

export function projectPublicViewer(
  viewer: Viewer,
  surface: ProductSurface,
): PublicViewer {
  const visibleAccess = surface === "tasha"
    ? viewer.businessUnitAccess.filter((unit) => unit.code === "salam-land")
    : viewer.businessUnitAccess;
  const businessUnitAccess = visibleAccess.map((unit) => Object.freeze({
    id: unit.id,
    name: unit.name,
    code: unit.code,
    capabilities: Object.freeze([...new Set(unit.capabilities)].sort()),
  }));
  const selected = businessUnitAccess.find((unit) => unit.id === viewer.businessUnitId)
    ?? businessUnitAccess[0];

  return Object.freeze({
    displayName: viewer.displayName,
    businessUnitId: selected?.id ?? null,
    businessUnitAccess: Object.freeze(businessUnitAccess),
    demo: viewer.demo,
  });
}

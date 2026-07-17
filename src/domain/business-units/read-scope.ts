import type { ProductSurface } from "@/config/product-surface";
import type {
  Viewer,
  ViewerBusinessUnitAccess,
} from "@/server/auth/viewer";

export const BUSINESS_SCOPE_QUERY_PATTERN = /^(?:all|[a-z0-9]+(?:-[a-z0-9]+)*)$/;
export const BUSINESS_SCOPE_QUERY_MAX_BYTES = 64;

export type BusinessScopeErrorCode =
  | "INVALID_SCOPE"
  | "UNAUTHORIZED_SCOPE"
  | "INVALID_VIEWER_SCOPE"
  | "WRITE_SCOPE_REQUIRED";

export class BusinessScopeError extends Error {
  constructor(
    public readonly code: BusinessScopeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BusinessScopeError";
  }
}

export type BusinessUnitReadScope =
  | {
      kind: "ALL";
      queryValue: "all";
      units: readonly ViewerBusinessUnitAccess[];
      unitIds: readonly string[];
      writable: false;
    }
  | {
      kind: "UNIT";
      queryValue: string;
      businessUnitId: string;
      businessUnitCode: string;
      access: ViewerBusinessUnitAccess;
      writable: true;
    };

function assertRawScope(
  requestedCode: string | readonly string[] | null,
): string | null {
  if (requestedCode === null) return null;
  if (Array.isArray(requestedCode) || typeof requestedCode !== "string") {
    throw new BusinessScopeError("INVALID_SCOPE", "Skop syarikat tidak sah.");
  }
  if (
    new TextEncoder().encode(requestedCode).byteLength > BUSINESS_SCOPE_QUERY_MAX_BYTES ||
    !BUSINESS_SCOPE_QUERY_PATTERN.test(requestedCode)
  ) {
    throw new BusinessScopeError("INVALID_SCOPE", "Skop syarikat tidak sah.");
  }
  return requestedCode;
}

function validateAccess(
  access: readonly ViewerBusinessUnitAccess[],
): void {
  const ids = new Set<string>();
  const codes = new Set<string>();
  for (const unit of access) {
    if (
      ids.has(unit.id) ||
      codes.has(unit.code) ||
      !BUSINESS_SCOPE_QUERY_PATTERN.test(unit.code) ||
      unit.code === "all"
    ) {
      throw new BusinessScopeError(
        "INVALID_VIEWER_SCOPE",
        "Akses syarikat tidak dapat disahkan.",
      );
    }
    ids.add(unit.id);
    codes.add(unit.code);
  }
}

function eligibleUnits(
  viewer: Viewer,
  surface: ProductSurface,
  capability?: string,
): readonly ViewerBusinessUnitAccess[] {
  validateAccess(viewer.businessUnitAccess);
  return viewer.businessUnitAccess.filter((unit) => {
    if (unit.membershipIds.length === 0) return false;
    if (surface === "tasha" && unit.code !== "salam-land") return false;
    return capability === undefined || unit.capabilities.includes(capability);
  });
}

export function resolveAuthorizedBusinessScope(
  viewer: Viewer,
  requestedCode: string | readonly string[] | null,
  surface: ProductSurface,
  capability?: string,
): BusinessUnitReadScope {
  const requested = assertRawScope(requestedCode);
  const eligible = eligibleUnits(viewer, surface, capability);
  if (eligible.length === 0) {
    throw new BusinessScopeError("UNAUTHORIZED_SCOPE", "Akses syarikat tidak dibenarkan.");
  }

  if (requested === "all") {
    return Object.freeze({
      kind: "ALL",
      queryValue: "all",
      units: Object.freeze([...eligible]),
      unitIds: Object.freeze(eligible.map((unit) => unit.id)),
      writable: false,
    });
  }

  const selected = requested
    ? eligible.find((unit) => unit.code === requested)
    : eligible.find((unit) => unit.id === viewer.businessUnitId) ?? eligible[0];
  if (!selected) {
    throw new BusinessScopeError("UNAUTHORIZED_SCOPE", "Akses syarikat tidak dibenarkan.");
  }

  return Object.freeze({
    kind: "UNIT",
    queryValue: selected.code,
    businessUnitId: selected.id,
    businessUnitCode: selected.code,
    access: selected,
    writable: true,
  });
}

export function requireWriteBusinessUnit(
  scope: BusinessUnitReadScope,
): Pick<
  Extract<BusinessUnitReadScope, { kind: "UNIT" }>,
  "businessUnitId" | "businessUnitCode" | "access"
> {
  if (scope.kind === "ALL") {
    throw new BusinessScopeError("WRITE_SCOPE_REQUIRED", "Pilih syarikat.");
  }
  return {
    businessUnitId: scope.businessUnitId,
    businessUnitCode: scope.businessUnitCode,
    access: scope.access,
  };
}

export function serializeBusinessScope(scope: BusinessUnitReadScope): string {
  return new URLSearchParams({ bu: scope.queryValue }).toString();
}

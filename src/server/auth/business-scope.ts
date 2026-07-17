import type { Viewer, ViewerBusinessUnit, ViewerBusinessUnitAccess } from "./viewer";
import { deriveCapabilityRecordScopes } from "./capability-policy";
import { ApiError } from "@/server/http/errors";
export { parseBusinessScopeQuery, scopedHref } from "@/domain/business-units/scope-url";

export interface ClientBusinessUnitAccess {
  id: string;
  name: string;
  code: string;
  capabilities: readonly string[];
}

interface UnitMembership {
  id: string;
  businessUnitId: string | null;
}

interface MembershipCapability {
  membershipId: string;
  capability: string;
  constraints: unknown;
}

export function deriveBusinessUnitAccess(
  units: readonly ViewerBusinessUnit[],
  memberships: readonly UnitMembership[],
  capabilityRows: readonly MembershipCapability[],
): readonly ViewerBusinessUnitAccess[] {
  return units.map((unit) => {
    const applicableMemberships = memberships
      .filter(
        (membership) =>
          membership.businessUnitId === null || membership.businessUnitId === unit.id,
      )
      .sort((left, right) => {
        const leftScope = left.businessUnitId === unit.id ? 0 : 1;
        const rightScope = right.businessUnitId === unit.id ? 0 : 1;
        return leftScope - rightScope || left.id.localeCompare(right.id);
      });
    const membershipIds = applicableMemberships.map((membership) => membership.id);
    const membershipIdSet = new Set(membershipIds);
    const rows = capabilityRows.filter((row) => membershipIdSet.has(row.membershipId));

    return Object.freeze({
      ...unit,
      membershipIds: Object.freeze(membershipIds),
      capabilities: Object.freeze(
        [...new Set(rows.map((row) => row.capability))].sort(),
      ),
      capabilityRecordScopes: Object.freeze(deriveCapabilityRecordScopes(rows)),
    });
  });
}

export function deriveBusinessUnitCommandViewer(
  viewer: Viewer,
  capability: string,
  businessUnitId: string,
): Viewer {
  const access = viewer.businessUnitAccess.find(
    (unit) => unit.id === businessUnitId && unit.capabilities.includes(capability),
  );
  if (!access || access.membershipIds.length === 0) {
    throw new ApiError(
      403,
      "BUSINESS_UNIT_FORBIDDEN",
      "Akses syarikat tidak dibenarkan.",
    );
  }

  return {
    ...viewer,
    businessUnitId: access.id,
    activeMembershipId: access.membershipIds[0]!,
    membershipIds: access.membershipIds,
    capabilities: access.capabilities,
    capabilityRecordScopes: access.capabilityRecordScopes,
  };
}

export function unitsForCapability(
  access: readonly ViewerBusinessUnitAccess[],
  capability?: string,
): readonly ViewerBusinessUnitAccess[] {
  return access.filter(
    (unit) => capability === undefined || unit.capabilities.includes(capability),
  );
}

export function projectBusinessUnitAccess(
  access: readonly ViewerBusinessUnitAccess[],
): readonly ClientBusinessUnitAccess[] {
  return access.map((unit) => Object.freeze({
    id: unit.id,
    name: unit.name,
    code: unit.code,
    capabilities: Object.freeze([...new Set(unit.capabilities)].sort()),
  }));
}

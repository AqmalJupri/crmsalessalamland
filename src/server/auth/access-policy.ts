export interface ActiveMembershipScope {
  id: string;
  organizationId: string;
  businessUnitId: string | null;
}

export interface ActiveBusinessUnitScope {
  id: string;
  organizationId: string;
  code: string;
}

export interface AccessPreferences {
  organizationId?: string;
  businessUnitId?: string;
}

export interface SelectedAccessScope {
  organizationId: string;
  businessUnitId: string;
}

export function selectAccessScope(
  memberships: readonly ActiveMembershipScope[],
  businessUnits: readonly ActiveBusinessUnitScope[],
  preferences: AccessPreferences = {},
): SelectedAccessScope | null {
  if (memberships.length === 0) return null;

  const organizationIds = [...new Set(memberships.map((membership) => membership.organizationId))].sort();
  const organizationId =
    preferences.organizationId && organizationIds.includes(preferences.organizationId)
      ? preferences.organizationId
      : organizationIds[0];
  if (!organizationId) return null;

  const organizationMemberships = memberships.filter(
    (membership) => membership.organizationId === organizationId,
  );
  const organizationWide = organizationMemberships.some(
    (membership) => membership.businessUnitId === null,
  );
  const explicitlyAllowed = new Set(
    organizationMemberships.flatMap((membership) =>
      membership.businessUnitId ? [membership.businessUnitId] : [],
    ),
  );
  const allowedUnits = businessUnits
    .filter(
      (unit) =>
        unit.organizationId === organizationId &&
        (organizationWide || explicitlyAllowed.has(unit.id)),
    )
    .sort((left, right) => left.code.localeCompare(right.code) || left.id.localeCompare(right.id));
  const selectedUnit =
    allowedUnits.find((unit) => unit.id === preferences.businessUnitId) ?? allowedUnits[0];

  return selectedUnit ? { organizationId, businessUnitId: selectedUnit.id } : null;
}

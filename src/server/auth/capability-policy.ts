export type CapabilityRecordScope = "OWN" | "BUSINESS_UNIT";

export type CapabilityRecordScopes = Readonly<
  Record<string, readonly CapabilityRecordScope[]>
>;

interface CapabilityConstraintRow {
  capability: string;
  constraints: unknown;
}

function recordScopeFrom(constraints: unknown): CapabilityRecordScope | undefined {
  if (!constraints || typeof constraints !== "object" || Array.isArray(constraints)) {
    return undefined;
  }
  const scope = (constraints as Record<string, unknown>).recordScope;
  return scope === "OWN" || scope === "BUSINESS_UNIT" ? scope : undefined;
}

export function deriveCapabilityRecordScopes(
  rows: readonly CapabilityConstraintRow[],
): CapabilityRecordScopes {
  const derived = new Map<string, Set<CapabilityRecordScope>>();
  for (const row of rows) {
    const scope = recordScopeFrom(row.constraints);
    if (!scope) continue;
    const scopes = derived.get(row.capability) ?? new Set<CapabilityRecordScope>();
    scopes.add(scope);
    derived.set(row.capability, scopes);
  }

  return Object.fromEntries(
    [...derived.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([capability, scopes]) => [capability, [...scopes].sort()]),
  );
}

export function hasLeadRecordAccess(
  capabilityScopes: CapabilityRecordScopes,
  capability: string,
  effectiveMembershipIds: readonly string[],
  ownerMembershipId: string | null,
): boolean {
  const scopes = capabilityScopes[capability] ?? [];
  if (scopes.includes("BUSINESS_UNIT")) return true;
  return (
    scopes.includes("OWN") &&
    ownerMembershipId !== null &&
    effectiveMembershipIds.includes(ownerMembershipId)
  );
}

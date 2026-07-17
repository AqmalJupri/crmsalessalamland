import { describe, expect, it } from "vitest";
import type { BusinessUnitReadScope } from "./read-scope";
import * as clientScopeModule from "./client-scope";

function keysOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysOf);
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, nested]) => [key, ...keysOf(nested)]);
}

const access = {
  id: "unit-salam",
  name: "Salam Land",
  code: "salam-land",
  slug: "salam-land",
  membershipIds: ["membership-secret"],
  capabilities: ["lead.read", "lead.create"],
  capabilityRecordScopes: { "lead.update": ["BUSINESS_UNIT"] },
} as const;

describe("client business scope projection", () => {
  it("projects a unit without memberships, capabilities, or record constraints", () => {
    const scope: BusinessUnitReadScope = {
      kind: "UNIT",
      queryValue: "salam-land",
      businessUnitId: access.id,
      businessUnitCode: access.code,
      access,
      writable: true,
    };

    const projected = clientScopeModule.projectClientBusinessScope(scope);
    expect(projected).toEqual({
      kind: "UNIT",
      queryValue: "salam-land",
      businessUnitId: "unit-salam",
      businessUnitCode: "salam-land",
      businessUnitName: "Salam Land",
    });
    const keys = keysOf(projected);
    for (const internalKey of [
      "membershipIds",
      "capabilities",
      "capabilityRecordScopes",
      "access",
      "slug",
    ]) expect(keys).not.toContain(internalKey);
  });

  it("projects Semua with only display-safe unit identity", () => {
    const scope: BusinessUnitReadScope = {
      kind: "ALL",
      queryValue: "all",
      units: [access],
      unitIds: [access.id],
      writable: false,
    };

    const projected = clientScopeModule.projectClientBusinessScope(scope);
    expect(projected).toEqual({
      kind: "ALL",
      queryValue: "all",
      unitIds: ["unit-salam"],
      units: [{ id: "unit-salam", code: "salam-land", name: "Salam Land" }],
    });
    const keys = keysOf(JSON.parse(JSON.stringify(projected)));
    for (const internalKey of [
      "membershipIds",
      "capabilities",
      "capabilityRecordScopes",
    ]) expect(keys).not.toContain(internalKey);
  });
});

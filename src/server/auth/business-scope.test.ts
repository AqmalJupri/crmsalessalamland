import { describe, expect, it } from "vitest";
import {
  deriveBusinessUnitAccess,
  deriveBusinessUnitCommandViewer,
  parseBusinessScopeQuery,
  scopedHref,
  projectBusinessUnitAccess,
  unitsForCapability,
} from "./business-scope";

const access = [
  {
    id: "unit-salam",
    name: "Salam Land",
    code: "salam-land",
    slug: "salam-land",
    membershipIds: ["membership-secret"],
    capabilities: ["lead.read", "lead.create"],
    capabilityRecordScopes: { "lead.create": ["BUSINESS_UNIT"] as const },
  },
  {
    id: "unit-bumi",
    name: "Bumi Hayat Printing",
    code: "bumi-hayat",
    slug: "bumi-hayat",
    membershipIds: ["membership-bumi"],
    capabilities: ["task.read"],
    capabilityRecordScopes: {},
  },
] as const;

describe("business scope server boundary", () => {
  it("derives each unit from its own and organisation-wide memberships only", () => {
    const derived = deriveBusinessUnitAccess(
      [
        { id: "unit-salam", name: "Salam Land", code: "salam-land", slug: "salam-land" },
        { id: "unit-bumi", name: "Bumi Hayat", code: "bumi-hayat", slug: "bumi-hayat" },
      ],
      [
        { id: "membership-org", businessUnitId: null },
        { id: "membership-salam", businessUnitId: "unit-salam" },
        { id: "membership-bumi", businessUnitId: "unit-bumi" },
      ],
      [
        { membershipId: "membership-org", capability: "task.read", constraints: {} },
        {
          membershipId: "membership-salam",
          capability: "lead.read",
          constraints: { recordScope: "BUSINESS_UNIT" },
        },
        {
          membershipId: "membership-bumi",
          capability: "inventory.read",
          constraints: {},
        },
      ],
    );

    expect(derived).toEqual([
      {
        id: "unit-salam",
        name: "Salam Land",
        code: "salam-land",
        slug: "salam-land",
        membershipIds: ["membership-salam", "membership-org"],
        capabilities: ["lead.read", "task.read"],
        capabilityRecordScopes: { "lead.read": ["BUSINESS_UNIT"] },
      },
      {
        id: "unit-bumi",
        name: "Bumi Hayat",
        code: "bumi-hayat",
        slug: "bumi-hayat",
        membershipIds: ["membership-bumi", "membership-org"],
        capabilities: ["inventory.read", "task.read"],
        capabilityRecordScopes: {},
      },
    ]);
    expect(derived[1]?.capabilities).not.toContain("lead.read");
  });

  it("derives command authority from the requested unit instead of the active unit", () => {
    const commandViewer = deriveBusinessUnitCommandViewer(
      {
        userId: "user-1",
        displayName: "Agent",
        organizationId: "org-1",
        businessUnitId: "unit-bumi",
        businessUnits: access,
        businessUnitAccess: access,
        activeMembershipId: "membership-bumi",
        membershipIds: ["membership-bumi"],
        capabilities: ["task.read"],
        capabilityRecordScopes: {},
        demo: false,
      },
      "lead.create",
      "unit-salam",
    );

    expect(commandViewer).toMatchObject({
      businessUnitId: "unit-salam",
      activeMembershipId: "membership-secret",
      membershipIds: ["membership-secret"],
      capabilities: ["lead.read", "lead.create"],
      capabilityRecordScopes: { "lead.create": ["BUSINESS_UNIT"] },
    });
  });

  it("rejects missing unit command capability even when the active unit has it", () => {
    const activePrivilegedViewer = {
      userId: "user-1",
      displayName: "Agent",
      organizationId: "org-1",
      businessUnitId: "unit-salam",
      businessUnits: access,
      businessUnitAccess: access,
      activeMembershipId: "membership-secret",
      membershipIds: ["membership-secret"],
      capabilities: ["lead.create", "lead.read"],
      capabilityRecordScopes: {},
      demo: false,
    };
    expect(() => deriveBusinessUnitCommandViewer(
      activePrivilegedViewer,
      "lead.create",
      "unit-bumi",
    )).toThrowError(expect.objectContaining({ status: 403, code: "BUSINESS_UNIT_FORBIDDEN" }));
    expect(() => deriveBusinessUnitCommandViewer(
      activePrivilegedViewer,
      "lead.create",
      "unit-unknown",
    )).toThrowError(expect.objectContaining({ status: 403, code: "BUSINESS_UNIT_FORBIDDEN" }));
  });

  it.each(["all", "salam-land", "a1-b2"])('accepts one canonical scope value "%s"', (value) => {
    expect(parseBusinessScopeQuery(value)).toBe(value);
  });

  it.each([
    [null, null],
    [undefined, null],
  ])("accepts omitted scope", (value, expected) => {
    expect(parseBusinessScopeQuery(value)).toBe(expected);
  });

  it.each([
    [["salam-land", "bumi-hayat"]],
    [["salam-land"]],
    [""],
    ["salam--land"],
    ["Salam-land"],
    ["x".repeat(65)],
  ])("rejects malformed or multiple scope %j", (value) => {
    expect(() => parseBusinessScopeQuery(value)).toThrowError(
      expect.objectContaining({ code: "INVALID_SCOPE" }),
    );
  });

  it("preserves other URL parameters while replacing one safe scope", () => {
    expect(scopedHref("/leads?status=new&bu=old#today", "barakah-emas"))
      .toBe("/leads?status=new&bu=barakah-emas#today");
    expect(scopedHref("/", "all")).toBe("/?bu=all");
  });

  it("projects only client-safe unit capability data", () => {
    expect(projectBusinessUnitAccess(access)).toEqual([
      {
        id: "unit-salam",
        name: "Salam Land",
        code: "salam-land",
        capabilities: ["lead.create", "lead.read"],
      },
      {
        id: "unit-bumi",
        name: "Bumi Hayat Printing",
        code: "bumi-hayat",
        capabilities: ["task.read"],
      },
    ]);
    expect(JSON.stringify(projectBusinessUnitAccess(access))).not.toContain("membership");
    expect(JSON.stringify(projectBusinessUnitAccess(access))).not.toContain("recordScope");
  });

  it("selects per-unit capabilities for a destination", () => {
    expect(unitsForCapability(access, "lead.read").map((unit) => unit.code))
      .toEqual(["salam-land"]);
    expect(unitsForCapability(access, undefined).map((unit) => unit.code))
      .toEqual(["salam-land", "bumi-hayat"]);
  });
});

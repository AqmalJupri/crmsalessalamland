import { describe, expect, it } from "vitest";
import {
  deriveCapabilityRecordScopes,
  hasLeadRecordAccess,
} from "./capability-policy";

describe("capability record scopes", () => {
  it("fails closed for absent, malformed, or unsupported constraints", () => {
    expect(
      deriveCapabilityRecordScopes([
        { capability: "lead.update", constraints: {} },
        { capability: "lead.update", constraints: { recordScope: "TEAM" } },
        { capability: "lead.update", constraints: { recordScope: 1 } },
      ]),
    ).toEqual({});
  });

  it("derives own scope and requires an effective owner membership", () => {
    const scopes = deriveCapabilityRecordScopes([
      { capability: "lead.update", constraints: { recordScope: "OWN" } },
    ]);

    expect(
      hasLeadRecordAccess(scopes, "lead.update", ["membership-a"], "membership-a"),
    ).toBe(true);
    expect(
      hasLeadRecordAccess(scopes, "lead.update", ["membership-a"], "membership-b"),
    ).toBe(false);
    expect(hasLeadRecordAccess(scopes, "lead.update", ["membership-a"], null)).toBe(false);
  });

  it("requires an explicit business-unit scope for elevated access", () => {
    const scopes = deriveCapabilityRecordScopes([
      { capability: "lead.update", constraints: { recordScope: "OWN" } },
      { capability: "lead.update", constraints: { recordScope: "BUSINESS_UNIT" } },
    ]);

    expect(
      hasLeadRecordAccess(scopes, "lead.update", ["membership-a"], "membership-b"),
    ).toBe(true);
    expect(scopes).toEqual({ "lead.update": ["BUSINESS_UNIT", "OWN"] });
  });
});

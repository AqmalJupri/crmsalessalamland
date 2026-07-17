import { describe, expect, it } from "vitest";
import type { Viewer } from "@/server/auth/viewer";
import {
  BusinessScopeError,
  requireWriteBusinessUnit,
  resolveAuthorizedBusinessScope,
  serializeBusinessScope,
} from "./read-scope";

const units = [
  {
    id: "00000000-0000-4000-8000-000000000101",
    name: "Salam Land",
    code: "salam-land",
    slug: "salam-land",
    membershipIds: ["membership-salam"],
    capabilities: ["lead.read", "lead.create", "task.read"],
    capabilityRecordScopes: { "lead.create": ["BUSINESS_UNIT"] as const },
  },
  {
    id: "00000000-0000-4000-8000-000000000102",
    name: "Bumi Hayat Printing",
    code: "bumi-hayat",
    slug: "bumi-hayat",
    membershipIds: ["membership-bumi"],
    capabilities: ["task.read"],
    capabilityRecordScopes: {},
  },
  {
    id: "00000000-0000-4000-8000-000000000103",
    name: "Barakah Emas",
    code: "barakah-emas",
    slug: "barakah-emas",
    membershipIds: ["membership-barakah"],
    capabilities: ["lead.read"],
    capabilityRecordScopes: {},
  },
] as const;

const viewer: Viewer = {
  userId: "00000000-0000-4000-8000-000000000001",
  displayName: "Scoped Viewer",
  sessionExpiresAt: new Date("2026-07-17T12:00:00.000Z"),
  organizationId: "00000000-0000-4000-8000-000000000010",
  businessUnitId: units[1].id,
  businessUnits: units,
  businessUnitAccess: units,
  activeMembershipId: "membership-bumi",
  membershipIds: ["membership-bumi"],
  capabilities: ["task.read"],
  capabilityRecordScopes: {},
  demo: false,
};

describe("business-unit read scope", () => {
  it("resolves Semua to only units granting the requested module capability", () => {
    expect(resolveAuthorizedBusinessScope(viewer, "all", "crm", "lead.read")).toEqual({
      kind: "ALL",
      queryValue: "all",
      units: [units[0], units[2]],
      unitIds: [units[0].id, units[2].id],
      writable: false,
    });
  });

  it("resolves a valid authorised code using that unit's access, never the active unit", () => {
    expect(resolveAuthorizedBusinessScope(viewer, "salam-land", "crm", "lead.read"))
      .toMatchObject({
        kind: "UNIT",
        queryValue: "salam-land",
        businessUnitId: units[0].id,
        businessUnitCode: "salam-land",
        access: units[0],
        writable: true,
      });
  });

  it("selects the authorised active unit or deterministic first unit when omitted", () => {
    expect(resolveAuthorizedBusinessScope(viewer, null, "crm", "task.read").queryValue)
      .toBe("bumi-hayat");
    expect(resolveAuthorizedBusinessScope(viewer, null, "crm", "lead.read").queryValue)
      .toBe("salam-land");
  });

  it("limits capability-free root scope to membership-backed units", () => {
    const scope = resolveAuthorizedBusinessScope(viewer, "all", "crm");
    expect(scope.kind).toBe("ALL");
    if (scope.kind !== "ALL") throw new Error("Expected ALL scope.");
    expect(scope.units.map((unit) => unit.code)).toEqual([
      "salam-land",
      "bumi-hayat",
      "barakah-emas",
    ]);
  });

  it("restricts Tasha to Salam Land even when other access exists", () => {
    expect(resolveAuthorizedBusinessScope(viewer, "all", "tasha", "task.read"))
      .toMatchObject({ kind: "ALL", unitIds: [units[0].id] });
    expect(() => resolveAuthorizedBusinessScope(viewer, "bumi-hayat", "tasha", "task.read"))
      .toThrowError(expect.objectContaining({ code: "UNAUTHORIZED_SCOPE" }));
  });

  it.each([
    [["salam-land", "bumi-hayat"], "INVALID_SCOPE"],
    ["", "INVALID_SCOPE"],
    ["-salam", "INVALID_SCOPE"],
    ["Salam-Land", "INVALID_SCOPE"],
    ["unknown-unit", "UNAUTHORIZED_SCOPE"],
    ["bumi-hayat", "UNAUTHORIZED_SCOPE"],
  ] as const)("rejects invalid or unauthorised scope %j", (requested, code) => {
    expect(() => resolveAuthorizedBusinessScope(viewer, requested, "crm", "lead.read"))
      .toThrowError(expect.objectContaining({ code }));
  });

  it("fails closed when visible unit codes or IDs are duplicated", () => {
    for (const duplicate of [
      { ...units[2], code: units[0].code },
      { ...units[2], id: units[0].id },
    ]) {
      const broken = {
        ...viewer,
        businessUnitAccess: [units[0], units[1], duplicate],
      } satisfies Viewer;
      expect(() => resolveAuthorizedBusinessScope(broken, "all", "crm"))
        .toThrowError(expect.objectContaining({ code: "INVALID_VIEWER_SCOPE" }));
    }
  });

  it("serializes URL scope and rejects writes in Semua", () => {
    const unit = resolveAuthorizedBusinessScope(viewer, "salam-land", "crm", "lead.read");
    const all = resolveAuthorizedBusinessScope(viewer, "all", "crm", "lead.read");
    expect(serializeBusinessScope(unit)).toBe("bu=salam-land");
    expect(serializeBusinessScope(all)).toBe("bu=all");
    expect(requireWriteBusinessUnit(unit)).toEqual({
      businessUnitId: units[0].id,
      businessUnitCode: units[0].code,
      access: units[0],
    });
    expect(() => requireWriteBusinessUnit(all)).toThrowError(BusinessScopeError);
  });
});

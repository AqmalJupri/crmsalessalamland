import { describe, expect, it } from "vitest";
import { selectAccessScope } from "./access-policy";

const units = [
  { id: "bu-b", organizationId: "org-a", code: "printing" },
  { id: "bu-a", organizationId: "org-a", code: "land" },
  { id: "bu-c", organizationId: "org-b", code: "gold" },
] as const;

describe("selectAccessScope", () => {
  it("requires at least one pre-provisioned active membership", () => {
    expect(selectAccessScope([], units)).toBeNull();
  });

  it("does not honor a preferred business unit outside explicit membership", () => {
    const selected = selectAccessScope(
      [{ id: "membership-a", organizationId: "org-a", businessUnitId: "bu-a" }],
      units,
      { businessUnitId: "bu-b" },
    );

    expect(selected).toEqual({ organizationId: "org-a", businessUnitId: "bu-a" });
  });

  it("allows an organization-wide membership to select an active unit", () => {
    const selected = selectAccessScope(
      [{ id: "membership-a", organizationId: "org-a", businessUnitId: null }],
      units,
      { businessUnitId: "bu-b" },
    );

    expect(selected).toEqual({ organizationId: "org-a", businessUnitId: "bu-b" });
  });

  it("validates a preferred organization against memberships", () => {
    const selected = selectAccessScope(
      [
        { id: "membership-a", organizationId: "org-a", businessUnitId: "bu-a" },
        { id: "membership-b", organizationId: "org-b", businessUnitId: "bu-c" },
      ],
      units,
      { organizationId: "org-b" },
    );

    expect(selected).toEqual({ organizationId: "org-b", businessUnitId: "bu-c" });
  });
});

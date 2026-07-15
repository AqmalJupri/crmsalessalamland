import { describe, expect, it } from "vitest";
import { assertOwnerAssignmentAllowed } from "./assignment-policy";

const viewer = {
  membershipIds: ["membership-self"],
  capabilities: ["lead.update"],
};

describe("assertOwnerAssignmentAllowed", () => {
  it("allows no ownership change and self-assignment", () => {
    expect(() => assertOwnerAssignmentAllowed(viewer, undefined)).not.toThrow();
    expect(() => assertOwnerAssignmentAllowed(viewer, "membership-self")).not.toThrow();
  });

  it("requires lead.assign for another owner or unassignment", () => {
    expect(() => assertOwnerAssignmentAllowed(viewer, "membership-other")).toThrow(/lead\.assign/i);
    expect(() => assertOwnerAssignmentAllowed(viewer, null)).toThrow(/lead\.assign/i);
  });

  it("allows a manager to assign another active membership", () => {
    expect(() =>
      assertOwnerAssignmentAllowed(
        { ...viewer, capabilities: [...viewer.capabilities, "lead.assign"] },
        "membership-other",
      ),
    ).not.toThrow();
  });
});

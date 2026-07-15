import { describe, expect, it } from "vitest";
import { canTransitionLead, transitionLead } from "./lifecycle";

describe("transitionLead", () => {
  it("assigns a new lead when an owner exists", () => {
    expect(
      transitionLead({ from: "new", to: "assigned", ownerMembershipId: "membership-1" }).stage,
    ).toBe("assigned");
  });

  it("does not emit a change for an idempotent transition", () => {
    expect(transitionLead({ from: "contacted", to: "contacted" }).changed).toBe(false);
  });

  it("rejects a skipped lifecycle transition", () => {
    expect(() =>
      transitionLead({
        from: "new",
        to: "converted",
        ownerMembershipId: "membership-1",
        convertedOpportunityId: "opportunity-1",
      }),
    ).toThrow(/cannot move/i);
  });

  it("requires an owner when moving into an active stage", () => {
    expect(() => transitionLead({ from: "new", to: "assigned" })).toThrow(/must have an owner/i);
  });

  it("requires a reason when disqualifying", () => {
    expect(() => transitionLead({ from: "contacted", to: "disqualified" })).toThrow(/reason/i);
  });

  it("requires an opportunity when converting", () => {
    expect(() =>
      transitionLead({ from: "qualified", to: "converted", ownerMembershipId: "membership-1" }),
    ).toThrow(/opportunity/i);
  });

  it("requires explicit permission to reopen", () => {
    expect(() => transitionLead({ from: "disqualified", to: "new" })).toThrow(/permission/i);
    expect(transitionLead({ from: "disqualified", to: "new", canReopen: true }).stage).toBe("new");
  });

  it("reports idempotent, allowed, and forbidden transitions", () => {
    expect(canTransitionLead("contacted", "contacted")).toBe(true);
    expect(canTransitionLead("contacted", "qualified")).toBe(true);
    expect(canTransitionLead("new", "converted")).toBe(false);
  });
});

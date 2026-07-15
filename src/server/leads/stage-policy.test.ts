import { describe, expect, it } from "vitest";
import { assertStageTransitionAllowed } from "./stage-policy";

const open = { code: "new", category: "OPEN", isTerminal: false };
const disqualified = {
  code: "disqualified",
  category: "DISQUALIFIED",
  isTerminal: true,
};
const converted = { code: "converted", category: "CONVERTED", isTerminal: true };

describe("assertStageTransitionAllowed", () => {
  it("requires a reason for disqualification", () => {
    expect(() =>
      assertStageTransitionAllowed({ current: open, target: disqualified, canReopen: false }),
    ).toThrow(/sebab/i);
  });

  it("requires permission to leave a terminal stage", () => {
    expect(() =>
      assertStageTransitionAllowed({
        current: disqualified,
        target: open,
        reason: "Semak semula",
        canReopen: false,
      }),
    ).toThrow(/lead\.reopen/i);

    expect(() =>
      assertStageTransitionAllowed({
        current: converted,
        target: disqualified,
        reason: "Pembetulan terkawal",
        canReopen: false,
      }),
    ).toThrow(/lead\.reopen/i);
  });

  it("allows an authorised reopen", () => {
    expect(() =>
      assertStageTransitionAllowed({
        current: disqualified,
        target: open,
        reason: "Semak semula",
        canReopen: true,
      }),
    ).not.toThrow();
  });

  it("requires a reason for every authorised transition away from a terminal stage", () => {
    expect(() =>
      assertStageTransitionAllowed({
        current: disqualified,
        target: open,
        canReopen: true,
      }),
    ).toThrow(/sebab/i);
  });

  it("enforces configured capability and reason requirements", () => {
    expect(() =>
      assertStageTransitionAllowed({
        current: open,
        target: { code: "qualified", category: "OPEN", isTerminal: false },
        requiredCapability: "lead.qualify",
        capabilities: ["lead.update"],
        canReopen: false,
      }),
    ).toThrow(/kebenaran/i);

    expect(() =>
      assertStageTransitionAllowed({
        current: open,
        target: { code: "nurture", category: "ON_HOLD", isTerminal: false },
        requiresReason: true,
        capabilities: ["lead.update"],
        canReopen: false,
      }),
    ).toThrow(/sebab/i);
  });
});

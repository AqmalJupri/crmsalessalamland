import { DomainError } from "@/domain/shared/errors";

export const leadStages = [
  "new",
  "assigned",
  "contacted",
  "qualified",
  "nurture",
  "disqualified",
  "converted",
] as const;

export type LeadStage = (typeof leadStages)[number];

const allowedTransitions: Readonly<Record<LeadStage, readonly LeadStage[]>> = {
  new: ["assigned", "contacted", "disqualified"],
  assigned: ["contacted", "nurture", "disqualified"],
  contacted: ["qualified", "nurture", "disqualified"],
  qualified: ["nurture", "converted", "disqualified"],
  nurture: ["contacted", "qualified", "disqualified"],
  disqualified: ["new"],
  converted: [],
};

export interface LeadTransitionInput {
  from: LeadStage;
  to: LeadStage;
  ownerMembershipId?: string | null;
  disqualificationReason?: string | null;
  convertedOpportunityId?: string | null;
  canReopen?: boolean;
}

export interface LeadTransitionResult {
  changed: boolean;
  stage: LeadStage;
  occurredAt: Date;
}

export function transitionLead(
  input: LeadTransitionInput,
  now: Date = new Date(),
): LeadTransitionResult {
  if (input.from === input.to) {
    return { changed: false, stage: input.from, occurredAt: now };
  }

  if (input.from === "disqualified" && input.to === "new" && !input.canReopen) {
    throw new DomainError(
      "FORBIDDEN",
      "Reopening a disqualified lead requires lead.reopen permission.",
    );
  }

  if (!allowedTransitions[input.from].includes(input.to)) {
    throw new DomainError("INVALID_TRANSITION", `Lead cannot move from ${input.from} to ${input.to}.`, {
      from: input.from,
      to: input.to,
    });
  }

  if (input.to !== "new" && input.to !== "disqualified" && !input.ownerMembershipId) {
    throw new DomainError("INVARIANT_VIOLATION", "An active lead must have an owner.");
  }

  if (input.to === "disqualified" && (input.disqualificationReason?.trim().length ?? 0) < 3) {
    throw new DomainError(
      "VALIDATION_ERROR",
      "A disqualification reason of at least 3 characters is required.",
    );
  }

  if (input.to === "converted" && !input.convertedOpportunityId) {
    throw new DomainError(
      "INVARIANT_VIOLATION",
      "A converted lead must reference its opportunity.",
    );
  }

  return { changed: true, stage: input.to, occurredAt: now };
}

export function canTransitionLead(from: LeadStage, to: LeadStage): boolean {
  return from === to || allowedTransitions[from].includes(to);
}

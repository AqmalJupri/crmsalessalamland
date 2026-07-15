import { ApiError } from "@/server/http/errors";

export interface LeadStageDescriptor {
  code: string;
  category: string;
  isTerminal: boolean;
}

export interface StageTransitionPolicyInput {
  current: LeadStageDescriptor;
  target: LeadStageDescriptor;
  reason?: string | null;
  requiresReason?: boolean;
  requiredCapability?: string | null;
  capabilities?: readonly string[];
  canReopen: boolean;
}

export function assertStageTransitionAllowed({
  canReopen,
  capabilities = [],
  current,
  reason,
  requiredCapability,
  requiresReason = false,
  target,
}: StageTransitionPolicyInput): void {
  if (current.code === target.code) return;

  if (current.isTerminal && !canReopen) {
    throw new ApiError(
      403,
      "LEAD_REOPEN_FORBIDDEN",
      "Membuka semula lead memerlukan kebenaran lead.reopen.",
    );
  }

  if (requiredCapability && !capabilities.includes(requiredCapability)) {
    throw new ApiError(
      403,
      "LEAD_TRANSITION_FORBIDDEN",
      "Anda tiada kebenaran untuk peralihan ini.",
    );
  }

  if (
    (current.isTerminal ||
      requiresReason ||
      target.category === "LOST" ||
      target.category === "DISQUALIFIED") &&
    (reason?.trim().length ?? 0) < 3
  ) {
    throw new ApiError(
      422,
      "TRANSITION_REASON_REQUIRED",
      "Sebab sekurang-kurangnya 3 aksara diperlukan.",
    );
  }
}

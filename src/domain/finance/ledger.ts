import { DomainError } from "@/domain/shared/errors";

export interface DueItem {
  id: string;
  currency: string;
  dueAt: Date;
  amountMinor: bigint;
  allocatedMinor: bigint;
}

export interface PaymentAllocation {
  dueItemId: string;
  amountMinor: bigint;
}

export interface AllocationResult {
  allocations: PaymentAllocation[];
  unappliedMinor: bigint;
}

export function allocatePayment(
  paymentMinor: bigint,
  currency: string,
  dueItems: readonly DueItem[],
): AllocationResult {
  if (paymentMinor <= 0n) {
    throw new DomainError("VALIDATION_ERROR", "Payment amount must be greater than zero.");
  }

  const ordered = [...dueItems].sort(
    (left, right) => left.dueAt.getTime() - right.dueAt.getTime() || left.id.localeCompare(right.id),
  );
  const allocations: PaymentAllocation[] = [];
  let remaining = paymentMinor;

  for (const dueItem of ordered) {
    if (dueItem.currency !== currency) {
      throw new DomainError("VALIDATION_ERROR", "Payment and due items must use one currency.");
    }
    if (dueItem.amountMinor < 0n || dueItem.allocatedMinor < 0n) {
      throw new DomainError("INVARIANT_VIOLATION", "Ledger amounts cannot be negative.");
    }
    if (dueItem.allocatedMinor > dueItem.amountMinor) {
      throw new DomainError("INVARIANT_VIOLATION", "A due item is over-allocated.");
    }
    if (remaining === 0n) break;

    const outstanding = dueItem.amountMinor - dueItem.allocatedMinor;
    if (outstanding === 0n) continue;
    const amountMinor = remaining < outstanding ? remaining : outstanding;
    allocations.push({ dueItemId: dueItem.id, amountMinor });
    remaining -= amountMinor;
  }

  return { allocations, unappliedMinor: remaining };
}

export interface RefundPolicyInput {
  requestedMinor: bigint;
  collectedMinor: bigint;
  previouslyRefundedMinor: bigint;
  reason: string;
  requestedBy: string;
  approvedBy?: string | null;
  makerCheckerThresholdMinor: bigint;
}

export function assertRefundAllowed(input: RefundPolicyInput): void {
  if (input.requestedMinor <= 0n) {
    throw new DomainError("VALIDATION_ERROR", "Refund amount must be greater than zero.");
  }
  if (input.collectedMinor < 0n || input.previouslyRefundedMinor < 0n) {
    throw new DomainError("INVARIANT_VIOLATION", "Ledger totals cannot be negative.");
  }
  const refundableMinor = input.collectedMinor - input.previouslyRefundedMinor;
  if (input.requestedMinor > refundableMinor) {
    throw new DomainError("CONFLICT", "Refund exceeds the remaining refundable amount.", {
      refundableMinor: refundableMinor.toString(),
    });
  }
  if (input.reason.trim().length < 8) {
    throw new DomainError("VALIDATION_ERROR", "Refund reason must be at least 8 characters.");
  }
  if (input.requestedMinor >= input.makerCheckerThresholdMinor) {
    if (!input.approvedBy) {
      throw new DomainError("FORBIDDEN", "This refund requires approval.");
    }
    if (input.approvedBy === input.requestedBy) {
      throw new DomainError("FORBIDDEN", "The requester cannot approve this refund.");
    }
  }
}

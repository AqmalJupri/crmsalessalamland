import { describe, expect, it } from "vitest";
import { allocatePayment, assertRefundAllowed } from "./ledger";

describe("finance ledger", () => {
  it("rejects a non-positive payment before allocation", () => {
    expect(() => allocatePayment(0n, "MYR", [])).toThrow(/greater than zero/i);
  });

  it("allocates oldest due items first and leaves credit unapplied", () => {
    const result = allocatePayment(15_000n, "MYR", [
      {
        id: "later",
        currency: "MYR",
        dueAt: new Date("2026-09-01"),
        amountMinor: 5_000n,
        allocatedMinor: 0n,
      },
      {
        id: "earlier",
        currency: "MYR",
        dueAt: new Date("2026-08-01"),
        amountMinor: 8_000n,
        allocatedMinor: 3_000n,
      },
    ]);

    expect(result.allocations).toEqual([
      { dueItemId: "earlier", amountMinor: 5_000n },
      { dueItemId: "later", amountMinor: 5_000n },
    ]);
    expect(result.unappliedMinor).toBe(5_000n);
  });

  it("uses the due item id to break equal-date ties", () => {
    const dueAt = new Date("2026-08-01");

    expect(
      allocatePayment(500n, "MYR", [
        { id: "z-last", currency: "MYR", dueAt, amountMinor: 1_000n, allocatedMinor: 0n },
        { id: "a-first", currency: "MYR", dueAt, amountMinor: 1_000n, allocatedMinor: 0n },
      ]),
    ).toEqual({
      allocations: [{ dueItemId: "a-first", amountMinor: 500n }],
      unappliedMinor: 0n,
    });
  });

  it("skips settled items and stops once the payment is consumed", () => {
    const result = allocatePayment(500n, "MYR", [
      {
        id: "settled",
        currency: "MYR",
        dueAt: new Date("2026-08-01"),
        amountMinor: 1_000n,
        allocatedMinor: 1_000n,
      },
      {
        id: "payable",
        currency: "MYR",
        dueAt: new Date("2026-09-01"),
        amountMinor: 500n,
        allocatedMinor: 0n,
      },
      {
        id: "untouched",
        currency: "MYR",
        dueAt: new Date("2026-10-01"),
        amountMinor: 500n,
        allocatedMinor: 0n,
      },
    ]);

    expect(result).toEqual({
      allocations: [{ dueItemId: "payable", amountMinor: 500n }],
      unappliedMinor: 0n,
    });
  });

  it("does not allow cross-currency allocation", () => {
    expect(() =>
      allocatePayment(1_000n, "MYR", [
        {
          id: "due-1",
          currency: "USD",
          dueAt: new Date("2026-08-01"),
          amountMinor: 1_000n,
          allocatedMinor: 0n,
        },
      ]),
    ).toThrow(/currency/i);
  });

  it.each([
    ["negative due amount", -1n, 0n],
    ["negative allocated amount", 1_000n, -1n],
  ])("rejects a %s", (_label, amountMinor, allocatedMinor) => {
    expect(() =>
      allocatePayment(1_000n, "MYR", [
        {
          id: "due-1",
          currency: "MYR",
          dueAt: new Date("2026-08-01"),
          amountMinor,
          allocatedMinor,
        },
      ]),
    ).toThrow(/cannot be negative/i);
  });

  it("rejects a due item allocated above its amount", () => {
    expect(() =>
      allocatePayment(1_000n, "MYR", [
        {
          id: "due-1",
          currency: "MYR",
          dueAt: new Date("2026-08-01"),
          amountMinor: 1_000n,
          allocatedMinor: 1_001n,
        },
      ]),
    ).toThrow(/over-allocated/i);
  });

  it("rejects a refund above collected value", () => {
    expect(() =>
      assertRefundAllowed({
        requestedMinor: 9_001n,
        collectedMinor: 10_000n,
        previouslyRefundedMinor: 1_000n,
        reason: "Customer cancellation",
        requestedBy: "user-1",
        approvedBy: "user-2",
        makerCheckerThresholdMinor: 5_000n,
      }),
    ).toThrow(/exceeds/i);
  });

  it("rejects a non-positive refund", () => {
    expect(() =>
      assertRefundAllowed({
        requestedMinor: 0n,
        collectedMinor: 10_000n,
        previouslyRefundedMinor: 0n,
        reason: "Customer cancellation",
        requestedBy: "user-1",
        makerCheckerThresholdMinor: 5_000n,
      }),
    ).toThrow(/greater than zero/i);
  });

  it.each([
    ["collected total", -1n, 0n],
    ["previously refunded total", 10_000n, -1n],
  ])("rejects a negative %s", (_label, collectedMinor, previouslyRefundedMinor) => {
    expect(() =>
      assertRefundAllowed({
        requestedMinor: 1_000n,
        collectedMinor,
        previouslyRefundedMinor,
        reason: "Customer cancellation",
        requestedBy: "user-1",
        makerCheckerThresholdMinor: 5_000n,
      }),
    ).toThrow(/totals cannot be negative/i);
  });

  it("requires a substantive refund reason", () => {
    expect(() =>
      assertRefundAllowed({
        requestedMinor: 1_000n,
        collectedMinor: 10_000n,
        previouslyRefundedMinor: 0n,
        reason: " short ",
        requestedBy: "user-1",
        makerCheckerThresholdMinor: 5_000n,
      }),
    ).toThrow(/at least 8 characters/i);
  });

  it("enforces maker-checker at the configured threshold", () => {
    expect(() =>
      assertRefundAllowed({
        requestedMinor: 5_000n,
        collectedMinor: 10_000n,
        previouslyRefundedMinor: 0n,
        reason: "Approved cancellation",
        requestedBy: "user-1",
        approvedBy: "user-1",
        makerCheckerThresholdMinor: 5_000n,
      }),
    ).toThrow(/requester/i);
  });

  it("requires an approver at the maker-checker threshold", () => {
    expect(() =>
      assertRefundAllowed({
        requestedMinor: 5_000n,
        collectedMinor: 10_000n,
        previouslyRefundedMinor: 0n,
        reason: "Approved cancellation",
        requestedBy: "user-1",
        makerCheckerThresholdMinor: 5_000n,
      }),
    ).toThrow(/requires approval/i);
  });

  it("allows refunds below the approval threshold and independently approved refunds", () => {
    expect(() =>
      assertRefundAllowed({
        requestedMinor: 4_999n,
        collectedMinor: 10_000n,
        previouslyRefundedMinor: 0n,
        reason: "Customer cancellation",
        requestedBy: "user-1",
        makerCheckerThresholdMinor: 5_000n,
      }),
    ).not.toThrow();

    expect(() =>
      assertRefundAllowed({
        requestedMinor: 5_000n,
        collectedMinor: 10_000n,
        previouslyRefundedMinor: 0n,
        reason: "Customer cancellation",
        requestedBy: "user-1",
        approvedBy: "user-2",
        makerCheckerThresholdMinor: 5_000n,
      }),
    ).not.toThrow();
  });
});

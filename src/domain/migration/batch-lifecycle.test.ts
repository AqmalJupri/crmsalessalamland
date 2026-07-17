import { describe, expect, it } from "vitest";
import {
  assertAuthorityTransition,
  assertImportBatchTransition,
  assertPartialApprovalAllowed,
} from "./batch-lifecycle";
import {
  MigrationPolicyError,
  type AuthorityState,
  type BatchValidationSummary,
  type ImportBatchStatus,
  type SourceMode,
} from "./types";

const batchStatuses = [
  "REGISTERED",
  "STAGED",
  "VALIDATED",
  "DRY_RUN_COMPLETE",
  "APPROVED",
  "APPLYING",
  "APPLIED",
  "RECONCILED",
  "REJECTED",
  "FAILED",
] as const satisfies readonly ImportBatchStatus[];

const allowedBatchEdges = new Set<string>([
  "REGISTERED->STAGED",
  "REGISTERED->REJECTED",
  "REGISTERED->FAILED",
  "STAGED->VALIDATED",
  "STAGED->REJECTED",
  "STAGED->FAILED",
  "VALIDATED->DRY_RUN_COMPLETE",
  "VALIDATED->APPROVED",
  "VALIDATED->REJECTED",
  "VALIDATED->FAILED",
  "APPROVED->APPLYING",
  "APPROVED->FAILED",
  "APPLYING->APPLIED",
  "APPLYING->FAILED",
  "APPLIED->RECONCILED",
]);

const batchTransitionCases = batchStatuses.flatMap((from) =>
  batchStatuses.map((to) => ({
    allowed: allowedBatchEdges.has(`${from}->${to}`),
    from,
    to,
  })),
);

const sourceModes = [
  "ONE_TIME_MIGRATION",
  "RECURRING_READ_ONLY_SNAPSHOT",
] as const satisfies readonly SourceMode[];

const authorityStates = [
  "LEGACY_WRITABLE",
  "EXTERNAL_SYSTEM_AUTHORITY",
  "SHADOW_READ",
  "CANONICAL_WRITABLE",
] as const satisfies readonly AuthorityState[];

function isAuthorityTransitionAllowed(input: {
  sourceMode: SourceMode;
  from: AuthorityState;
  to: AuthorityState;
  cutoverApproved: boolean;
}): boolean {
  if (
    input.sourceMode === "ONE_TIME_MIGRATION" &&
    input.from === "LEGACY_WRITABLE" &&
    input.to === "SHADOW_READ"
  ) {
    return true;
  }

  if (
    input.sourceMode === "ONE_TIME_MIGRATION" &&
    input.from === "SHADOW_READ" &&
    input.to === "CANONICAL_WRITABLE"
  ) {
    return input.cutoverApproved;
  }

  if (
    input.sourceMode === "RECURRING_READ_ONLY_SNAPSHOT" &&
    input.from === "EXTERNAL_SYSTEM_AUTHORITY" &&
    input.to === "SHADOW_READ"
  ) {
    return input.cutoverApproved;
  }

  return (
    input.sourceMode === "RECURRING_READ_ONLY_SNAPSHOT" &&
    input.from === "SHADOW_READ" &&
    input.to === "CANONICAL_WRITABLE" &&
    input.cutoverApproved
  );
}

const authorityTransitionCases = sourceModes.flatMap((sourceMode) =>
  authorityStates.flatMap((from) =>
    authorityStates.flatMap((to) =>
      [false, true].map((cutoverApproved) => {
        const input = { sourceMode, from, to, cutoverApproved };
        return { allowed: isAuthorityTransitionAllowed(input), ...input };
      }),
    ),
  ),
);

function capturePolicyError(operation: () => void): MigrationPolicyError {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(MigrationPolicyError);
    return error as MigrationPolicyError;
  }

  throw new Error("Expected migration policy operation to fail.");
}

describe("assertImportBatchTransition", () => {
  it.each(batchTransitionCases)(
    "$from -> $to has allowed=$allowed",
    ({ allowed, from, to }) => {
      const operation = () => assertImportBatchTransition(from, to);

      if (allowed) {
        expect(operation).not.toThrow();
        return;
      }

      const error = capturePolicyError(operation);
      expect(error.code).toBe("INVALID_TRANSITION");
      expect(error.details).toMatchObject({ from, to });
    },
  );

  it("requires live promotion to create a separate batch instead of changing the dry run", () => {
    expect(() =>
      assertImportBatchTransition("DRY_RUN_COMPLETE", "REGISTERED"),
    ).toThrow(MigrationPolicyError);
  });

  it("does not use a batch-status self-write as retry authorization", () => {
    expect(() => assertImportBatchTransition("APPLYING", "APPLYING")).toThrow(
      MigrationPolicyError,
    );
  });

  it.each([
    { from: "UNKNOWN", to: "STAGED" },
    { from: "REGISTERED", to: "UNKNOWN" },
  ])("fails closed for runtime batch vocabulary $from -> $to", ({ from, to }) => {
    const error = capturePolicyError(() =>
      assertImportBatchTransition(
        from as unknown as ImportBatchStatus,
        to as unknown as ImportBatchStatus,
      ),
    );

    expect(error.code).toBe("INVALID_TRANSITION");
    expect(error.details).toMatchObject({ policy: "IMPORT_BATCH", from, to });
  });
});

describe("assertPartialApprovalAllowed", () => {
  const validSummary: BatchValidationSummary = {
    totalRows: 10,
    validRows: 7,
    rejectedRows: 3,
    quarantinedRows: 0,
    hiddenRows: 0,
  };

  it("allows a consistent reviewed subset with valid and rejected rows", () => {
    expect(() => assertPartialApprovalAllowed(validSummary)).not.toThrow();
  });

  it("does not mutate its summary", () => {
    const summary = Object.freeze({ ...validSummary });
    expect(() => assertPartialApprovalAllowed(summary)).not.toThrow();
    expect(summary).toEqual(validSummary);
  });

  it.each([
    {
      name: "open quarantine",
      summary: { ...validSummary, validRows: 6, quarantinedRows: 1 },
    },
    {
      name: "hidden row",
      summary: { ...validSummary, validRows: 6, hiddenRows: 1 },
    },
    {
      name: "inconsistent total",
      summary: { ...validSummary, totalRows: 11 },
    },
    {
      name: "zero rows",
      summary: {
        totalRows: 0,
        validRows: 0,
        rejectedRows: 0,
        quarantinedRows: 0,
        hiddenRows: 0,
      },
    },
    {
      name: "all rejected",
      summary: { ...validSummary, validRows: 0, rejectedRows: 10 },
    },
    {
      name: "all valid",
      summary: { ...validSummary, validRows: 10, rejectedRows: 0 },
    },
    {
      name: "negative count",
      summary: { ...validSummary, validRows: -1, rejectedRows: 11 },
    },
    {
      name: "fractional count",
      summary: { ...validSummary, validRows: 6.5, rejectedRows: 3.5 },
    },
    {
      name: "NaN count",
      summary: { ...validSummary, validRows: Number.NaN },
    },
    {
      name: "positive infinity",
      summary: { ...validSummary, validRows: Number.POSITIVE_INFINITY },
    },
    {
      name: "negative infinity",
      summary: { ...validSummary, rejectedRows: Number.NEGATIVE_INFINITY },
    },
    {
      name: "unsafe integer",
      summary: {
        ...validSummary,
        totalRows: Number.MAX_SAFE_INTEGER + 1,
        validRows: Number.MAX_SAFE_INTEGER + 1,
      },
    },
  ] satisfies readonly {
    name: string;
    summary: BatchValidationSummary;
  }[])("rejects $name", ({ summary }) => {
    const error = capturePolicyError(() => assertPartialApprovalAllowed(summary));
    expect(error.code).toBe("VALIDATION_ERROR");
    expect(error.details).toMatchObject({ policy: "PARTIAL_APPROVAL" });
  });

  it("accepts a resolved quarantine only after it is represented as valid or rejected", () => {
    expect(() =>
      assertPartialApprovalAllowed({
        totalRows: 2,
        validRows: 1,
        rejectedRows: 1,
        quarantinedRows: 0,
        hiddenRows: 0,
      }),
    ).not.toThrow();
  });

  it("reports the zero valid-row count that blocks partial approval", () => {
    const error = capturePolicyError(() =>
      assertPartialApprovalAllowed({
        totalRows: 2,
        validRows: 0,
        rejectedRows: 2,
        quarantinedRows: 0,
        hiddenRows: 0,
      }),
    );

    expect(error.details).toMatchObject({ validRows: 0 });
  });

  it("reports the zero rejected-row count that requires full approval", () => {
    const error = capturePolicyError(() =>
      assertPartialApprovalAllowed({
        totalRows: 2,
        validRows: 2,
        rejectedRows: 0,
        quarantinedRows: 0,
        hiddenRows: 0,
      }),
    );

    expect(error.details).toMatchObject({ rejectedRows: 0 });
  });
});

describe("assertAuthorityTransition", () => {
  it.each(authorityTransitionCases)(
    "$sourceMode $from -> $to approved=$cutoverApproved has allowed=$allowed",
    ({ allowed, ...input }) => {
      const operation = () => assertAuthorityTransition(input);

      if (allowed) {
        expect(operation).not.toThrow();
        return;
      }

      const error = capturePolicyError(operation);
      expect(error.code).toBe("INVALID_TRANSITION");
      expect(error.details).toMatchObject(input);
    },
  );

  it("requires retirement approval before a recurring external source enters shadow read", () => {
    expect(() =>
      assertAuthorityTransition({
        sourceMode: "RECURRING_READ_ONLY_SNAPSHOT",
        from: "EXTERNAL_SYSTEM_AUTHORITY",
        to: "SHADOW_READ",
        cutoverApproved: false,
      }),
    ).toThrow(MigrationPolicyError);
  });

  it("treats remaining external authority as persistence, not a transition write", () => {
    expect(() =>
      assertAuthorityTransition({
        sourceMode: "RECURRING_READ_ONLY_SNAPSHOT",
        from: "EXTERNAL_SYSTEM_AUTHORITY",
        to: "EXTERNAL_SYSTEM_AUTHORITY",
        cutoverApproved: false,
      }),
    ).toThrow(MigrationPolicyError);
  });

  it.each(["false", 1])(
    "requires literal true approval instead of truthy runtime value %j",
    (cutoverApproved) => {
      const error = capturePolicyError(() =>
        assertAuthorityTransition({
          sourceMode: "ONE_TIME_MIGRATION",
          from: "SHADOW_READ",
          to: "CANONICAL_WRITABLE",
          cutoverApproved: cutoverApproved as unknown as boolean,
        }),
      );

      expect(error.details).toMatchObject({ cutoverApproved });
    },
  );

  it.each([
    {
      sourceMode: "UNKNOWN",
      from: "SHADOW_READ",
      to: "CANONICAL_WRITABLE",
    },
    {
      sourceMode: "ONE_TIME_MIGRATION",
      from: "UNKNOWN",
      to: "SHADOW_READ",
    },
    {
      sourceMode: "ONE_TIME_MIGRATION",
      from: "LEGACY_WRITABLE",
      to: "UNKNOWN",
    },
  ])(
    "fails closed for runtime authority vocabulary $sourceMode $from -> $to",
    ({ sourceMode, from, to }) => {
      const error = capturePolicyError(() =>
        assertAuthorityTransition({
          sourceMode: sourceMode as unknown as SourceMode,
          from: from as unknown as AuthorityState,
          to: to as unknown as AuthorityState,
          cutoverApproved: true,
        }),
      );

      expect(error.code).toBe("INVALID_TRANSITION");
      expect(error.details).toMatchObject({ policy: "AUTHORITY", sourceMode, from, to });
    },
  );
});

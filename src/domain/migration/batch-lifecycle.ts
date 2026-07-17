import {
  MigrationPolicyError,
  type AuthorityState,
  type BatchValidationSummary,
  type ImportBatchStatus,
  type SourceMode,
} from "./types";

const IMPORT_BATCH_TRANSITIONS: Readonly<
  Record<ImportBatchStatus, readonly ImportBatchStatus[]>
> = Object.freeze({
  REGISTERED: Object.freeze(["STAGED", "REJECTED", "FAILED"] as const),
  STAGED: Object.freeze(["VALIDATED", "REJECTED", "FAILED"] as const),
  VALIDATED: Object.freeze(
    ["DRY_RUN_COMPLETE", "APPROVED", "REJECTED", "FAILED"] as const,
  ),
  DRY_RUN_COMPLETE: Object.freeze([]),
  APPROVED: Object.freeze(["APPLYING", "FAILED"] as const),
  APPLYING: Object.freeze(["APPLIED", "FAILED"] as const),
  APPLIED: Object.freeze(["RECONCILED"] as const),
  RECONCILED: Object.freeze([]),
  REJECTED: Object.freeze([]),
  FAILED: Object.freeze([]),
});

type CutoverApprovalRequirement = "OPTIONAL" | "REQUIRED";

interface AuthorityTransitionRule {
  readonly from: AuthorityState;
  readonly to: AuthorityState;
  readonly cutoverApproval: CutoverApprovalRequirement;
}

const AUTHORITY_TRANSITION_RULES: Readonly<
  Record<SourceMode, readonly AuthorityTransitionRule[]>
> = Object.freeze({
  ONE_TIME_MIGRATION: Object.freeze([
    Object.freeze({
      from: "LEGACY_WRITABLE",
      to: "SHADOW_READ",
      cutoverApproval: "OPTIONAL",
    }),
    Object.freeze({
      from: "SHADOW_READ",
      to: "CANONICAL_WRITABLE",
      cutoverApproval: "REQUIRED",
    }),
  ]),
  RECURRING_READ_ONLY_SNAPSHOT: Object.freeze([
    Object.freeze({
      from: "EXTERNAL_SYSTEM_AUTHORITY",
      to: "SHADOW_READ",
      cutoverApproval: "REQUIRED",
    }),
    Object.freeze({
      from: "SHADOW_READ",
      to: "CANONICAL_WRITABLE",
      cutoverApproval: "REQUIRED",
    }),
  ]),
});

const AUTHORITY_STATES = Object.freeze([
  "LEGACY_WRITABLE",
  "EXTERNAL_SYSTEM_AUTHORITY",
  "SHADOW_READ",
  "CANONICAL_WRITABLE",
] as const satisfies readonly AuthorityState[]);

const VALIDATION_COUNT_FIELDS = Object.freeze([
  "totalRows",
  "validRows",
  "rejectedRows",
  "quarantinedRows",
  "hiddenRows",
] as const satisfies readonly (keyof BatchValidationSummary)[]);

function isImportBatchStatus(value: unknown): value is ImportBatchStatus {
  return typeof value === "string" && Object.hasOwn(IMPORT_BATCH_TRANSITIONS, value);
}

function isSourceMode(value: unknown): value is SourceMode {
  return typeof value === "string" && Object.hasOwn(AUTHORITY_TRANSITION_RULES, value);
}

function isAuthorityState(value: unknown): value is AuthorityState {
  return typeof value === "string" && AUTHORITY_STATES.some((state) => state === value);
}

export function assertImportBatchTransition(
  from: ImportBatchStatus,
  to: ImportBatchStatus,
): void {
  if (
    isImportBatchStatus(from) &&
    isImportBatchStatus(to) &&
    IMPORT_BATCH_TRANSITIONS[from].includes(to)
  ) {
    return;
  }

  throw new MigrationPolicyError(
    "INVALID_TRANSITION",
    `Import batch cannot move from ${from} to ${to}.`,
    { policy: "IMPORT_BATCH", from, to },
  );
}

function throwPartialApprovalError(
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): never {
  throw new MigrationPolicyError("VALIDATION_ERROR", message, {
    policy: "PARTIAL_APPROVAL",
    ...details,
  });
}

export function assertPartialApprovalAllowed(summary: BatchValidationSummary): void {
  for (const field of VALIDATION_COUNT_FIELDS) {
    const value = summary[field];
    if (!Number.isSafeInteger(value) || value < 0) {
      throwPartialApprovalError("Import row counts must be non-negative safe integers.", {
        field,
        value,
      });
    }
  }

  const classifiedRows =
    BigInt(summary.validRows) +
    BigInt(summary.rejectedRows) +
    BigInt(summary.quarantinedRows) +
    BigInt(summary.hiddenRows);

  if (BigInt(summary.totalRows) !== classifiedRows) {
    throwPartialApprovalError("Import row totals are inconsistent.", {
      classifiedRows: classifiedRows.toString(),
      totalRows: summary.totalRows,
    });
  }

  if (summary.hiddenRows > 0) {
    throwPartialApprovalError("Hidden rows cannot be approved.", {
      hiddenRows: summary.hiddenRows,
    });
  }

  if (summary.quarantinedRows > 0) {
    throwPartialApprovalError("Every quarantined row requires a reviewed disposition.", {
      quarantinedRows: summary.quarantinedRows,
    });
  }

  if (summary.validRows === 0) {
    throwPartialApprovalError("Partial approval requires at least one valid row.", {
      validRows: summary.validRows,
    });
  }

  if (summary.rejectedRows === 0) {
    throwPartialApprovalError("A batch without rejected rows requires full approval.", {
      rejectedRows: summary.rejectedRows,
    });
  }
}

export function assertAuthorityTransition(input: {
  sourceMode: SourceMode;
  from: AuthorityState;
  to: AuthorityState;
  cutoverApproved: boolean;
}): void {
  const rule =
    isSourceMode(input.sourceMode) &&
    isAuthorityState(input.from) &&
    isAuthorityState(input.to)
      ? AUTHORITY_TRANSITION_RULES[input.sourceMode].find(
          ({ from, to }) => from === input.from && to === input.to,
        )
      : undefined;

  if (
    rule &&
    (rule.cutoverApproval === "OPTIONAL" || input.cutoverApproved === true)
  ) {
    return;
  }

  throw new MigrationPolicyError(
    "INVALID_TRANSITION",
    rule
      ? "The authority transition requires an approved cutover."
      : `Authority cannot move from ${input.from} to ${input.to} for ${input.sourceMode}.`,
    {
      policy: "AUTHORITY",
      sourceMode: input.sourceMode,
      from: input.from,
      to: input.to,
      cutoverApproved: input.cutoverApproved,
    },
  );
}

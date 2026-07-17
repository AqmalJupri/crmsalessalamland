import type { VisualSourceBinding } from "./visual-baseline-binding";

export interface VisualRuntimeAuthority {
  os: string;
  runnerImage: string;
  runnerArch: string;
  playwrightVersion: string;
  browserName: string;
  browserVersion: string;
}

export interface ExpectedVisualBaselineAuthority {
  sourceBinding: VisualSourceBinding;
  referenceLock: string;
  runtime: VisualRuntimeAuthority;
}

type UnknownRecord = Record<string, unknown>;

function requireRecord(value: unknown, label: string): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Visual baseline ${label} must be an object.`);
  }
  return value as UnknownRecord;
}

function assertAuthorityValue(
  label: string,
  actual: unknown,
  expected: string | number | boolean,
): void {
  if (actual !== expected) {
    throw new Error(
      `Visual baseline authority mismatch for ${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}.`,
    );
  }
}

export function assertReviewedVisualBaselineAuthority(
  value: unknown,
  expected: ExpectedVisualBaselineAuthority,
): void {
  const provenance = requireRecord(value, "provenance");
  const sourceBinding = requireRecord(
    provenance.sourceBinding,
    "sourceBinding",
  );
  const capture = requireRecord(provenance.capture, "capture");
  const review = requireRecord(provenance.review, "review");

  if (
    typeof provenance.sourceCommit !== "string" ||
    !/^[0-9a-f]{40}$/.test(provenance.sourceCommit)
  ) {
    throw new Error(
      "Visual baseline authority mismatch for sourceCommit: expected an exact Git commit.",
    );
  }
  if (
    typeof review.reviewer !== "string" ||
    !review.reviewer.trim() ||
    review.reviewer === "PENDING"
  ) {
    throw new Error(
      "Visual baseline authority mismatch for review.reviewer: expected a named completed review.",
    );
  }

  assertAuthorityValue("schemaVersion", provenance.schemaVersion, 2);
  assertAuthorityValue("syntheticOnly", provenance.syntheticOnly, true);
  assertAuthorityValue("dynamicData", provenance.dynamicData, "none-present");
  assertAuthorityValue(
    "sourceBinding.algorithm",
    sourceBinding.algorithm,
    expected.sourceBinding.algorithm,
  );
  assertAuthorityValue(
    "sourceBinding.digest",
    sourceBinding.digest,
    expected.sourceBinding.digest,
  );
  assertAuthorityValue(
    "sourceBinding.fileCount",
    sourceBinding.fileCount,
    expected.sourceBinding.fileCount,
  );
  assertAuthorityValue("review.status", review.status, "reviewed");
  assertAuthorityValue(
    "review.referenceLock",
    review.referenceLock,
    expected.referenceLock,
  );

  for (const key of [
    "os",
    "runnerImage",
    "runnerArch",
    "playwrightVersion",
    "browserName",
    "browserVersion",
  ] as const) {
    assertAuthorityValue(
      `capture.${key}`,
      capture[key],
      expected.runtime[key],
    );
  }
}

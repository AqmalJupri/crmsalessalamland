import "server-only";

import { createHash } from "node:crypto";
import { isProxy } from "node:util/types";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { assertImportBatchTransition } from "@/domain/migration/batch-lifecycle";
import { getDatabase } from "@/server/db/client";
import {
  importBatches,
  reconciliationResults,
  reconciliationRuns,
} from "@/server/db/migration-schema";
import { auditEvents, memberships, outboxEvents } from "@/server/db/schema";
import { ApiError } from "@/server/http/errors";
import {
  assertProtectedArtifactRef,
  assertSha256Digest,
  digestsEqual,
} from "./artifact-checksum";
import type { MigrationActor } from "./contracts";
import {
  canonicalRedactedMigrationMetadata,
  migrationTextLooksSensitive,
  snapshotRedactedMigrationMetadata,
} from "./redacted-metadata";
import {
  lockAndValidateMigrationSourceAuthority,
  requireActiveMigrationTenant,
  requireMigrationActorCapability,
  type MigrationDatabaseTransaction,
  validateMigrationActor,
} from "./stage-batch";

const SIGN_CAPABILITY = "migration.sign";
const MAX_REQUIREMENTS = 1_000;
const MAX_CANONICAL_REQUIREMENT_BYTES = 512_000;
const MAX_POSTGRES_INTEGER = 2_147_483_647;
const MAX_POSTGRES_BIGINT = 9_223_372_036_854_775_807n;
const MAX_REASON_LENGTH = 2_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CHECK_KEY_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/;
const SCOPE_KEY_PATTERN = /^[a-z][a-z0-9_.:-]*$/;
const MEASURE_UNIT_PATTERN = /^[A-Z][A-Z0-9]{0,31}$/;

const RECONCILIATION_KINDS = Object.freeze([
  "COUNT",
  "AMOUNT",
  "CHECKSUM",
  "UNIQUENESS",
  "REFERENCE",
  "TIMELINE",
  "LOT_ALLOCATION",
  "FINANCE_BALANCE",
  "FILE",
  "SAMPLE",
] as const);

const DERIVED_KINDS = new Set<ReconciliationKind>(["COUNT", "AMOUNT", "FINANCE_BALANCE", "CHECKSUM"]);
const AMOUNT_KINDS = new Set<ReconciliationKind>(["AMOUNT", "FINANCE_BALANCE"]);

type Database = ReturnType<typeof getDatabase>;

export type ReconciliationKind = (typeof RECONCILIATION_KINDS)[number];

export interface ReconciliationRequirement {
  checkKind: ReconciliationKind;
  checkKey: string;
  scopeKey: string;
  measureUnit: string | null;
  decimalScale: number | null;
}

export interface VerifiedReconciliationPlan {
  artifactRef: string;
  planSha256: Uint8Array;
  requiredChecksSha256: Uint8Array;
  requiredChecks: readonly ReconciliationRequirement[];
}

export interface ReconciliationPlanVerifier {
  verify(
    artifactRef: string,
    expectedPlanSha256: Uint8Array,
  ): Promise<VerifiedReconciliationPlan>;
}

export interface ReconciliationResultInput extends ReconciliationRequirement {
  sourceCount: bigint | null;
  targetCount: bigint | null;
  sourceAmount: string | null;
  targetAmount: string | null;
  sourceChecksum: Uint8Array | null;
  targetChecksum: Uint8Array | null;
  passed: boolean;
  redactedEvidence: Readonly<Record<string, unknown>>;
}

export interface RecordReconciliationRunInput {
  batchId: string;
  runNo: number;
  planArtifactRef: string;
  expectedPlanSha256: Uint8Array;
  expectedBatchVersion: number;
  results: readonly ReconciliationResultInput[];
}

export interface SignReconciliationRunInput {
  runId: string;
  expectedRunVersion: number;
  approvalReason: string;
}

interface RecordCommand {
  actor: MigrationActor;
  batchId: string;
  runNo: number;
  planArtifactRef: string;
  expectedPlanSha256: Uint8Array;
  expectedBatchVersion: number;
  results: CanonicalResult[];
}

interface SignCommand {
  actor: MigrationActor;
  runId: string;
  expectedRunVersion: number;
  approvalReason: string;
}

interface CanonicalRequirement extends ReconciliationRequirement {
  checkKind: ReconciliationKind;
}

interface CanonicalRequirementJson {
  check_kind: ReconciliationKind;
  check_key: string;
  scope_key: string;
  measure_unit: string | null;
  decimal_scale: number | null;
}

interface CanonicalResult extends CanonicalRequirement {
  sourceCount: bigint | null;
  targetCount: bigint | null;
  sourceAmount: string | null;
  targetAmount: string | null;
  sourceChecksum: Uint8Array | null;
  targetChecksum: Uint8Array | null;
  passed: boolean;
  redactedEvidence: Record<string, unknown>;
}

interface CanonicalPlan {
  artifactRef: string;
  planSha256: Uint8Array;
  requiredChecksSha256: Uint8Array;
  requirements: CanonicalRequirement[];
  requiredChecksJson: CanonicalRequirementJson[];
}

function reconciliationInputError(message: string): never {
  throw new ApiError(422, "MIGRATION_INPUT_INVALID", message);
}

function planInvalid(message: string): never {
  throw new ApiError(422, "RECONCILIATION_PLAN_INVALID", message);
}

function resultInvalid(message: string): never {
  throw new ApiError(422, "RECONCILIATION_RESULT_INVALID", message);
}

function canonicalUuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    reconciliationInputError(`${field} must be a UUID.`);
  }
  return value.toLowerCase();
}

function positiveVersion(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    reconciliationInputError(`${field} must be a positive safe integer.`);
  }
  return value as number;
}

function positiveRunNo(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > MAX_POSTGRES_INTEGER
  ) {
    reconciliationInputError("runNo must be a positive PostgreSQL integer.");
  }
  return value as number;
}

function exactDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
  failure: (message: string) => never,
  label: string,
): Record<string, unknown> {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      isProxy(value)
    ) {
      failure(`${label} must be a plain data object.`);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      failure(`${label} must be a plain data object.`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value) as Record<
      string,
      PropertyDescriptor
    >;
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key !== "string")) {
      failure(`${label} contains an invalid field.`);
    }
    const actualKeys = (keys as string[]).sort();
    const canonicalExpected = [...expectedKeys].sort();
    if (
      actualKeys.length !== canonicalExpected.length ||
      actualKeys.some((key, index) => key !== canonicalExpected[index])
    ) {
      failure(`${label} must use the exact canonical fields.`);
    }
    const snapshot: Record<string, unknown> = {};
    for (const key of expectedKeys) {
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        descriptor.enumerable !== true ||
        !Object.prototype.hasOwnProperty.call(descriptor, "value")
      ) {
        failure(`${label} cannot contain accessors or hidden fields.`);
      }
      snapshot[key] = descriptor.value;
    }
    return snapshot;
  } catch (error: unknown) {
    if (error instanceof ApiError) throw error;
    failure(`${label} could not be safely inspected.`);
  }
}

function denseDataArray(
  value: unknown,
  maximumLength: number,
  failure: (message: string) => never,
  label: string,
): unknown[] {
  try {
    if (!Array.isArray(value) || isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) {
      failure(`${label} must be a plain dense array.`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value) as Record<
      string,
      PropertyDescriptor
    >;
    const lengthDescriptor = descriptors.length;
    if (
      lengthDescriptor === undefined ||
      !Object.prototype.hasOwnProperty.call(lengthDescriptor, "value") ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      (lengthDescriptor.value as number) < 0 ||
      (lengthDescriptor.value as number) > maximumLength
    ) {
      failure(`${label} exceeds its safe bound.`);
    }
    const length = lengthDescriptor.value as number;
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.some((key) => typeof key !== "string") ||
      keys.filter((key) => key !== "length").length !== length
    ) {
      failure(`${label} must be a plain dense array.`);
    }
    const snapshot = new Array<unknown>(length);
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (
        descriptor === undefined ||
        descriptor.enumerable !== true ||
        !Object.prototype.hasOwnProperty.call(descriptor, "value")
      ) {
        failure(`${label} cannot contain accessors or sparse entries.`);
      }
      snapshot[index] = descriptor.value;
    }
    return snapshot;
  } catch (error: unknown) {
    if (error instanceof ApiError) throw error;
    failure(`${label} could not be safely inspected.`);
  }
}

function digestSnapshot(
  value: unknown,
  failure: (message: string) => never,
  field: string,
): Uint8Array {
  try {
    if (value === null || typeof value !== "object" || isProxy(value)) {
      failure(`${field} must be a SHA-256 digest.`);
    }
    assertSha256Digest(value, field);
    return new Uint8Array(value);
  } catch (error: unknown) {
    if (error instanceof ApiError && error.code !== "SHA256_DIGEST_INVALID") throw error;
    failure(`${field} must be a 32-byte SHA-256 digest.`);
  }
}

function nullableDigestSnapshot(value: unknown, field: string): Uint8Array | null {
  if (value === null) return null;
  return digestSnapshot(value, resultInvalid, field);
}

function isReconciliationKind(value: unknown): value is ReconciliationKind {
  return (
    typeof value === "string" &&
    RECONCILIATION_KINDS.some((candidate) => candidate === value)
  );
}

function canonicalRequirement(
  value: unknown,
  failure: (message: string) => never,
  label: string,
): CanonicalRequirement {
  const record = exactDataRecord(
    value,
    ["checkKind", "checkKey", "scopeKey", "measureUnit", "decimalScale"],
    failure,
    label,
  );
  if (!isReconciliationKind(record.checkKind)) {
    failure(`${label}.checkKind is invalid.`);
  }
  if (
    typeof record.checkKey !== "string" ||
    record.checkKey.length > 127 ||
    !CHECK_KEY_PATTERN.test(record.checkKey)
  ) {
    failure(`${label}.checkKey is invalid.`);
  }
  if (
    typeof record.scopeKey !== "string" ||
    record.scopeKey.length > 255 ||
    !SCOPE_KEY_PATTERN.test(record.scopeKey)
  ) {
    failure(`${label}.scopeKey is invalid.`);
  }
  const amountKind = AMOUNT_KINDS.has(record.checkKind);
  if (amountKind) {
    if (
      typeof record.measureUnit !== "string" ||
      !MEASURE_UNIT_PATTERN.test(record.measureUnit)
    ) {
      failure(`${label}.measureUnit must be a canonical bounded ASCII unit.`);
    }
    if (
      !Number.isInteger(record.decimalScale) ||
      (record.decimalScale as number) < 0 ||
      (record.decimalScale as number) > 12
    ) {
      failure(`${label}.decimalScale must be an integer from 0 through 12.`);
    }
    return {
      checkKind: record.checkKind,
      checkKey: record.checkKey,
      scopeKey: record.scopeKey,
      measureUnit: record.measureUnit,
      decimalScale: Object.is(record.decimalScale, -0) ? 0 : (record.decimalScale as number),
    };
  }
  if (record.measureUnit !== null || record.decimalScale !== null) {
    failure(`${label} cannot declare a unit or scale for this check kind.`);
  }
  return {
    checkKind: record.checkKind,
    checkKey: record.checkKey,
    scopeKey: record.scopeKey,
    measureUnit: null,
    decimalScale: null,
  };
}

function requirementIdentity(requirement: ReconciliationRequirement): string {
  return JSON.stringify([
    requirement.checkKind,
    requirement.checkKey,
    requirement.scopeKey,
    requirement.measureUnit,
    requirement.decimalScale,
  ]);
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function compareNullableUtf8(left: string | null, right: string | null): number {
  if (left === null) return right === null ? 0 : -1;
  if (right === null) return 1;
  return compareUtf8(left, right);
}

function compareRequirements(
  left: ReconciliationRequirement,
  right: ReconciliationRequirement,
): number {
  return (
    compareUtf8(left.checkKind, right.checkKind) ||
    compareUtf8(left.checkKey, right.checkKey) ||
    compareUtf8(left.scopeKey, right.scopeKey) ||
    compareNullableUtf8(left.measureUnit, right.measureUnit) ||
    (left.decimalScale === null
      ? right.decimalScale === null
        ? 0
        : -1
      : right.decimalScale === null
        ? 1
        : left.decimalScale - right.decimalScale)
  );
}

function requirementJson(requirement: CanonicalRequirement): CanonicalRequirementJson {
  return {
    check_kind: requirement.checkKind,
    check_key: requirement.checkKey,
    scope_key: requirement.scopeKey,
    measure_unit: requirement.measureUnit,
    decimal_scale: requirement.decimalScale,
  };
}

function postgresJsonbRequirementsText(
  requirements: readonly CanonicalRequirement[],
): string {
  return `[${requirements
    .map(
      (requirement) =>
        `{"check_key": ${JSON.stringify(requirement.checkKey)}, "scope_key": ${JSON.stringify(requirement.scopeKey)}, "check_kind": ${JSON.stringify(requirement.checkKind)}, "measure_unit": ${JSON.stringify(requirement.measureUnit)}, "decimal_scale": ${JSON.stringify(requirement.decimalScale)}}`,
    )
    .join(", ")}]`;
}

function canonicalPlan(
  value: unknown,
  expectedArtifactRef: string,
  expectedPlanSha256: Uint8Array,
): CanonicalPlan {
  const record = exactDataRecord(
    value,
    ["artifactRef", "planSha256", "requiredChecksSha256", "requiredChecks"],
    planInvalid,
    "verified reconciliation plan",
  );
  if (typeof record.artifactRef !== "string") {
    planInvalid("The verified plan artifact reference is invalid.");
  }
  try {
    assertProtectedArtifactRef(record.artifactRef, "verifiedPlan.artifactRef");
  } catch {
    planInvalid("The verified plan artifact reference is invalid.");
  }
  const planSha256 = digestSnapshot(record.planSha256, planInvalid, "verifiedPlan.planSha256");
  const suppliedRequiredSha256 = digestSnapshot(
    record.requiredChecksSha256,
    planInvalid,
    "verifiedPlan.requiredChecksSha256",
  );
  if (
    record.artifactRef !== expectedArtifactRef ||
    !digestsEqual(planSha256, expectedPlanSha256)
  ) {
    throw new ApiError(
      422,
      "RECONCILIATION_PLAN_MISMATCH",
      "The verified reconciliation plan does not match the requested reviewed artifact.",
    );
  }
  const requirementValues = denseDataArray(
    record.requiredChecks,
    MAX_REQUIREMENTS,
    planInvalid,
    "verifiedPlan.requiredChecks",
  );
  if (requirementValues.length === 0) {
    planInvalid("The reviewed reconciliation plan must contain at least one requirement.");
  }
  const requirements = requirementValues.map((requirement, index) =>
    canonicalRequirement(requirement, planInvalid, `verifiedPlan.requiredChecks[${index}]`),
  );
  const identities = new Set<string>();
  for (const requirement of requirements) {
    const identity = requirementIdentity(requirement);
    if (identities.has(identity)) {
      throw new ApiError(
        422,
        "RECONCILIATION_REQUIREMENT_DUPLICATE",
        "The reviewed reconciliation plan contains a duplicate requirement tuple.",
      );
    }
    identities.add(identity);
  }
  requirements.sort(compareRequirements);
  const encoded = postgresJsonbRequirementsText(requirements);
  if (Buffer.byteLength(encoded, "utf8") > MAX_CANONICAL_REQUIREMENT_BYTES) {
    planInvalid("The canonical reconciliation requirement set exceeds its safe byte bound.");
  }
  const requiredChecksSha256 = createHash("sha256").update(encoded, "utf8").digest();
  if (!digestsEqual(requiredChecksSha256, suppliedRequiredSha256)) {
    throw new ApiError(
      422,
      "RECONCILIATION_PLAN_MISMATCH",
      "The verified requirement digest does not match the canonical requirement set.",
    );
  }
  return {
    artifactRef: record.artifactRef,
    planSha256,
    requiredChecksSha256,
    requirements,
    requiredChecksJson: requirements.map(requirementJson),
  };
}

function assertNullableField(value: unknown, field: string): asserts value is null {
  if (value !== null) resultInvalid(`${field} is not valid for this reconciliation kind.`);
}

function postgresCount(value: unknown, field: string): bigint {
  if (
    typeof value !== "bigint" ||
    value < 0n ||
    value > MAX_POSTGRES_BIGINT
  ) {
    resultInvalid(`${field} must be a non-negative PostgreSQL bigint.`);
  }
  return value;
}

function fixedDecimal(value: unknown, scale: number, field: string): string {
  if (typeof value !== "string") {
    resultInvalid(`${field} must be a fixed-precision decimal string.`);
  }
  const pattern =
    scale === 0
      ? /^-?(?:0|[1-9][0-9]{0,25})$/
      : new RegExp(`^-?(?:0|[1-9][0-9]{0,25})\\.[0-9]{${scale}}$`);
  if (!pattern.test(value)) {
    resultInvalid(`${field} must use the exact reviewed scale and database precision.`);
  }
  if (value.startsWith("-") && /^-0(?:\.0+)?$/.test(value)) {
    resultInvalid(`${field} cannot encode negative zero.`);
  }
  return value;
}

function canonicalResult(value: unknown, index: number): CanonicalResult {
  const label = `results[${index}]`;
  const record = exactDataRecord(
    value,
    [
      "checkKind",
      "checkKey",
      "scopeKey",
      "measureUnit",
      "decimalScale",
      "sourceCount",
      "targetCount",
      "sourceAmount",
      "targetAmount",
      "sourceChecksum",
      "targetChecksum",
      "passed",
      "redactedEvidence",
    ],
    resultInvalid,
    label,
  );
  const requirement = canonicalRequirement(
    {
      checkKind: record.checkKind,
      checkKey: record.checkKey,
      scopeKey: record.scopeKey,
      measureUnit: record.measureUnit,
      decimalScale: record.decimalScale,
    },
    resultInvalid,
    label,
  );
  if (typeof record.passed !== "boolean") {
    resultInvalid(`${label}.passed must be an explicit boolean.`);
  }
  const redactedEvidence = snapshotRedactedMigrationMetadata(
    record.redactedEvidence,
    `${label}.redactedEvidence`,
  );
  let sourceCount: bigint | null = null;
  let targetCount: bigint | null = null;
  let sourceAmount: string | null = null;
  let targetAmount: string | null = null;
  let sourceChecksum: Uint8Array | null = null;
  let targetChecksum: Uint8Array | null = null;
  let derivedPassed: boolean | null = null;

  if (requirement.checkKind === "COUNT") {
    sourceCount = postgresCount(record.sourceCount, `${label}.sourceCount`);
    targetCount = postgresCount(record.targetCount, `${label}.targetCount`);
    assertNullableField(record.sourceAmount, `${label}.sourceAmount`);
    assertNullableField(record.targetAmount, `${label}.targetAmount`);
    assertNullableField(record.sourceChecksum, `${label}.sourceChecksum`);
    assertNullableField(record.targetChecksum, `${label}.targetChecksum`);
    derivedPassed = sourceCount === targetCount;
  } else if (AMOUNT_KINDS.has(requirement.checkKind)) {
    assertNullableField(record.sourceCount, `${label}.sourceCount`);
    assertNullableField(record.targetCount, `${label}.targetCount`);
    assertNullableField(record.sourceChecksum, `${label}.sourceChecksum`);
    assertNullableField(record.targetChecksum, `${label}.targetChecksum`);
    sourceAmount = fixedDecimal(
      record.sourceAmount,
      requirement.decimalScale as number,
      `${label}.sourceAmount`,
    );
    targetAmount = fixedDecimal(
      record.targetAmount,
      requirement.decimalScale as number,
      `${label}.targetAmount`,
    );
    derivedPassed = sourceAmount === targetAmount;
  } else if (requirement.checkKind === "CHECKSUM") {
    assertNullableField(record.sourceCount, `${label}.sourceCount`);
    assertNullableField(record.targetCount, `${label}.targetCount`);
    assertNullableField(record.sourceAmount, `${label}.sourceAmount`);
    assertNullableField(record.targetAmount, `${label}.targetAmount`);
    sourceChecksum = nullableDigestSnapshot(record.sourceChecksum, `${label}.sourceChecksum`);
    targetChecksum = nullableDigestSnapshot(record.targetChecksum, `${label}.targetChecksum`);
    if (sourceChecksum === null || targetChecksum === null) {
      resultInvalid(`${label} requires both checksum values.`);
    }
    derivedPassed = digestsEqual(sourceChecksum, targetChecksum);
  } else {
    assertNullableField(record.sourceCount, `${label}.sourceCount`);
    assertNullableField(record.targetCount, `${label}.targetCount`);
    assertNullableField(record.sourceAmount, `${label}.sourceAmount`);
    assertNullableField(record.targetAmount, `${label}.targetAmount`);
    assertNullableField(record.sourceChecksum, `${label}.sourceChecksum`);
    assertNullableField(record.targetChecksum, `${label}.targetChecksum`);
    if (Object.keys(redactedEvidence).length === 0) {
      resultInvalid(`${label}.redactedEvidence must contain reviewed redacted evidence.`);
    }
  }
  if (DERIVED_KINDS.has(requirement.checkKind) && record.passed !== derivedPassed) {
    throw new ApiError(
      422,
      "RECONCILIATION_PASSED_DISAGREEMENT",
      "The caller-provided result disagrees with the typed reconciliation values.",
    );
  }
  return {
    ...requirement,
    sourceCount,
    targetCount,
    sourceAmount,
    targetAmount,
    sourceChecksum,
    targetChecksum,
    passed: record.passed,
    redactedEvidence,
  };
}

function validateRecordCommand(
  actorInput: MigrationActor,
  input: RecordReconciliationRunInput,
): RecordCommand {
  const actor = validateMigrationActor(actorInput, SIGN_CAPABILITY);
  const record = exactDataRecord(
    input,
    [
      "batchId",
      "runNo",
      "planArtifactRef",
      "expectedPlanSha256",
      "expectedBatchVersion",
      "results",
    ],
    reconciliationInputError,
    "reconciliation record input",
  );
  if (typeof record.planArtifactRef !== "string") {
    reconciliationInputError("planArtifactRef is invalid.");
  }
  try {
    assertProtectedArtifactRef(record.planArtifactRef, "planArtifactRef");
  } catch {
    reconciliationInputError("planArtifactRef must be a protected provider reference.");
  }
  const resultValues = denseDataArray(
    record.results,
    MAX_REQUIREMENTS,
    reconciliationInputError,
    "results",
  );
  if (resultValues.length === 0) {
    reconciliationInputError("results must contain at least one reconciliation result.");
  }
  const results = resultValues.map(canonicalResult);
  const identities = new Set<string>();
  for (const result of results) {
    const identity = requirementIdentity(result);
    if (identities.has(identity)) {
      throw new ApiError(
        422,
        "RECONCILIATION_RESULT_DUPLICATE",
        "The reconciliation results contain a duplicate tuple identity.",
      );
    }
    identities.add(identity);
  }
  return {
    actor,
    batchId: canonicalUuid(record.batchId, "batchId"),
    runNo: positiveRunNo(record.runNo),
    planArtifactRef: record.planArtifactRef,
    expectedPlanSha256: digestSnapshot(
      record.expectedPlanSha256,
      reconciliationInputError,
      "expectedPlanSha256",
    ),
    expectedBatchVersion: positiveVersion(record.expectedBatchVersion, "expectedBatchVersion"),
    results,
  };
}

function validateSignCommand(
  actorInput: MigrationActor,
  input: SignReconciliationRunInput,
): SignCommand {
  const actor = validateMigrationActor(actorInput, SIGN_CAPABILITY);
  const record = exactDataRecord(
    input,
    ["runId", "expectedRunVersion", "approvalReason"],
    reconciliationInputError,
    "reconciliation sign input",
  );
  const approvalReason =
    typeof record.approvalReason === "string" ? record.approvalReason.trim() : "";
  if (
    approvalReason.length < 1 ||
    approvalReason.length > MAX_REASON_LENGTH ||
    approvalReason !== record.approvalReason ||
    migrationTextLooksSensitive(approvalReason)
  ) {
    throw new ApiError(
      422,
      "RECONCILIATION_APPROVAL_REASON_INVALID",
      "A bounded, non-sensitive approval reason is required.",
    );
  }
  return {
    actor,
    runId: canonicalUuid(record.runId, "runId"),
    expectedRunVersion: positiveVersion(record.expectedRunVersion, "expectedRunVersion"),
    approvalReason,
  };
}

function verifierMethod(
  verifier: ReconciliationPlanVerifier,
): ReconciliationPlanVerifier["verify"] {
  try {
    if (verifier === null || typeof verifier !== "object" || isProxy(verifier)) {
      planInvalid("The reconciliation plan verifier is invalid.");
    }
    let cursor: object | null = verifier;
    while (cursor !== null) {
      const descriptor = Object.getOwnPropertyDescriptor(cursor, "verify");
      if (descriptor !== undefined) {
        if (
          !Object.prototype.hasOwnProperty.call(descriptor, "value") ||
          typeof descriptor.value !== "function"
        ) {
          planInvalid("The reconciliation plan verifier cannot use an accessor.");
        }
        return descriptor.value as ReconciliationPlanVerifier["verify"];
      }
      cursor = Object.getPrototypeOf(cursor);
    }
  } catch (error: unknown) {
    if (error instanceof ApiError) throw error;
  }
  planInvalid("The reconciliation plan verifier is invalid.");
}

function actorType(userType: "HUMAN" | "SERVICE"): "USER" | "SERVICE" {
  return userType === "SERVICE" ? "SERVICE" : "USER";
}

function postgresErrorDetails(error: unknown): { code?: string; constraint?: string } {
  let current: unknown = error;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 6; depth += 1) {
    if (current === null || typeof current !== "object" || seen.has(current)) break;
    seen.add(current);
    const candidate = current as { code?: unknown; constraint_name?: unknown; cause?: unknown };
    if (typeof candidate.code === "string") {
      if (typeof candidate.constraint_name === "string") {
        return { code: candidate.code, constraint: candidate.constraint_name };
      }
      return { code: candidate.code };
    }
    current = candidate.cause;
  }
  return {};
}

async function locateBatch(
  database: Database,
  actor: MigrationActor,
  batchId: string,
): Promise<{ migrationSourceId: string }> {
  const [locator] = await database
    .select({ migrationSourceId: importBatches.migrationSourceId })
    .from(importBatches)
    .where(
      and(
        eq(importBatches.organizationId, actor.organizationId),
        eq(importBatches.businessUnitId, actor.businessUnitId),
        eq(importBatches.id, batchId),
      ),
    )
    .limit(1);
  if (!locator) throw new ApiError(404, "IMPORT_BATCH_NOT_FOUND", "Import batch not found.");
  return locator;
}

async function preflightRecord(
  database: Database,
  command: RecordCommand,
  migrationSourceId: string,
): Promise<"MUTATION" | "LIVE_REPLAY" | "TERMINAL_REPLAY"> {
  const mode = await database.transaction(async (transaction) => {
    const [batch] = await transaction
      .select({ status: importBatches.status, version: importBatches.version })
      .from(importBatches)
      .where(
        and(
          eq(importBatches.organizationId, command.actor.organizationId),
          eq(importBatches.businessUnitId, command.actor.businessUnitId),
          eq(importBatches.migrationSourceId, migrationSourceId),
          eq(importBatches.id, command.batchId),
        ),
      )
      .for("share")
      .limit(1);
    if (!batch) throw new ApiError(404, "IMPORT_BATCH_NOT_FOUND", "Import batch not found.");
    const [existing] = await transaction
      .select({ id: reconciliationRuns.id })
      .from(reconciliationRuns)
      .where(
        and(
          eq(reconciliationRuns.organizationId, command.actor.organizationId),
          eq(reconciliationRuns.businessUnitId, command.actor.businessUnitId),
          eq(reconciliationRuns.batchId, command.batchId),
          eq(reconciliationRuns.runNo, command.runNo),
        ),
      )
      .for("share")
      .limit(1);
    if (batch.status === "RECONCILED" && existing) {
      await requireActiveMigrationTenant(transaction, command.actor);
      return "TERMINAL_REPLAY" as const;
    }
    await requireActiveMigrationTenant(transaction, command.actor);
    await requireMigrationActorCapability(transaction, command.actor, SIGN_CAPABILITY);
    if (batch.status === "APPLIED") {
      if (batch.version !== command.expectedBatchVersion) {
        throw new ApiError(
          409,
          "IMPORT_BATCH_VERSION_CONFLICT",
          "The applied import batch changed before reconciliation.",
        );
      }
      await requireMigrationActorCapability(transaction, command.actor, SIGN_CAPABILITY);
      return existing ? ("LIVE_REPLAY" as const) : ("MUTATION" as const);
    }
    throw new ApiError(
      409,
      "IMPORT_BATCH_STATE_INVALID",
      "Only an applied batch or an existing terminal replay can be reconciled.",
    );
  });
  if (mode !== "MUTATION") return mode;
  await database.transaction(async (transaction) => {
    await requireActiveMigrationTenant(transaction, command.actor);
    await requireMigrationActorCapability(transaction, command.actor, SIGN_CAPABILITY);
    await lockAndValidateMigrationSourceAuthority(
      transaction,
      command.actor,
      migrationSourceId,
    );
    const [batch] = await transaction
      .select({ status: importBatches.status, version: importBatches.version })
      .from(importBatches)
      .where(
        and(
          eq(importBatches.organizationId, command.actor.organizationId),
          eq(importBatches.businessUnitId, command.actor.businessUnitId),
          eq(importBatches.migrationSourceId, migrationSourceId),
          eq(importBatches.id, command.batchId),
        ),
      )
      .for("share")
      .limit(1);
    if (!batch) throw new ApiError(404, "IMPORT_BATCH_NOT_FOUND", "Import batch not found.");
    if (batch.version !== command.expectedBatchVersion) {
      throw new ApiError(
        409,
        "IMPORT_BATCH_VERSION_CONFLICT",
        "The applied import batch changed during reconciliation preflight.",
      );
    }
    if (batch.status !== "APPLIED") {
      throw new ApiError(
        409,
        "IMPORT_BATCH_STATE_INVALID",
        "Only an applied import batch can create a reconciliation run.",
      );
    }
    await requireMigrationActorCapability(transaction, command.actor, SIGN_CAPABILITY);
  });
  return "MUTATION";
}

function assertExactResultSet(
  requirements: readonly CanonicalRequirement[],
  results: readonly CanonicalResult[],
): CanonicalResult[] {
  const requirementIdentities = new Set(requirements.map(requirementIdentity));
  if (
    results.length !== requirements.length ||
    results.some((result) => !requirementIdentities.has(requirementIdentity(result)))
  ) {
    throw new ApiError(
      422,
      "RECONCILIATION_RESULT_SET_MISMATCH",
      "The reconciliation result tuples must exactly match the reviewed requirement set.",
    );
  }
  return [...results].sort(compareRequirements);
}

function databaseAmountText(value: string | null): string | null {
  if (value === null) return null;
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [integer, fraction = ""] = unsigned.split(".");
  return `${negative ? "-" : ""}${integer}.${fraction.padEnd(12, "0")}`;
}

function nullableDigestsEqual(
  left: Uint8Array | null,
  right: Uint8Array | null,
): boolean {
  if (left === null || right === null) return left === right;
  return digestsEqual(left, right);
}

interface StoredReplayRun {
  id: string;
  runNo: number;
  status: "PENDING" | "PASSED" | "FAILED" | "SIGNED";
  planArtifactRef: string;
  planSha256: Uint8Array;
  requiredChecksSha256: Uint8Array;
  requiredCheckCount: number;
  passedCheckCount: number;
  failedCheckCount: number;
}

interface StoredReplayResult {
  checkKind: ReconciliationKind;
  checkKey: string;
  scopeKey: string;
  sourceCount: bigint | null;
  targetCount: bigint | null;
  sourceAmount: string | null;
  targetAmount: string | null;
  measureUnit: string | null;
  decimalScale: number | null;
  sourceChecksum: Uint8Array | null;
  targetChecksum: Uint8Array | null;
  passed: boolean;
  evidenceMetadata: Record<string, unknown>;
}

function exactReplayMatches(
  existing: StoredReplayRun,
  storedResults: readonly StoredReplayResult[],
  plan: CanonicalPlan,
  results: readonly CanonicalResult[],
  expectedStatus: "PASSED" | "FAILED",
  passedCount: number,
  failedCount: number,
): boolean {
  const statusMatches =
    existing.status === expectedStatus ||
    (existing.status === "SIGNED" && expectedStatus === "PASSED");
  if (
    !statusMatches ||
    existing.planArtifactRef !== plan.artifactRef ||
    !digestsEqual(existing.planSha256, plan.planSha256) ||
    !digestsEqual(existing.requiredChecksSha256, plan.requiredChecksSha256) ||
    existing.requiredCheckCount !== plan.requirements.length ||
    existing.passedCheckCount !== passedCount ||
    existing.failedCheckCount !== failedCount ||
    storedResults.length !== results.length
  ) {
    return false;
  }
  const storedByIdentity = new Map(
    storedResults.map((result) => [requirementIdentity(result), result] as const),
  );
  return results.every((result) => {
    const stored = storedByIdentity.get(requirementIdentity(result));
    return (
      stored !== undefined &&
      stored.sourceCount === result.sourceCount &&
      stored.targetCount === result.targetCount &&
      stored.sourceAmount === databaseAmountText(result.sourceAmount) &&
      stored.targetAmount === databaseAmountText(result.targetAmount) &&
      nullableDigestsEqual(stored.sourceChecksum, result.sourceChecksum) &&
      nullableDigestsEqual(stored.targetChecksum, result.targetChecksum) &&
      stored.passed === result.passed &&
      canonicalRedactedMigrationMetadata(stored.evidenceMetadata) ===
        canonicalRedactedMigrationMetadata(result.redactedEvidence)
    );
  });
}

function jsonObjectsEqual(
  left: unknown,
  right: Readonly<Record<string, unknown>>,
): boolean {
  if (left === null || typeof left !== "object" || Array.isArray(left)) return false;
  try {
    return (
      canonicalRedactedMigrationMetadata(left as Record<string, unknown>) ===
      canonicalRedactedMigrationMetadata(right)
    );
  } catch {
    return false;
  }
}

function recordEffect(
  command: Pick<
    RecordCommand,
    "actor" | "batchId" | "runNo" | "expectedBatchVersion"
  >,
  runId: string,
  plan: CanonicalPlan,
  status: "PASSED" | "FAILED",
  passedCheckCount: number,
  failedCheckCount: number,
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    runId,
    batchId: command.batchId,
    runNo: command.runNo,
    expectedBatchVersion: command.expectedBatchVersion,
    status,
    requiredCheckCount: plan.requirements.length,
    passedCheckCount,
    failedCheckCount,
    planSha256: Buffer.from(plan.planSha256).toString("hex"),
    requiredChecksSha256: Buffer.from(plan.requiredChecksSha256).toString("hex"),
    actorMembershipId: command.actor.activeMembershipId,
  };
}

function signEffect(
  command: SignCommand,
  batchId: string,
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    runId: command.runId,
    batchId,
    previousBatchStatus: "APPLIED",
    batchStatus: "RECONCILED",
    approvalReason: command.approvalReason,
    signerMembershipId: command.actor.activeMembershipId,
  };
}

function replayConflict(message: string): never {
  throw new ApiError(409, "RECONCILIATION_RUN_REPLAY_CONFLICT", message);
}

async function assertRecordReplayProof(
  transaction: MigrationDatabaseTransaction,
  command: RecordCommand,
  run: StoredReplayRun,
  effect: Readonly<Record<string, unknown>>,
): Promise<void> {
  const audits = await transaction
    .select({
      organizationId: auditEvents.organizationId,
      businessUnitId: auditEvents.businessUnitId,
      actorType: auditEvents.actorType,
      actorUserId: auditEvents.actorUserId,
      action: auditEvents.action,
      targetType: auditEvents.targetType,
      targetId: auditEvents.targetId,
      outcome: auditEvents.outcome,
      reason: auditEvents.reason,
      correlationId: auditEvents.correlationId,
      changeSummary: auditEvents.changeSummary,
    })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.organizationId, command.actor.organizationId),
        eq(auditEvents.businessUnitId, command.actor.businessUnitId),
        eq(auditEvents.targetId, run.id),
        eq(auditEvents.action, "MIGRATION_RECONCILIATION_RUN_RECORDED"),
      ),
    )
    .for("share");
  const events = await transaction
    .select({
      organizationId: outboxEvents.organizationId,
      businessUnitId: outboxEvents.businessUnitId,
      eventType: outboxEvents.eventType,
      eventVersion: outboxEvents.eventVersion,
      aggregateType: outboxEvents.aggregateType,
      aggregateId: outboxEvents.aggregateId,
      aggregateVersion: outboxEvents.aggregateVersion,
      actorType: outboxEvents.actorType,
      actorUserId: outboxEvents.actorUserId,
      correlationId: outboxEvents.correlationId,
      payload: outboxEvents.payload,
    })
    .from(outboxEvents)
    .where(
      and(
        eq(outboxEvents.organizationId, command.actor.organizationId),
        eq(outboxEvents.businessUnitId, command.actor.businessUnitId),
        eq(outboxEvents.aggregateId, run.id),
        eq(outboxEvents.eventType, "crm.migration.reconciliation_run_recorded"),
      ),
    )
    .for("share");
  const audit = audits[0];
  const event = events[0];
  if (
    audits.length !== 1 ||
    events.length !== 1 ||
    !audit ||
    !event ||
    audit.organizationId !== command.actor.organizationId ||
    audit.businessUnitId !== command.actor.businessUnitId ||
    (audit.actorType !== "USER" && audit.actorType !== "SERVICE") ||
    audit.actorUserId !== command.actor.userId ||
    audit.action !== "MIGRATION_RECONCILIATION_RUN_RECORDED" ||
    audit.targetType !== "RECONCILIATION_RUN" ||
    audit.targetId !== run.id ||
    audit.outcome !== "SUCCESS" ||
    audit.reason !== null ||
    audit.correlationId !== command.batchId ||
    !jsonObjectsEqual(audit.changeSummary, effect) ||
    event.organizationId !== command.actor.organizationId ||
    event.businessUnitId !== command.actor.businessUnitId ||
    event.eventType !== "crm.migration.reconciliation_run_recorded" ||
    event.eventVersion !== 1 ||
    event.aggregateType !== "RECONCILIATION_RUN" ||
    event.aggregateId !== run.id ||
    event.aggregateVersion !== 1 ||
    event.actorType !== audit.actorType ||
    event.actorUserId !== command.actor.userId ||
    event.correlationId !== command.batchId ||
    !jsonObjectsEqual(event.payload, effect)
  ) {
    replayConflict("The original reconciliation record effect proof is incomplete or divergent.");
  }
}

interface SignedReplayRun {
  id: string;
  runNo: number;
  status: "PENDING" | "PASSED" | "FAILED" | "SIGNED";
  version: number;
  requiredCheckCount: number;
  passedCheckCount: number;
  failedCheckCount: number;
  signedByMembershipId: string | null;
  signedAt: Date | null;
}

async function assertExactSignReplay(
  transaction: MigrationDatabaseTransaction,
  command: SignCommand,
  run: SignedReplayRun,
  batch: { status: string },
  batchId: string,
): Promise<void> {
  const effect = signEffect(command, batchId);
  const audits = await transaction
    .select({
      organizationId: auditEvents.organizationId,
      businessUnitId: auditEvents.businessUnitId,
      actorType: auditEvents.actorType,
      actorUserId: auditEvents.actorUserId,
      action: auditEvents.action,
      targetType: auditEvents.targetType,
      targetId: auditEvents.targetId,
      outcome: auditEvents.outcome,
      reason: auditEvents.reason,
      correlationId: auditEvents.correlationId,
      changeSummary: auditEvents.changeSummary,
    })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.organizationId, command.actor.organizationId),
        eq(auditEvents.businessUnitId, command.actor.businessUnitId),
        eq(auditEvents.targetId, command.runId),
        eq(auditEvents.action, "MIGRATION_RECONCILIATION_RUN_SIGNED"),
      ),
    )
    .for("share");
  const events = await transaction
    .select({
      organizationId: outboxEvents.organizationId,
      businessUnitId: outboxEvents.businessUnitId,
      eventType: outboxEvents.eventType,
      eventVersion: outboxEvents.eventVersion,
      aggregateType: outboxEvents.aggregateType,
      aggregateId: outboxEvents.aggregateId,
      aggregateVersion: outboxEvents.aggregateVersion,
      actorType: outboxEvents.actorType,
      actorUserId: outboxEvents.actorUserId,
      correlationId: outboxEvents.correlationId,
      payload: outboxEvents.payload,
    })
    .from(outboxEvents)
    .where(
      and(
        eq(outboxEvents.organizationId, command.actor.organizationId),
        eq(outboxEvents.businessUnitId, command.actor.businessUnitId),
        eq(outboxEvents.aggregateId, command.runId),
        eq(outboxEvents.eventType, "crm.migration.reconciliation_run_signed"),
      ),
    )
    .for("share");
  const audit = audits[0];
  const event = events[0];
  if (
    batch.status !== "RECONCILED" ||
    run.status !== "SIGNED" ||
    command.expectedRunVersion !== run.version - 1 ||
    run.signedByMembershipId !== command.actor.activeMembershipId ||
    run.signedAt === null ||
    audits.length !== 1 ||
    events.length !== 1 ||
    !audit ||
    !event ||
    audit.organizationId !== command.actor.organizationId ||
    audit.businessUnitId !== command.actor.businessUnitId ||
    (audit.actorType !== "USER" && audit.actorType !== "SERVICE") ||
    audit.actorUserId !== command.actor.userId ||
    audit.action !== "MIGRATION_RECONCILIATION_RUN_SIGNED" ||
    audit.targetType !== "RECONCILIATION_RUN" ||
    audit.targetId !== command.runId ||
    audit.outcome !== "SUCCESS" ||
    audit.reason !== command.approvalReason ||
    audit.correlationId !== batchId ||
    !jsonObjectsEqual(audit.changeSummary, effect) ||
    event.organizationId !== command.actor.organizationId ||
    event.businessUnitId !== command.actor.businessUnitId ||
    event.eventType !== "crm.migration.reconciliation_run_signed" ||
    event.eventVersion !== 1 ||
    event.aggregateType !== "RECONCILIATION_RUN" ||
    event.aggregateId !== command.runId ||
    event.aggregateVersion !== run.version ||
    event.actorType !== audit.actorType ||
    event.actorUserId !== command.actor.userId ||
    event.correlationId !== batchId ||
    !jsonObjectsEqual(event.payload, effect)
  ) {
    throw new ApiError(
      409,
      "RECONCILIATION_SIGN_REPLAY_CONFLICT",
      "The reconciliation sign replay does not exactly match its immutable effect proof.",
    );
  }
}

export async function recordReconciliationRun(
  actorInput: MigrationActor,
  input: RecordReconciliationRunInput,
  planVerifier: ReconciliationPlanVerifier,
): Promise<{ runId: string; passed: boolean }> {
  const command = validateRecordCommand(actorInput, input);
  const database: Database = getDatabase();
  const locator = await locateBatch(database, command.actor, command.batchId);
  const preflightMode = await preflightRecord(
    database,
    command,
    locator.migrationSourceId,
  );

  const verify = verifierMethod(planVerifier);
  let verifiedValue: unknown;
  try {
    verifiedValue = await verify.call(
      planVerifier,
      command.planArtifactRef,
      new Uint8Array(command.expectedPlanSha256),
    );
  } catch {
    throw new ApiError(
      422,
      "RECONCILIATION_PLAN_VERIFICATION_FAILED",
      "The protected reconciliation plan could not be verified.",
    );
  }
  const plan = canonicalPlan(
    verifiedValue,
    command.planArtifactRef,
    command.expectedPlanSha256,
  );
  const results = assertExactResultSet(plan.requirements, command.results);
  const passedCount = results.filter((result) => result.passed).length;
  const failedCount = results.length - passedCount;
  const passed = failedCount === 0;
  const runStatus = passed ? "PASSED" : "FAILED";

  try {
    return await database.transaction(async (transaction) => {
      const terminalReplay = preflightMode === "TERMINAL_REPLAY";
      let eventActorType: "USER" | "SERVICE" | null = null;
      await requireActiveMigrationTenant(transaction, command.actor);
      if (!terminalReplay) {
        const actorEvidence = await requireMigrationActorCapability(
          transaction,
          command.actor,
          SIGN_CAPABILITY,
        );
        eventActorType = actorType(actorEvidence.userType);
      }
      if (preflightMode === "MUTATION") {
        await lockAndValidateMigrationSourceAuthority(
          transaction,
          command.actor,
          locator.migrationSourceId,
        );
      }
      const [batch] = await transaction
        .select({ status: importBatches.status, version: importBatches.version })
        .from(importBatches)
        .where(
          and(
            eq(importBatches.organizationId, command.actor.organizationId),
            eq(importBatches.businessUnitId, command.actor.businessUnitId),
            eq(importBatches.migrationSourceId, locator.migrationSourceId),
            eq(importBatches.id, command.batchId),
          ),
        )
        .for("update")
        .limit(1);
      if (!batch) throw new ApiError(404, "IMPORT_BATCH_NOT_FOUND", "Import batch not found.");
      const batchRuns: StoredReplayRun[] = await transaction
        .select({
          id: reconciliationRuns.id,
          runNo: reconciliationRuns.runNo,
          status: reconciliationRuns.status,
          planArtifactRef: reconciliationRuns.planArtifactRef,
          planSha256: reconciliationRuns.planSha256,
          requiredChecksSha256: reconciliationRuns.requiredChecksSha256,
          requiredCheckCount: reconciliationRuns.requiredCheckCount,
          passedCheckCount: reconciliationRuns.passedCheckCount,
          failedCheckCount: reconciliationRuns.failedCheckCount,
        })
        .from(reconciliationRuns)
        .where(
          and(
            eq(reconciliationRuns.organizationId, command.actor.organizationId),
            eq(reconciliationRuns.businessUnitId, command.actor.businessUnitId),
            eq(reconciliationRuns.batchId, command.batchId),
          ),
        )
        .orderBy(asc(reconciliationRuns.runNo), asc(reconciliationRuns.id))
        .for("update");
      const existing = batchRuns.find((candidate) => candidate.runNo === command.runNo);
      if (existing) {
        const storedResults: StoredReplayResult[] = await transaction
          .select({
            checkKind: reconciliationResults.checkKind,
            checkKey: reconciliationResults.checkKey,
            scopeKey: reconciliationResults.scopeKey,
            sourceCount: reconciliationResults.sourceCount,
            targetCount: reconciliationResults.targetCount,
            sourceAmount: reconciliationResults.sourceAmount,
            targetAmount: reconciliationResults.targetAmount,
            measureUnit: reconciliationResults.measureUnit,
            decimalScale: reconciliationResults.decimalScale,
            sourceChecksum: reconciliationResults.sourceChecksum,
            targetChecksum: reconciliationResults.targetChecksum,
            passed: reconciliationResults.passed,
            evidenceMetadata: reconciliationResults.evidenceMetadata,
          })
          .from(reconciliationResults)
          .where(
            and(
              eq(reconciliationResults.organizationId, command.actor.organizationId),
              eq(reconciliationResults.businessUnitId, command.actor.businessUnitId),
              eq(reconciliationResults.runId, existing.id),
            ),
          );
        if (
          !exactReplayMatches(
            existing,
            storedResults,
            plan,
            results,
            runStatus,
            passedCount,
            failedCount,
          )
        ) {
          throw new ApiError(
            409,
            "RECONCILIATION_RUN_CONFLICT",
            "This reconciliation run number already identifies different evidence.",
          );
        }
        const expectedEffect = recordEffect(
          command,
          existing.id,
          plan,
          runStatus,
          passedCount,
          failedCount,
        );
        await assertRecordReplayProof(
          transaction,
          command,
          existing,
          expectedEffect,
        );
        if (!terminalReplay) {
          await requireMigrationActorCapability(
            transaction,
            command.actor,
            SIGN_CAPABILITY,
          );
        }
        return { runId: existing.id, passed };
      }
      if (preflightMode !== "MUTATION") {
        replayConflict(
          "The reconciliation run selected for replay no longer exists.",
        );
      }
      if (batch.status !== "APPLIED") {
        throw new ApiError(
          409,
          "IMPORT_BATCH_STATE_INVALID",
          "A reconciled import batch accepts exact existing run replays only.",
        );
      }
      if (batch.version !== command.expectedBatchVersion) {
        throw new ApiError(
          409,
          "IMPORT_BATCH_VERSION_CONFLICT",
          "The applied import batch changed during plan verification.",
        );
      }
      const latestRunNo = batchRuns.at(-1)?.runNo ?? 0;
      if (command.runNo !== latestRunNo + 1) {
        throw new ApiError(
          409,
          "RECONCILIATION_RUN_SEQUENCE_INVALID",
          "A new reconciliation run must use the next monotonic batch run number.",
        );
      }
      const [run] = await transaction
        .insert(reconciliationRuns)
        .values({
          organizationId: command.actor.organizationId,
          businessUnitId: command.actor.businessUnitId,
          batchId: command.batchId,
          runNo: command.runNo,
          status: runStatus,
          planArtifactRef: plan.artifactRef,
          planSha256: plan.planSha256,
          requiredChecks: plan.requiredChecksJson,
          requiredChecksSha256: plan.requiredChecksSha256,
          requiredCheckCount: plan.requirements.length,
          passedCheckCount: passedCount,
          failedCheckCount: failedCount,
        })
        .returning({ id: reconciliationRuns.id, version: reconciliationRuns.version });
      if (!run) throw new Error("RECONCILIATION_RUN_INSERT_MISSING");
      await transaction.insert(reconciliationResults).values(
        results.map((result) => ({
          organizationId: command.actor.organizationId,
          businessUnitId: command.actor.businessUnitId,
          runId: run.id,
          checkKind: result.checkKind,
          checkKey: result.checkKey,
          scopeKey: result.scopeKey,
          sourceCount: result.sourceCount,
          targetCount: result.targetCount,
          sourceAmount: result.sourceAmount,
          targetAmount: result.targetAmount,
          measureUnit: result.measureUnit,
          decimalScale: result.decimalScale,
          sourceChecksum: result.sourceChecksum,
          targetChecksum: result.targetChecksum,
          passed: result.passed,
          evidenceMetadata: result.redactedEvidence,
        })),
      );
      await transaction.execute(sql.raw("set constraints all immediate"));
      const effect = recordEffect(
        command,
        run.id,
        plan,
        runStatus,
        passedCount,
        failedCount,
      );
      if (eventActorType === null) {
        throw new Error("RECONCILIATION_RECORD_ACTOR_EVIDENCE_MISSING");
      }
      await transaction.insert(auditEvents).values({
        organizationId: command.actor.organizationId,
        businessUnitId: command.actor.businessUnitId,
        actorType: eventActorType,
        actorUserId: command.actor.userId,
        action: "MIGRATION_RECONCILIATION_RUN_RECORDED",
        targetType: "RECONCILIATION_RUN",
        targetId: run.id,
        outcome: "SUCCESS",
        correlationId: command.batchId,
        changeSummary: effect,
      });
      await transaction.insert(outboxEvents).values({
        organizationId: command.actor.organizationId,
        businessUnitId: command.actor.businessUnitId,
        eventType: "crm.migration.reconciliation_run_recorded",
        eventVersion: 1,
        aggregateType: "RECONCILIATION_RUN",
        aggregateId: run.id,
        aggregateVersion: run.version,
        actorType: eventActorType,
        actorUserId: command.actor.userId,
        correlationId: command.batchId,
        payload: effect,
      });
      await requireMigrationActorCapability(
        transaction,
        command.actor,
        SIGN_CAPABILITY,
      );
      return { runId: run.id, passed };
    });
  } catch (error: unknown) {
    if (error instanceof ApiError) throw error;
    const postgresError = postgresErrorDetails(error);
    if (
      postgresError.code === "23505" &&
      postgresError.constraint === "reconciliation_runs_run_unique"
    ) {
      throw new ApiError(
        409,
        "RECONCILIATION_RUN_CONFLICT",
        "This reconciliation run number already exists for the import batch.",
      );
    }
    throw new ApiError(
      500,
      "RECONCILIATION_RECORD_FAILED",
      "The reconciliation run could not be recorded.",
    );
  }
}

async function locateRun(
  database: Database,
  actor: MigrationActor,
  runId: string,
): Promise<{
  batchId: string;
  migrationSourceId: string;
  batchStatus: string;
  runStatus: "PENDING" | "PASSED" | "FAILED" | "SIGNED";
}> {
  const [locator] = await database
    .select({
      batchId: reconciliationRuns.batchId,
      migrationSourceId: importBatches.migrationSourceId,
      batchStatus: importBatches.status,
      runStatus: reconciliationRuns.status,
    })
    .from(reconciliationRuns)
    .innerJoin(
      importBatches,
      and(
        eq(importBatches.organizationId, reconciliationRuns.organizationId),
        eq(importBatches.businessUnitId, reconciliationRuns.businessUnitId),
        eq(importBatches.id, reconciliationRuns.batchId),
      ),
    )
    .where(
      and(
        eq(reconciliationRuns.organizationId, actor.organizationId),
        eq(reconciliationRuns.businessUnitId, actor.businessUnitId),
        eq(reconciliationRuns.id, runId),
      ),
    )
    .limit(1);
  if (!locator) {
    throw new ApiError(
      404,
      "RECONCILIATION_RUN_NOT_FOUND",
      "Reconciliation run not found.",
    );
  }
  return locator;
}

export async function signReconciliationRun(
  actorInput: MigrationActor,
  input: SignReconciliationRunInput,
): Promise<void> {
  const command = validateSignCommand(actorInput, input);
  const database: Database = getDatabase();
  const locator = await locateRun(database, command.actor, command.runId);
  const terminalReplay =
    locator.runStatus === "SIGNED" && locator.batchStatus === "RECONCILED";

  try {
    await database.transaction(async (transaction) => {
      let eventActorType: "USER" | "SERVICE" | null = null;
      await requireActiveMigrationTenant(transaction, command.actor);
      if (!terminalReplay) {
        const actorEvidence = await requireMigrationActorCapability(
          transaction,
          command.actor,
          SIGN_CAPABILITY,
        );
        eventActorType = actorType(actorEvidence.userType);
      }
      if (!terminalReplay) {
        await lockAndValidateMigrationSourceAuthority(
          transaction,
          command.actor,
          locator.migrationSourceId,
        );
      }
      const [batch] = await transaction
        .select({
          status: importBatches.status,
          version: importBatches.version,
          approvedByMembershipId: importBatches.approvedByMembershipId,
          appliedByMembershipId: importBatches.appliedByMembershipId,
        })
        .from(importBatches)
        .where(
          and(
            eq(importBatches.organizationId, command.actor.organizationId),
            eq(importBatches.businessUnitId, command.actor.businessUnitId),
            eq(importBatches.migrationSourceId, locator.migrationSourceId),
            eq(importBatches.id, locator.batchId),
          ),
        )
        .for("update")
        .limit(1);
      if (!batch) throw new ApiError(404, "IMPORT_BATCH_NOT_FOUND", "Import batch not found.");
      const batchRuns = await transaction
        .select({
          id: reconciliationRuns.id,
          runNo: reconciliationRuns.runNo,
          status: reconciliationRuns.status,
          version: reconciliationRuns.version,
          requiredCheckCount: reconciliationRuns.requiredCheckCount,
          passedCheckCount: reconciliationRuns.passedCheckCount,
          failedCheckCount: reconciliationRuns.failedCheckCount,
          signedByMembershipId: reconciliationRuns.signedByMembershipId,
          signedAt: reconciliationRuns.signedAt,
        })
        .from(reconciliationRuns)
        .where(
          and(
            eq(reconciliationRuns.organizationId, command.actor.organizationId),
            eq(reconciliationRuns.businessUnitId, command.actor.businessUnitId),
            eq(reconciliationRuns.batchId, locator.batchId),
          ),
        )
        .orderBy(asc(reconciliationRuns.runNo), asc(reconciliationRuns.id))
        .for("update");
      const run = batchRuns.find((candidate) => candidate.id === command.runId);
      if (!run) {
        throw new ApiError(
          404,
          "RECONCILIATION_RUN_NOT_FOUND",
          "Reconciliation run not found.",
        );
      }
      if (batchRuns.at(-1)?.id !== run.id) {
        throw new ApiError(
          409,
          "RECONCILIATION_RUN_NOT_LATEST",
          "Only the latest reconciliation attempt for an import batch can be signed.",
        );
      }
      if (run.status === "SIGNED") {
        await assertExactSignReplay(
          transaction,
          command,
          run,
          batch,
          locator.batchId,
        );
        if (!terminalReplay) {
          await requireMigrationActorCapability(
            transaction,
            command.actor,
            SIGN_CAPABILITY,
          );
        }
        return;
      }
      if (run.version !== command.expectedRunVersion) {
        throw new ApiError(
          409,
          "RECONCILIATION_RUN_VERSION_CONFLICT",
          "The reconciliation run changed before sign-off.",
        );
      }
      if (batch.status !== "APPLIED") {
        throw new ApiError(
          409,
          "IMPORT_BATCH_STATE_INVALID",
          "Only an applied import batch can be signed as reconciled.",
        );
      }
      if (
        run.status !== "PASSED" ||
        run.requiredCheckCount < 1 ||
        run.passedCheckCount !== run.requiredCheckCount ||
        run.failedCheckCount !== 0
      ) {
        throw new ApiError(
          409,
          "RECONCILIATION_RUN_NOT_PASSED",
          "Only an exact fully passed reconciliation run can be signed.",
        );
      }
      if (
        batch.approvedByMembershipId === null ||
        batch.appliedByMembershipId === null
      ) {
        throw new ApiError(
          409,
          "IMPORT_BATCH_PROVENANCE_INVALID",
          "Approval and apply provenance must remain available for sign-off.",
        );
      }
      const membershipIds = [
        batch.approvedByMembershipId,
        batch.appliedByMembershipId,
        command.actor.activeMembershipId,
      ];
      const provenance = await transaction
        .select({ id: memberships.id, userId: memberships.userId })
        .from(memberships)
        .where(
          and(
            eq(memberships.organizationId, command.actor.organizationId),
            inArray(memberships.id, membershipIds),
          ),
        )
        .orderBy(asc(memberships.id))
        .for("share");
      const userByMembership = new Map(
        provenance.map((membership) => [membership.id, membership.userId] as const),
      );
      const approverUserId = userByMembership.get(batch.approvedByMembershipId);
      const applierUserId = userByMembership.get(batch.appliedByMembershipId);
      const signerUserId = userByMembership.get(command.actor.activeMembershipId);
      if (!approverUserId || !applierUserId || !signerUserId) {
        throw new ApiError(
          409,
          "IMPORT_BATCH_PROVENANCE_INVALID",
          "Approval, apply, and signer provenance must remain available.",
        );
      }
      if (signerUserId === approverUserId || signerUserId === applierUserId) {
        throw new ApiError(
          409,
          "RECONCILIATION_MAKER_CHECKER_REQUIRED",
          "The reconciliation signer must be a different person from approver and applier.",
        );
      }
      if (eventActorType === null) {
        throw new Error("RECONCILIATION_SIGN_ACTOR_EVIDENCE_MISSING");
      }
      assertImportBatchTransition(batch.status, "RECONCILED");
      const [signedRun] = await transaction
        .update(reconciliationRuns)
        .set({
          status: "SIGNED",
          signedByMembershipId: command.actor.activeMembershipId,
        })
        .where(
          and(
            eq(reconciliationRuns.id, command.runId),
            eq(reconciliationRuns.version, command.expectedRunVersion),
            eq(reconciliationRuns.status, "PASSED"),
          ),
        )
        .returning({ version: reconciliationRuns.version });
      if (!signedRun) {
        throw new ApiError(
          409,
          "RECONCILIATION_RUN_VERSION_CONFLICT",
          "The reconciliation run changed during sign-off.",
        );
      }
      const [reconciledBatch] = await transaction
        .update(importBatches)
        .set({ status: "RECONCILED" })
        .where(
          and(
            eq(importBatches.id, locator.batchId),
            eq(importBatches.version, batch.version),
            eq(importBatches.status, "APPLIED"),
          ),
        )
        .returning({ version: importBatches.version });
      if (!reconciledBatch) {
        throw new ApiError(
          409,
          "IMPORT_BATCH_VERSION_CONFLICT",
          "The import batch changed during reconciliation sign-off.",
        );
      }
      const persistedSignedAt = sql<Date>`(
        select ${reconciliationRuns.signedAt}
        from ${reconciliationRuns}
        where ${reconciliationRuns.organizationId} = ${command.actor.organizationId}
          and ${reconciliationRuns.businessUnitId} = ${command.actor.businessUnitId}
          and ${reconciliationRuns.id} = ${command.runId}
      )`;
      const effect = signEffect(command, locator.batchId);
      await transaction.insert(auditEvents).values({
        organizationId: command.actor.organizationId,
        businessUnitId: command.actor.businessUnitId,
        actorType: eventActorType,
        actorUserId: command.actor.userId,
        action: "MIGRATION_RECONCILIATION_RUN_SIGNED",
        targetType: "RECONCILIATION_RUN",
        targetId: command.runId,
        outcome: "SUCCESS",
        reason: command.approvalReason,
        correlationId: locator.batchId,
        changeSummary: effect,
        occurredAt: persistedSignedAt,
        recordedAt: persistedSignedAt,
        createdAt: persistedSignedAt,
      });
      await transaction.insert(outboxEvents).values({
        organizationId: command.actor.organizationId,
        businessUnitId: command.actor.businessUnitId,
        eventType: "crm.migration.reconciliation_run_signed",
        eventVersion: 1,
        aggregateType: "RECONCILIATION_RUN",
        aggregateId: command.runId,
        aggregateVersion: signedRun.version,
        actorType: eventActorType,
        actorUserId: command.actor.userId,
        correlationId: locator.batchId,
        payload: effect,
        occurredAt: persistedSignedAt,
        createdAt: persistedSignedAt,
      });
      await requireMigrationActorCapability(
        transaction,
        command.actor,
        SIGN_CAPABILITY,
      );
      await transaction.execute(sql.raw("set constraints all immediate"));
    });
  } catch (error: unknown) {
    if (
      !terminalReplay &&
      error instanceof ApiError &&
      error.code === "MIGRATION_SOURCE_NOT_ACTIVE"
    ) {
      let refreshed: Awaited<ReturnType<typeof locateRun>>;
      try {
        refreshed = await locateRun(database, command.actor, command.runId);
      } catch {
        throw error;
      }
      if (
        refreshed.runStatus === "SIGNED" &&
        refreshed.batchStatus === "RECONCILED"
      ) {
        return signReconciliationRun(command.actor, {
          runId: command.runId,
          expectedRunVersion: command.expectedRunVersion,
          approvalReason: command.approvalReason,
        });
      }
    }
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      500,
      "RECONCILIATION_SIGN_FAILED",
      "The reconciliation sign-off could not be recorded.",
    );
  }
}

import { createHash, randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as databaseClient from "@/server/db/client";
import { closeDatabaseConnection } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { resetRuntimeConfigForTests } from "@/server/env";
import type { MigrationActor } from "@/server/migration/contracts";
import {
  recordReconciliationRun,
  signReconciliationRun,
  type ReconciliationPlanVerifier,
  type ReconciliationRequirement,
  type ReconciliationResultInput,
  type VerifiedReconciliationPlan,
} from "@/server/migration/reconcile-batch";

const expectedDatabaseName = "crm_salam_codex_migration_platform";
const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) {
  throw new Error("TEST_DATABASE_URL is required for reconciliation service tests.");
}

const parsedDatabaseUrl = new URL(databaseUrl);
if (
  parsedDatabaseUrl.protocol !== "postgresql:" ||
  parsedDatabaseUrl.hostname !== "127.0.0.1" ||
  parsedDatabaseUrl.port !== "5432" ||
  parsedDatabaseUrl.pathname.slice(1) !== expectedDatabaseName
) {
  throw new Error(
    `Reconciliation service tests may reset only 127.0.0.1:5432/${expectedDatabaseName}.`,
  );
}

const sql = postgres(databaseUrl, { max: 24, prepare: false, onnotice: () => undefined });
const SIGN_CAPABILITY = "migration.sign";

function sha256(value: string | Uint8Array): Buffer {
  return createHash("sha256").update(value).digest();
}

function protectedRef(label: string): string {
  return `protected://reconciliation-tests/${label}/${randomUUID()}`;
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

function canonicalRequirements(
  requirements: readonly ReconciliationRequirement[],
): ReconciliationRequirement[] {
  return requirements.map((requirement) => ({ ...requirement })).sort(compareRequirements);
}

// PostgreSQL jsonb orders these fixed keys by encoded key length, then byte value,
// and emits this exact whitespace when cast to text. Tuple values are constrained
// to scalars by the service and frozen database guard.
function postgresJsonbRequirementText(
  requirements: readonly ReconciliationRequirement[],
): string {
  return `[${requirements
    .map(
      (requirement) =>
        `{"check_key": ${JSON.stringify(requirement.checkKey)}, "scope_key": ${JSON.stringify(requirement.scopeKey)}, "check_kind": ${JSON.stringify(requirement.checkKind)}, "measure_unit": ${JSON.stringify(requirement.measureUnit)}, "decimal_scale": ${JSON.stringify(requirement.decimalScale)}}`,
    )
    .join(", ")}]`;
}

function requiredSetSha256(
  requirements: readonly ReconciliationRequirement[],
): Buffer {
  return sha256(postgresJsonbRequirementText(canonicalRequirements(requirements)));
}

const defaultRequirements = [
  {
    checkKind: "COUNT",
    checkKey: "customers.total",
    scopeKey: "global",
    measureUnit: null,
    decimalScale: null,
  },
  {
    checkKind: "AMOUNT",
    checkKey: "balances.total",
    scopeKey: "global",
    measureUnit: "MYR",
    decimalScale: 2,
  },
  {
    checkKind: "CHECKSUM",
    checkKey: "customers.checksum",
    scopeKey: "global",
    measureUnit: null,
    decimalScale: null,
  },
  {
    checkKind: "REFERENCE",
    checkKey: "accounts.reference",
    scopeKey: "global",
    measureUnit: null,
    decimalScale: null,
  },
] as const satisfies readonly ReconciliationRequirement[];

function resultFor(
  requirement: ReconciliationRequirement,
  overrides: Partial<ReconciliationResultInput> = {},
): ReconciliationResultInput {
  const checksum = sha256(`${requirement.checkKind}:${requirement.checkKey}`);
  const base: ReconciliationResultInput = {
    ...requirement,
    sourceCount: requirement.checkKind === "COUNT" ? 7n : null,
    targetCount: requirement.checkKind === "COUNT" ? 7n : null,
    sourceAmount:
      requirement.checkKind === "AMOUNT" || requirement.checkKind === "FINANCE_BALANCE"
        ? "12345678901234567890123456.78"
        : null,
    targetAmount:
      requirement.checkKind === "AMOUNT" || requirement.checkKind === "FINANCE_BALANCE"
        ? "12345678901234567890123456.78"
        : null,
    sourceChecksum: requirement.checkKind === "CHECKSUM" ? checksum : null,
    targetChecksum: requirement.checkKind === "CHECKSUM" ? checksum : null,
    passed: true,
    redactedEvidence: { ruleCode: "RECONCILED" },
  };
  return { ...base, ...overrides };
}

function resultsFor(
  requirements: readonly ReconciliationRequirement[],
): ReconciliationResultInput[] {
  return requirements.map((requirement) => resultFor(requirement));
}

interface PlanBundle {
  artifactRef: string;
  planSha256: Buffer;
  requiredChecksSha256: Buffer;
  requirements: ReconciliationRequirement[];
}

function planBundle(
  requirements: readonly ReconciliationRequirement[] = defaultRequirements,
): PlanBundle {
  const artifactRef = protectedRef("plan");
  const planSha256 = sha256(`plan:${artifactRef}`);
  return {
    artifactRef,
    planSha256,
    requiredChecksSha256: requiredSetSha256(requirements),
    requirements: requirements.map((requirement) => ({ ...requirement })),
  };
}

function verifierFor(
  bundle: PlanBundle,
  override: Partial<VerifiedReconciliationPlan> = {},
): ReconciliationPlanVerifier {
  return {
    verify: vi.fn(async (artifactRef, expectedPlanSha256) => {
      expect(artifactRef).toBe(bundle.artifactRef);
      expect(Buffer.from(expectedPlanSha256)).toEqual(bundle.planSha256);
      return {
        artifactRef: bundle.artifactRef,
        planSha256: new Uint8Array(bundle.planSha256),
        requiredChecksSha256: new Uint8Array(bundle.requiredChecksSha256),
        requiredChecks: bundle.requirements.map((requirement) => ({ ...requirement })),
        ...override,
      };
    }),
  };
}

interface Fixture {
  organizationId: string;
  businessUnitId: string;
  sourceId: string;
  batchId: string;
  batchVersion: number;
  signerMembershipId: string;
  signerActor: MigrationActor;
  signerAlternateActor: MigrationActor;
  otherSignerActor: MigrationActor;
  approverAsSignerActor: MigrationActor;
  applierAsSignerActor: MigrationActor;
}

async function seedFixture(): Promise<Fixture> {
  const organizationId = randomUUID();
  const businessUnitId = randomUUID();
  const validatorUserId = randomUUID();
  const validatorMembershipId = randomUUID();
  const approverUserId = randomUUID();
  const approverMembershipId = randomUUID();
  const approverAlternateMembershipId = randomUUID();
  const applierUserId = randomUUID();
  const applierMembershipId = randomUUID();
  const applierAlternateMembershipId = randomUUID();
  const signerUserId = randomUUID();
  const signerMembershipId = randomUUID();
  const signerAlternateMembershipId = randomUUID();
  const otherSignerUserId = randomUUID();
  const otherSignerMembershipId = randomUUID();
  const signRoleId = randomUUID();
  const sourceId = randomUUID();
  const scopeId = randomUUID();
  const headId = randomUUID();
  const transformId = randomUUID();
  const dryRunBatchId = randomUUID();
  const batchId = randomUUID();
  const applyRunId = randomUUID();
  const domainKey = `sales.reconciliation_${randomUUID().replaceAll("-", "_")}`;
  const sourceSha = sha256(`batch:${batchId}`);

  await sql`
    insert into organizations (id, code, name)
    values (${organizationId}, ${`org-${organizationId}`}, 'Reconciliation Test Organisation')
  `;
  await sql`
    insert into business_units (id, organization_id, code, name)
    values (${businessUnitId}, ${organizationId}, ${`bu-${businessUnitId}`},
            'Reconciliation Test Unit')
  `;
  await sql`
    insert into users (id, auth_subject, display_name, user_type, status)
    values
      (${validatorUserId}, ${`reconcile-validator:${validatorUserId}`}, 'Validator', 'HUMAN', 'ACTIVE'),
      (${approverUserId}, ${`reconcile-approver:${approverUserId}`}, 'Approver', 'HUMAN', 'ACTIVE'),
      (${applierUserId}, ${`reconcile-applier:${applierUserId}`}, 'Applier', 'HUMAN', 'ACTIVE'),
      (${signerUserId}, ${`reconcile-signer:${signerUserId}`}, 'Signer', 'HUMAN', 'ACTIVE'),
      (${otherSignerUserId}, ${`reconcile-signer:${otherSignerUserId}`},
       'Other Signer', 'HUMAN', 'ACTIVE')
  `;
  await sql`
    insert into memberships (
      id, organization_id, business_unit_id, user_id, status, valid_from
    ) values
      (${validatorMembershipId}, ${organizationId}, ${businessUnitId}, ${validatorUserId},
       'ACTIVE', clock_timestamp() - interval '1 day'),
      (${approverMembershipId}, ${organizationId}, ${businessUnitId}, ${approverUserId},
       'ACTIVE', clock_timestamp() - interval '1 day'),
      (${approverAlternateMembershipId}, ${organizationId}, null, ${approverUserId},
       'ACTIVE', clock_timestamp() - interval '1 day'),
      (${applierMembershipId}, ${organizationId}, ${businessUnitId}, ${applierUserId},
       'ACTIVE', clock_timestamp() - interval '1 day'),
      (${applierAlternateMembershipId}, ${organizationId}, null, ${applierUserId},
       'ACTIVE', clock_timestamp() - interval '1 day'),
      (${signerMembershipId}, ${organizationId}, ${businessUnitId}, ${signerUserId},
       'ACTIVE', clock_timestamp() - interval '1 day'),
      (${signerAlternateMembershipId}, ${organizationId}, null, ${signerUserId},
       'ACTIVE', clock_timestamp() - interval '1 day'),
      (${otherSignerMembershipId}, ${organizationId}, ${businessUnitId}, ${otherSignerUserId},
       'ACTIVE', clock_timestamp() - interval '1 day')
  `;
  await sql`
    insert into roles (id, organization_id, key, name, status)
    values (${signRoleId}, ${organizationId}, ${`sign-${signRoleId}`},
            'Migration Reconciliation Signer', 'ACTIVE')
  `;
  await sql`
    insert into role_capabilities (organization_id, role_id, capability_key)
    values (${organizationId}, ${signRoleId}, ${SIGN_CAPABILITY})
  `;
  await sql`
    insert into membership_roles (organization_id, membership_id, role_id, valid_from)
    values
      (${organizationId}, ${approverAlternateMembershipId}, ${signRoleId},
       clock_timestamp() - interval '1 day'),
      (${organizationId}, ${applierAlternateMembershipId}, ${signRoleId},
       clock_timestamp() - interval '1 day'),
      (${organizationId}, ${signerMembershipId}, ${signRoleId},
       clock_timestamp() - interval '1 day'),
      (${organizationId}, ${signerAlternateMembershipId}, ${signRoleId},
       clock_timestamp() - interval '1 day'),
      (${organizationId}, ${otherSignerMembershipId}, ${signRoleId},
       clock_timestamp() - interval '1 day')
  `;
  await sql`
    insert into migration_sources (
      id, organization_id, business_unit_id, source_key, source_kind, source_mode,
      owner_membership_id, status
    ) values (
      ${sourceId}, ${organizationId}, ${businessUnitId}, ${`source-${sourceId}`},
      'SALAM_CRM_JSON', 'ONE_TIME_MIGRATION', ${validatorMembershipId}, 'ACTIVE'
    )
  `;
  await sql`
    insert into migration_source_scopes (
      id, organization_id, business_unit_id, migration_source_id, domain_key,
      canonical_target, transition_mode, source_status
    ) values (
      ${scopeId}, ${organizationId}, ${businessUnitId}, ${sourceId}, ${domainKey},
      'crm.canonical', 'ONE_TIME_CUTOVER', 'ACTIVE_AUTHORITY'
    )
  `;
  await sql`
    insert into migration_domain_authorities (
      id, organization_id, business_unit_id, domain_key, canonical_target,
      authority_state, authority_source_scope_id
    ) values (
      ${headId}, ${organizationId}, ${businessUnitId}, ${domainKey}, 'crm.canonical',
      'SHADOW_READ', ${scopeId}
    )
  `;
  await sql`
    insert into transform_versions (
      id, organization_id, business_unit_id, migration_source_id, version_no,
      source_schema_version, mapping_artifact_ref, mapping_sha256,
      release_manifest_ref, release_manifest_sha256, transform_release_sha256,
      rationale, approved_by_membership_id, approved_at
    ) values (
      ${transformId}, ${organizationId}, ${businessUnitId}, ${sourceId}, 1, 'sales.v1',
      ${protectedRef("mapping")}, ${sha256(`mapping:${transformId}`)},
      ${protectedRef("manifest")}, ${sha256(`manifest:${transformId}`)},
      ${sha256(`release:${transformId}`)}, 'Reviewed reconciliation transform',
      ${validatorMembershipId}, clock_timestamp() - interval '10 minutes'
    )
  `;
  await sql`
    insert into import_batches (
      id, organization_id, business_unit_id, migration_source_id, transform_version_id,
      protected_artifact_ref, source_sha256, size_bytes, captured_at, cutoff_at,
      schema_version, status, dry_run, validated_by_membership_id, validated_at
    ) values (
      ${dryRunBatchId}, ${organizationId}, ${businessUnitId}, ${sourceId}, ${transformId},
      ${protectedRef("dry-run")}, ${sourceSha}, 1,
      clock_timestamp() - interval '9 minutes', clock_timestamp() - interval '10 minutes',
      'sales.v1', 'DRY_RUN_COMPLETE', true, ${validatorMembershipId},
      clock_timestamp() - interval '8 minutes'
    )
  `;
  await sql`
    insert into import_batches (
      id, organization_id, business_unit_id, migration_source_id, transform_version_id,
      validated_dry_run_batch_id, protected_artifact_ref, source_sha256, size_bytes,
      captured_at, cutoff_at, schema_version, status, dry_run, total_row_count,
      imported_row_count, approved_row_count, validated_by_membership_id, validated_at,
      approved_by_membership_id, approved_at, approval_mode, approval_reason,
      applied_by_membership_id, apply_run_id, apply_lease_expires_at,
      apply_started_at, applied_at
    ) values (
      ${batchId}, ${organizationId}, ${businessUnitId}, ${sourceId}, ${transformId},
      ${dryRunBatchId}, ${protectedRef("live-batch")}, ${sourceSha}, 1,
      clock_timestamp() - interval '7 minutes', clock_timestamp() - interval '10 minutes',
      'sales.v1', 'APPLIED', false, 1, 1, 1, ${validatorMembershipId},
      clock_timestamp() - interval '6 minutes', ${approverMembershipId},
      clock_timestamp() - interval '5 minutes', 'FULL', 'Reviewed import approved',
      ${applierMembershipId}, ${applyRunId}, clock_timestamp() + interval '1 hour',
      clock_timestamp() - interval '4 minutes', clock_timestamp() - interval '3 minutes'
    )
  `;

  return {
    organizationId,
    businessUnitId,
    sourceId,
    batchId,
    batchVersion: 1,
    signerMembershipId,
    signerActor: {
      userId: signerUserId,
      organizationId,
      activeMembershipId: signerMembershipId,
      businessUnitId,
      capabilities: [SIGN_CAPABILITY],
    },
    signerAlternateActor: {
      userId: signerUserId,
      organizationId,
      activeMembershipId: signerAlternateMembershipId,
      businessUnitId,
      capabilities: [SIGN_CAPABILITY],
    },
    otherSignerActor: {
      userId: otherSignerUserId,
      organizationId,
      activeMembershipId: otherSignerMembershipId,
      businessUnitId,
      capabilities: [SIGN_CAPABILITY],
    },
    approverAsSignerActor: {
      userId: approverUserId,
      organizationId,
      activeMembershipId: approverAlternateMembershipId,
      businessUnitId,
      capabilities: [SIGN_CAPABILITY],
    },
    applierAsSignerActor: {
      userId: applierUserId,
      organizationId,
      activeMembershipId: applierAlternateMembershipId,
      businessUnitId,
      capabilities: [SIGN_CAPABILITY],
    },
  };
}

function recordInput(
  fixture: Fixture,
  bundle: PlanBundle,
  overrides: Partial<Parameters<typeof recordReconciliationRun>[1]> = {},
): Parameters<typeof recordReconciliationRun>[1] {
  return {
    batchId: fixture.batchId,
    runNo: 1,
    planArtifactRef: bundle.artifactRef,
    expectedPlanSha256: new Uint8Array(bundle.planSha256),
    expectedBatchVersion: fixture.batchVersion,
    results: resultsFor(bundle.requirements),
    ...overrides,
  };
}

async function recordPassedRun(
  fixture: Fixture,
  bundle = planBundle(),
): Promise<{ runId: string; bundle: PlanBundle }> {
  const recorded = await recordReconciliationRun(
    fixture.signerActor,
    recordInput(fixture, bundle),
    verifierFor(bundle),
  );
  expect(recorded.passed).toBe(true);
  return { runId: recorded.runId, bundle };
}

async function expectUnsignedState(fixture: Fixture, runId: string): Promise<void> {
  const [stored] = await sql<{
    run_status: string;
    run_version: number;
    signer: string | null;
    signed_at: Date | null;
    batch_status: string;
    batch_version: number;
    audits: number;
    outbox: number;
  }[]>`
    select run.status as run_status, run.version::int as run_version,
           run.signed_by_membership_id as signer, run.signed_at,
           batch.status as batch_status, batch.version::int as batch_version,
           (select count(*)::int from audit_events where target_id = run.id
             and action = 'MIGRATION_RECONCILIATION_RUN_SIGNED') as audits,
           (select count(*)::int from outbox_events where aggregate_id = run.id
             and event_type = 'crm.migration.reconciliation_run_signed') as outbox
    from reconciliation_runs run
    join import_batches batch on batch.id = run.batch_id
    where run.id = ${runId}
  `;
  expect(stored).toEqual({
    run_status: "PASSED",
    run_version: 1,
    signer: null,
    signed_at: null,
    batch_status: "APPLIED",
    batch_version: fixture.batchVersion,
    audits: 0,
    outbox: 0,
  });
}

async function archiveCanonicalSource(fixture: Fixture): Promise<void> {
  await sql.begin(async (transaction) => {
    await transaction`
      update migration_domain_authorities
      set authority_state = 'CANONICAL_WRITABLE', authority_source_scope_id = null
      where authority_source_scope_id in (
        select id from migration_source_scopes where migration_source_id = ${fixture.sourceId}
      )
    `;
    await transaction`
      update migration_source_scopes set source_status = 'ARCHIVED_READ_ONLY'
      where migration_source_id = ${fixture.sourceId}
    `;
    await transaction`
      update migration_sources set status = 'ARCHIVED_READ_ONLY'
      where id = ${fixture.sourceId}
    `;
  });
}

beforeAll(async () => {
  process.env = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    DATABASE_POOL_MAX: "24",
    APP_URL: "http://127.0.0.1:3000",
    CRM_DEMO_MODE: "false",
    AUTH_HASH_KEY: "reconciliation-tests-auth-hash-key-at-least-32-characters",
    OIDC_ISSUER: "https://identity.example.test",
    OIDC_CLIENT_ID: "reconciliation-integration",
    OIDC_CLIENT_SECRET: "reconciliation-integration-client-secret",
    OIDC_REDIRECT_URI: "http://127.0.0.1:3000/api/v1/auth/oidc/callback",
    PRODUCT_SURFACE: "crm",
    DEPLOYMENT_ENVIRONMENT: "local",
  };
  resetRuntimeConfigForTests();
  await sql.unsafe("drop schema if exists public cascade; create schema public");
  await runMigrations(databaseUrl);
  await sql`
    insert into capabilities (key, description, risk_level)
    values (${SIGN_CAPABILITY}, 'Sign migration reconciliation', 'PRIVILEGED')
  `;
});

afterAll(async () => {
  await closeDatabaseConnection();
  await sql.unsafe("drop schema if exists public cascade; create schema public");
  await sql.end();
  resetRuntimeConfigForTests();
});

describe("recordReconciliationRun", () => {
  it("uses the exact PostgreSQL jsonb text digest canary", () => {
    const requirement: ReconciliationRequirement = {
      checkKind: "COUNT",
      checkKey: "records.total",
      scopeKey: "all",
      measureUnit: null,
      decimalScale: null,
    };
    expect(postgresJsonbRequirementText([requirement])).toBe(
      '[{"check_key": "records.total", "scope_key": "all", "check_kind": "COUNT", "measure_unit": null, "decimal_scale": null}]',
    );
    expect(requiredSetSha256([requirement]).toString("hex")).toBe(
      "5d2d28af5ed7607c9c20de34cbebe85252d112b2c3d4222b087c07927981289d",
    );
  });

  it("performs tenant and capability preflight before invoking the protected verifier", async () => {
    const fixture = await seedFixture();
    const other = await seedFixture();
    const bundle = planBundle();
    const verifier = verifierFor(bundle);

    await expect(
      recordReconciliationRun(
        { ...fixture.signerActor, capabilities: [] },
        recordInput(fixture, bundle),
        verifier,
      ),
    ).rejects.toMatchObject({ status: 403, code: "MIGRATION_CAPABILITY_REQUIRED" });
    await expect(
      recordReconciliationRun(
        { ...fixture.signerActor, businessUnitId: randomUUID() },
        recordInput(fixture, bundle),
        verifier,
      ),
    ).rejects.toMatchObject({ status: 404, code: "IMPORT_BATCH_NOT_FOUND" });
    await expect(
      recordReconciliationRun(
        other.signerActor,
        recordInput(fixture, bundle),
        verifier,
      ),
    ).rejects.toMatchObject({ status: 404, code: "IMPORT_BATCH_NOT_FOUND" });
    expect(verifier.verify).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "a proxied plan",
      make: (bundle: PlanBundle): unknown =>
        new Proxy(
          {
            artifactRef: bundle.artifactRef,
            planSha256: bundle.planSha256,
            requiredChecksSha256: bundle.requiredChecksSha256,
            requiredChecks: bundle.requirements,
          },
          {},
        ),
    },
    {
      name: "an accessor-bearing plan",
      make: (bundle: PlanBundle): unknown => {
        const value: Record<string, unknown> = {
          artifactRef: bundle.artifactRef,
          planSha256: bundle.planSha256,
          requiredChecksSha256: bundle.requiredChecksSha256,
        };
        Object.defineProperty(value, "requiredChecks", {
          enumerable: true,
          get: () => bundle.requirements,
        });
        return value;
      },
    },
    {
      name: "a proxied requirement array",
      make: (bundle: PlanBundle): unknown => ({
        artifactRef: bundle.artifactRef,
        planSha256: bundle.planSha256,
        requiredChecksSha256: bundle.requiredChecksSha256,
        requiredChecks: new Proxy(bundle.requirements, {}),
      }),
    },
    {
      name: "an oversized requirement array",
      make: (bundle: PlanBundle): unknown => ({
        artifactRef: bundle.artifactRef,
        planSha256: bundle.planSha256,
        requiredChecksSha256: bundle.requiredChecksSha256,
        requiredChecks: Array.from({ length: 1_001 }, (_, index) => ({
          checkKind: "COUNT",
          checkKey: `count_${index}`,
          scopeKey: "all",
          measureUnit: null,
          decimalScale: null,
        })),
      }),
    },
    {
      name: "a proxied requirement",
      make: (bundle: PlanBundle): unknown => ({
        artifactRef: bundle.artifactRef,
        planSha256: bundle.planSha256,
        requiredChecksSha256: bundle.requiredChecksSha256,
        requiredChecks: [new Proxy(bundle.requirements[0]!, {})],
      }),
    },
    {
      name: "an accessor-bearing requirement",
      make: (bundle: PlanBundle): unknown => {
        const requirement: Record<string, unknown> = {
          checkKind: "COUNT",
          scopeKey: "all",
          measureUnit: null,
          decimalScale: null,
        };
        Object.defineProperty(requirement, "checkKey", {
          enumerable: true,
          get: () => "customers.total",
        });
        return {
          artifactRef: bundle.artifactRef,
          planSha256: bundle.planSha256,
          requiredChecksSha256: bundle.requiredChecksSha256,
          requiredChecks: [requirement],
        };
      },
    },
    {
      name: "an oversized digest",
      make: (bundle: PlanBundle): unknown => ({
        artifactRef: bundle.artifactRef,
        planSha256: new Uint8Array(1_000_000),
        requiredChecksSha256: bundle.requiredChecksSha256,
        requiredChecks: bundle.requirements,
      }),
    },
  ])("rejects hostile verifier output containing $name", async ({ make }) => {
    const fixture = await seedFixture();
    const bundle = planBundle();
    const verifier: ReconciliationPlanVerifier = {
      verify: vi.fn(async () => make(bundle) as VerifiedReconciliationPlan),
    };
    await expect(
      recordReconciliationRun(
        fixture.signerActor,
        recordInput(fixture, bundle),
        verifier,
      ),
    ).rejects.toMatchObject({ status: 422, code: "RECONCILIATION_PLAN_INVALID" });
  });

  it.each([
    {
      name: "artifact reference",
      override: (): Partial<VerifiedReconciliationPlan> => ({
        artifactRef: protectedRef("substituted-plan"),
      }),
    },
    {
      name: "plan digest",
      override: (): Partial<VerifiedReconciliationPlan> => ({
        planSha256: sha256("altered-plan"),
      }),
    },
    {
      name: "requirement-set digest",
      override: (): Partial<VerifiedReconciliationPlan> => ({
        requiredChecksSha256: sha256("altered-requirements"),
      }),
    },
  ])("rejects an altered verified $name", async ({ override }) => {
    const fixture = await seedFixture();
    const bundle = planBundle();
    await expect(
      recordReconciliationRun(
        fixture.signerActor,
        recordInput(fixture, bundle),
        verifierFor(bundle, override()),
      ),
    ).rejects.toMatchObject({ status: 422, code: "RECONCILIATION_PLAN_MISMATCH" });
  });

  it("rejects a missing required result", async () => {
    const fixture = await seedFixture();
    const bundle = planBundle();
    await expect(
      recordReconciliationRun(
        fixture.signerActor,
        recordInput(fixture, bundle, {
          results: resultsFor(bundle.requirements).slice(0, -1),
        }),
        verifierFor(bundle),
      ),
    ).rejects.toMatchObject({ status: 422, code: "RECONCILIATION_RESULT_SET_MISMATCH" });
  });

  it("rejects an extra result", async () => {
    const fixture = await seedFixture();
    const bundle = planBundle();
    const extra: ReconciliationRequirement = {
      checkKind: "SAMPLE",
      checkKey: "extra.sample",
      scopeKey: "all",
      measureUnit: null,
      decimalScale: null,
    };
    await expect(
      recordReconciliationRun(
        fixture.signerActor,
        recordInput(fixture, bundle, {
          results: [...resultsFor(bundle.requirements), resultFor(extra)],
        }),
        verifierFor(bundle),
      ),
    ).rejects.toMatchObject({ status: 422, code: "RECONCILIATION_RESULT_SET_MISMATCH" });
  });

  it("rejects duplicate plan scope identities", async () => {
    const fixture = await seedFixture();
    const duplicate = { ...defaultRequirements[0] };
    const bundle = planBundle([defaultRequirements[0], duplicate]);
    await expect(
      recordReconciliationRun(
        fixture.signerActor,
        recordInput(fixture, bundle, {
          results: [resultFor(defaultRequirements[0])],
        }),
        verifierFor(bundle),
      ),
    ).rejects.toMatchObject({ status: 422, code: "RECONCILIATION_REQUIREMENT_DUPLICATE" });
  });

  it("rejects duplicate result scope identities", async () => {
    const fixture = await seedFixture();
    const bundle = planBundle();
    const results = resultsFor(bundle.requirements);
    await expect(
      recordReconciliationRun(
        fixture.signerActor,
        recordInput(fixture, bundle, { results: [...results, { ...results[0]! }] }),
        verifierFor(bundle),
      ),
    ).rejects.toMatchObject({ status: 422, code: "RECONCILIATION_RESULT_DUPLICATE" });
  });

  it("rejects the same result count with a substituted tuple", async () => {
    const fixture = await seedFixture();
    const bundle = planBundle();
    const results = resultsFor(bundle.requirements);
    results[0] = { ...results[0]!, checkKey: "customers.substituted" };
    await expect(
      recordReconciliationRun(
        fixture.signerActor,
        recordInput(fixture, bundle, { results }),
        verifierFor(bundle),
      ),
    ).rejects.toMatchObject({ status: 422, code: "RECONCILIATION_RESULT_SET_MISMATCH" });
  });

  it("accepts reordered plan and result tuples but persists the bytewise canonical set", async () => {
    const fixture = await seedFixture();
    const bundle = planBundle([...defaultRequirements].reverse());
    const result = await recordReconciliationRun(
      fixture.signerActor,
      recordInput(fixture, bundle, { results: resultsFor(bundle.requirements).reverse() }),
      verifierFor(bundle),
    );
    const [stored] = await sql<{
      required_checks: unknown[];
      required_sha: Buffer;
      result_keys: string[];
    }[]>`
      select run.required_checks,
             run.required_checks_sha256 as required_sha,
             array_agg(result.check_kind || ':' || result.check_key order by result.check_kind,
                       result.check_key) as result_keys
      from reconciliation_runs run
      join reconciliation_results result on result.run_id = run.id
      where run.id = ${result.runId}
      group by run.id
    `;
    const canonical = canonicalRequirements(bundle.requirements);
    expect(stored?.required_checks).toEqual(
      canonical.map((requirement) => ({
        check_kind: requirement.checkKind,
        check_key: requirement.checkKey,
        scope_key: requirement.scopeKey,
        measure_unit: requirement.measureUnit,
        decimal_scale: requirement.decimalScale,
      })),
    );
    expect(stored?.required_sha).toEqual(requiredSetSha256(bundle.requirements));
    expect(stored?.result_keys).toEqual(
      canonical.map((requirement) => `${requirement.checkKind}:${requirement.checkKey}`),
    );
  });

  it("persists bytewise punctuation order independently of the database locale", async () => {
    const fixture = await seedFixture();
    const requirements: ReconciliationRequirement[] = [
      {
        checkKind: "COUNT",
        checkKey: "a_",
        scopeKey: "all",
        measureUnit: null,
        decimalScale: null,
      },
      {
        checkKind: "COUNT",
        checkKey: "a.a",
        scopeKey: "all",
        measureUnit: null,
        decimalScale: null,
      },
    ];
    const bundle = planBundle(requirements);
    const recorded = await recordReconciliationRun(
      fixture.signerActor,
      recordInput(fixture, bundle),
      verifierFor(bundle),
    );
    const [stored] = await sql<{ keys: string[] }[]>`
      select array(
        select requirement ->> 'check_key'
        from reconciliation_runs run,
             jsonb_array_elements(run.required_checks) with ordinality required(requirement, n)
        where run.id = ${recorded.runId}
        order by required.n
      ) as keys
    `;
    expect(stored?.keys).toEqual(["a.a", "a_"]);
  });

  it("rejects a result whose numeric scale differs from the reviewed requirement", async () => {
    const fixture = await seedFixture();
    const bundle = planBundle();
    const results = resultsFor(bundle.requirements);
    results[1] = {
      ...results[1]!,
      decimalScale: 3,
      sourceAmount: "12345678901234567890123456.780",
      targetAmount: "12345678901234567890123456.780",
    };
    await expect(
      recordReconciliationRun(
        fixture.signerActor,
        recordInput(fixture, bundle, { results }),
        verifierFor(bundle),
      ),
    ).rejects.toMatchObject({ status: 422, code: "RECONCILIATION_RESULT_SET_MISMATCH" });
  });

  it.each([
    ["-1", -1],
    ["13", 13],
    ["fraction", 1.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("rejects invalid decimal scale %s", async (_name, decimalScale) => {
    const fixture = await seedFixture();
    const requirement = {
      checkKind: "AMOUNT",
      checkKey: "amount.boundary",
      scopeKey: "all",
      measureUnit: "MYR",
      decimalScale,
    } as ReconciliationRequirement;
    const bundle = planBundle([requirement]);
    await expect(
      recordReconciliationRun(
        fixture.signerActor,
        recordInput(fixture, bundle, {
          results: [resultFor(defaultRequirements[0])],
        }),
        verifierFor(bundle),
      ),
    ).rejects.toMatchObject({ status: 422, code: "RECONCILIATION_PLAN_INVALID" });
  });

  it.each([
    ["lowercase", "myr"],
    ["leading space", " MYR"],
    ["trailing space", "MYR "],
    ["control", "MYR\n"],
    ["unicode", "M¥R"],
    ["too long", "M".repeat(33)],
  ])("rejects a non-canonical measure unit: %s", async (_name, measureUnit) => {
    const fixture = await seedFixture();
    const requirement: ReconciliationRequirement = {
      checkKind: "AMOUNT",
      checkKey: "amount.unit",
      scopeKey: "all",
      measureUnit,
      decimalScale: 2,
    };
    const bundle = planBundle([requirement]);
    await expect(
      recordReconciliationRun(
        fixture.signerActor,
        recordInput(fixture, bundle, {
          results: [resultFor(defaultRequirements[0])],
        }),
        verifierFor(bundle),
      ),
    ).rejects.toMatchObject({ status: 422, code: "RECONCILIATION_PLAN_INVALID" });
  });

  it("accepts unit length 32 and decimal scales 0 and 12", async () => {
    const fixture = await seedFixture();
    const requirements: ReconciliationRequirement[] = [
      {
        checkKind: "AMOUNT",
        checkKey: "amount.scale_zero",
        scopeKey: "all",
        measureUnit: "U".repeat(32),
        decimalScale: 0,
      },
      {
        checkKind: "FINANCE_BALANCE",
        checkKey: "amount.scale_twelve",
        scopeKey: "all",
        measureUnit: "MYR",
        decimalScale: 12,
      },
    ];
    const bundle = planBundle(requirements);
    const results = [
      resultFor(requirements[0]!, { sourceAmount: "1", targetAmount: "1" }),
      resultFor(requirements[1]!, {
        sourceAmount: "99999999999999999999999999.123456789012",
        targetAmount: "99999999999999999999999999.123456789012",
      }),
    ];
    await expect(
      recordReconciliationRun(
        fixture.signerActor,
        recordInput(fixture, bundle, { results }),
        verifierFor(bundle),
      ),
    ).resolves.toMatchObject({ passed: true });
  });

  it.each([
    ["too many integer digits", "100000000000000000000000000.00"],
    ["wrong fractional scale", "1.2"],
    ["exponent", "1e2"],
    ["leading plus", "+1.00"],
    ["leading zero", "01.00"],
    ["negative zero", "-0.00"],
  ])("rejects a non-canonical fixed decimal: %s", async (_name, amount) => {
    const fixture = await seedFixture();
    const requirement: ReconciliationRequirement = {
      checkKind: "AMOUNT",
      checkKey: "amount.precision",
      scopeKey: "all",
      measureUnit: "MYR",
      decimalScale: 2,
    };
    const bundle = planBundle([requirement]);
    await expect(
      recordReconciliationRun(
        fixture.signerActor,
        recordInput(fixture, bundle, {
          results: [resultFor(requirement, { sourceAmount: amount, targetAmount: amount })],
        }),
        verifierFor(bundle),
      ),
    ).rejects.toMatchObject({ status: 422, code: "RECONCILIATION_RESULT_INVALID" });
  });

  it.each([
    {
      name: "COUNT mismatch reported as passed",
      requirement: defaultRequirements[0],
      overrides: { targetCount: 8n, passed: true },
    },
    {
      name: "COUNT equality reported as failed",
      requirement: defaultRequirements[0],
      overrides: { passed: false },
    },
    {
      name: "AMOUNT mismatch reported as passed",
      requirement: defaultRequirements[1],
      overrides: { targetAmount: "12345678901234567890123456.79", passed: true },
    },
    {
      name: "CHECKSUM mismatch reported as passed",
      requirement: defaultRequirements[2],
      overrides: { targetChecksum: sha256("different-checksum"), passed: true },
    },
  ])("rejects caller disagreement with derived $name", async ({ requirement, overrides }) => {
    const fixture = await seedFixture();
    const bundle = planBundle([requirement]);
    await expect(
      recordReconciliationRun(
        fixture.signerActor,
        recordInput(fixture, bundle, {
          results: [resultFor(requirement, overrides)],
        }),
        verifierFor(bundle),
      ),
    ).rejects.toMatchObject({ status: 422, code: "RECONCILIATION_PASSED_DISAGREEMENT" });
  });

  it.each([
    ["negative", -1n],
    ["above bigint", 9_223_372_036_854_775_808n],
  ])("rejects a COUNT outside PostgreSQL bigint: %s", async (_name, sourceCount) => {
    const fixture = await seedFixture();
    const requirement = defaultRequirements[0];
    const bundle = planBundle([requirement]);
    await expect(
      recordReconciliationRun(
        fixture.signerActor,
        recordInput(fixture, bundle, {
          results: [resultFor(requirement, { sourceCount, targetCount: sourceCount })],
        }),
        verifierFor(bundle),
      ),
    ).rejects.toMatchObject({ status: 422, code: "RECONCILIATION_RESULT_INVALID" });
  });

  it("accepts the PostgreSQL bigint COUNT boundary", async () => {
    const fixture = await seedFixture();
    const requirement = defaultRequirements[0];
    const bundle = planBundle([requirement]);
    await expect(
      recordReconciliationRun(
        fixture.signerActor,
        recordInput(fixture, bundle, {
          results: [
            resultFor(requirement, {
              sourceCount: 9_223_372_036_854_775_807n,
              targetCount: 9_223_372_036_854_775_807n,
            }),
          ],
        }),
        verifierFor(bundle),
      ),
    ).resolves.toMatchObject({ passed: true });
  });

  it("records an explicit non-derived failed check as a FAILED run", async () => {
    const fixture = await seedFixture();
    const requirement = defaultRequirements[3];
    const bundle = planBundle([requirement]);
    const recorded = await recordReconciliationRun(
      fixture.signerActor,
      recordInput(fixture, bundle, {
        results: [resultFor(requirement, { passed: false })],
      }),
      verifierFor(bundle),
    );
    expect(recorded.passed).toBe(false);
    const [stored] = await sql<{
      status: string;
      passed_count: number;
      failed_count: number;
      batch_status: string;
    }[]>`
      select run.status, run.passed_check_count as passed_count,
             run.failed_check_count as failed_count, batch.status as batch_status
      from reconciliation_runs run
      join import_batches batch on batch.id = run.batch_id
      where run.id = ${recorded.runId}
    `;
    expect(stored).toEqual({
      status: "FAILED",
      passed_count: 0,
      failed_count: 1,
      batch_status: "APPLIED",
    });
  });

  it("rejects stale batch versions and leaves the verifier unused", async () => {
    const fixture = await seedFixture();
    const bundle = planBundle();
    const verifier = verifierFor(bundle);
    await expect(
      recordReconciliationRun(
        fixture.signerActor,
        recordInput(fixture, bundle, { expectedBatchVersion: fixture.batchVersion + 1 }),
        verifier,
      ),
    ).rejects.toMatchObject({ status: 409, code: "IMPORT_BATCH_VERSION_CONFLICT" });
    expect(verifier.verify).not.toHaveBeenCalled();
  });

  it("does not treat an archived source without terminal proof as a replay", async () => {
    const fixture = await seedFixture();
    const bundle = planBundle();
    const verifier = verifierFor(bundle);
    await archiveCanonicalSource(fixture);

    await expect(
      recordReconciliationRun(
        fixture.signerActor,
        recordInput(fixture, bundle),
        verifier,
      ),
    ).rejects.toMatchObject({ status: 409, code: "MIGRATION_SOURCE_NOT_ACTIVE" });
    expect(verifier.verify).not.toHaveBeenCalled();
    const [stored] = await sql<{ runs: number; audits: number; outbox: number }[]>`
      select
        (select count(*)::int from reconciliation_runs
          where batch_id = ${fixture.batchId}) as runs,
        (select count(*)::int from audit_events
          where correlation_id = ${fixture.batchId}
            and action = 'MIGRATION_RECONCILIATION_RUN_RECORDED') as audits,
        (select count(*)::int from outbox_events
          where correlation_id = ${fixture.batchId}
            and event_type = 'crm.migration.reconciliation_run_recorded') as outbox
    `;
    expect(stored).toEqual({ runs: 0, audits: 0, outbox: 0 });
  });

  it("returns the original run with zero new effects for an exact replay", async () => {
    const fixture = await seedFixture();
    const bundle = planBundle();
    const input = recordInput(fixture, bundle);
    const first = await recordReconciliationRun(
      fixture.signerActor,
      input,
      verifierFor(bundle),
    );
    const replay = await recordReconciliationRun(
      fixture.signerActor,
      input,
      verifierFor(bundle),
    );
    expect(replay).toEqual(first);
    const [stored] = await sql<{ runs: number; results: number; audits: number; outbox: number }[]>`
      select
        (select count(*)::int from reconciliation_runs where batch_id = ${fixture.batchId}) as runs,
        (select count(*)::int from reconciliation_results where run_id = ${first.runId}) as results,
        (select count(*)::int from audit_events where target_id = ${first.runId}
          and action = 'MIGRATION_RECONCILIATION_RUN_RECORDED') as audits,
        (select count(*)::int from outbox_events where aggregate_id = ${first.runId}
          and event_type = 'crm.migration.reconciliation_run_recorded') as outbox
    `;
    expect(stored).toEqual({
      runs: 1,
      results: defaultRequirements.length,
      audits: 1,
      outbox: 1,
    });
  });

  it("keeps live APPLIED record replays behind current tenant and capability checks", async () => {
    const fixture = await seedFixture();
    const bundle = planBundle();
    const input = recordInput(fixture, bundle);
    await recordReconciliationRun(fixture.signerActor, input, verifierFor(bundle));
    await sql`
      delete from membership_roles
      where organization_id = ${fixture.organizationId}
        and membership_id = ${fixture.signerMembershipId}
    `;
    const verifier = verifierFor(bundle);

    await expect(
      recordReconciliationRun(fixture.signerActor, input, verifier),
    ).rejects.toMatchObject({ status: 403, code: "MIGRATION_CAPABILITY_REQUIRED" });
    expect(verifier.verify).not.toHaveBeenCalled();
  });

  it("returns the original signed run for an exact terminal record replay", async () => {
    const fixture = await seedFixture();
    const bundle = planBundle();
    const input = recordInput(fixture, bundle);
    const recorded = await recordReconciliationRun(
      fixture.signerActor,
      input,
      verifierFor(bundle),
    );
    await signReconciliationRun(fixture.signerActor, {
      runId: recorded.runId,
      expectedRunVersion: 1,
      approvalReason: "Independent reconciliation review complete",
    });
    await expect(
      recordReconciliationRun(fixture.signerActor, input, verifierFor(bundle)),
    ).resolves.toEqual(recorded);
    const [stored] = await sql<{
      runs: number;
      record_audits: number;
      record_outbox: number;
      sign_audits: number;
      sign_outbox: number;
      batch_status: string;
    }[]>`
      select
        (select count(*)::int from reconciliation_runs where batch_id = ${fixture.batchId}) as runs,
        (select count(*)::int from audit_events where target_id = ${recorded.runId}
          and action = 'MIGRATION_RECONCILIATION_RUN_RECORDED') as record_audits,
        (select count(*)::int from outbox_events where aggregate_id = ${recorded.runId}
          and event_type = 'crm.migration.reconciliation_run_recorded') as record_outbox,
        (select count(*)::int from audit_events where target_id = ${recorded.runId}
          and action = 'MIGRATION_RECONCILIATION_RUN_SIGNED') as sign_audits,
        (select count(*)::int from outbox_events where aggregate_id = ${recorded.runId}
          and event_type = 'crm.migration.reconciliation_run_signed') as sign_outbox,
        (select status from import_batches where id = ${fixture.batchId}) as batch_status
    `;
    expect(stored).toEqual({
      runs: 1,
      record_audits: 1,
      record_outbox: 1,
      sign_audits: 1,
      sign_outbox: 1,
      batch_status: "RECONCILED",
    });
  });

  it.each(["PASSED", "FAILED"] as const)(
    "replays an older %s run after a later run is signed",
    async (historicalStatus) => {
      const fixture = await seedFixture();
      const bundle = planBundle();
      const historicalResults = resultsFor(bundle.requirements);
      if (historicalStatus === "FAILED") {
        historicalResults[3] = { ...historicalResults[3]!, passed: false };
      }
      const historicalInput = recordInput(fixture, bundle, {
        results: historicalResults,
      });
      const historical = await recordReconciliationRun(
        fixture.signerActor,
        historicalInput,
        verifierFor(bundle),
      );
      const latest = await recordReconciliationRun(
        fixture.signerActor,
        recordInput(fixture, bundle, { runNo: 2 }),
        verifierFor(bundle),
      );
      await signReconciliationRun(fixture.signerActor, {
        runId: latest.runId,
        expectedRunVersion: 1,
        approvalReason: "Independent reconciliation review complete",
      });
      await archiveCanonicalSource(fixture);
      await sql`
        delete from membership_roles
        where organization_id = ${fixture.organizationId}
          and membership_id = ${fixture.signerMembershipId}
      `;
      const replayVerifier = verifierFor(bundle);

      await expect(
        recordReconciliationRun(
          fixture.signerActor,
          historicalInput,
          replayVerifier,
        ),
      ).resolves.toEqual(historical);
      expect(replayVerifier.verify).toHaveBeenCalledTimes(1);
      const [stored] = await sql<{
        runs: number;
        historical_status: string;
        latest_status: string;
        historical_record_audits: number;
        historical_record_outbox: number;
        historical_sign_audits: number;
      }[]>`
        select
          (select count(*)::int from reconciliation_runs
            where batch_id = ${fixture.batchId}) as runs,
          (select status from reconciliation_runs
            where id = ${historical.runId}) as historical_status,
          (select status from reconciliation_runs
            where id = ${latest.runId}) as latest_status,
          (select count(*)::int from audit_events where target_id = ${historical.runId}
            and action = 'MIGRATION_RECONCILIATION_RUN_RECORDED')
              as historical_record_audits,
          (select count(*)::int from outbox_events where aggregate_id = ${historical.runId}
            and event_type = 'crm.migration.reconciliation_run_recorded')
              as historical_record_outbox,
          (select count(*)::int from audit_events where target_id = ${historical.runId}
            and action = 'MIGRATION_RECONCILIATION_RUN_SIGNED')
              as historical_sign_audits
      `;
      expect(stored).toEqual({
        runs: 2,
        historical_status: historicalStatus,
        latest_status: "SIGNED",
        historical_record_audits: 1,
        historical_record_outbox: 1,
        historical_sign_audits: 0,
      });
    },
  );

  it("binds the original batch version into terminal record replay proof", async () => {
    const fixture = await seedFixture();
    const bundle = planBundle();
    const input = recordInput(fixture, bundle);
    const recorded = await recordReconciliationRun(
      fixture.signerActor,
      input,
      verifierFor(bundle),
    );
    await signReconciliationRun(fixture.signerActor, {
      runId: recorded.runId,
      expectedRunVersion: 1,
      approvalReason: "Independent reconciliation review complete",
    });
    await archiveCanonicalSource(fixture);

    await expect(
      recordReconciliationRun(
        fixture.signerActor,
        { ...input, expectedBatchVersion: input.expectedBatchVersion + 1 },
        verifierFor(bundle),
      ),
    ).rejects.toMatchObject({
      status: 409,
      code: "RECONCILIATION_RUN_REPLAY_CONFLICT",
    });
  });

  it("converges an exact record replay that straddles sign-off and source archival", async () => {
    const fixture = await seedFixture();
    const bundle = planBundle();
    const input = recordInput(fixture, bundle);
    const recorded = await recordReconciliationRun(
      fixture.signerActor,
      input,
      verifierFor(bundle),
    );
    let signalVerifierStarted!: () => void;
    const verifierStarted = new Promise<void>((resolve) => {
      signalVerifierStarted = resolve;
    });
    let releaseVerifier!: () => void;
    const verifierReleased = new Promise<void>((resolve) => {
      releaseVerifier = resolve;
    });
    const baseVerifier = verifierFor(bundle);
    const replay = recordReconciliationRun(fixture.signerActor, input, {
      verify: vi.fn(async (artifactRef, expectedPlanSha256) => {
        const verified = await baseVerifier.verify(artifactRef, expectedPlanSha256);
        signalVerifierStarted();
        await verifierReleased;
        return verified;
      }),
    });
    await verifierStarted;
    try {
      await signReconciliationRun(fixture.signerActor, {
        runId: recorded.runId,
        expectedRunVersion: 1,
        approvalReason: "Independent reconciliation review complete",
      });
      await archiveCanonicalSource(fixture);
    } finally {
      releaseVerifier();
    }

    await expect(replay).resolves.toEqual(recorded);
  });

  it.each([
    {
      authorityChange: "the sign grant is removed",
      revokeCurrentAuthority: async (fixture: Fixture) => {
        await sql`
          delete from membership_roles
          where organization_id = ${fixture.organizationId}
            and membership_id = ${fixture.signerMembershipId}
        `;
      },
    },
    {
      authorityChange: "the signer membership is revoked",
      revokeCurrentAuthority: async (fixture: Fixture) => {
        await sql`
          update memberships set status = 'REVOKED'
          where organization_id = ${fixture.organizationId}
            and id = ${fixture.signerMembershipId}
        `;
      },
    },
  ])(
    "converges two first-time record writers after $authorityChange",
    async ({ revokeCurrentAuthority }) => {
      const fixture = await seedFixture();
      const bundle = planBundle();
      const input = recordInput(fixture, bundle);
      let signalBlockedVerifierStarted!: () => void;
      const blockedVerifierStarted = new Promise<void>((resolve) => {
        signalBlockedVerifierStarted = resolve;
      });
      let releaseBlockedVerifier!: () => void;
      const blockedVerifierReleased = new Promise<void>((resolve) => {
        releaseBlockedVerifier = resolve;
      });
      const baseVerifier = verifierFor(bundle);
      const blockedVerifier = vi.fn(async (
        artifactRef: string,
        expectedPlanSha256: Uint8Array,
      ) => {
        const verified = await baseVerifier.verify(artifactRef, expectedPlanSha256);
        signalBlockedVerifierStarted();
        await blockedVerifierReleased;
        return verified;
      });
      const writerB = recordReconciliationRun(fixture.signerActor, input, {
        verify: blockedVerifier,
      });
      await blockedVerifierStarted;

      let writerA!: { runId: string; passed: boolean };
      try {
        writerA = await recordReconciliationRun(
          fixture.signerActor,
          input,
          verifierFor(bundle),
        );
        await signReconciliationRun(fixture.signerActor, {
          runId: writerA.runId,
          expectedRunVersion: 1,
          approvalReason: "Independent reconciliation review complete",
        });
        await archiveCanonicalSource(fixture);
        await revokeCurrentAuthority(fixture);
      } finally {
        releaseBlockedVerifier();
      }

      await expect(writerB).resolves.toEqual(writerA);
      expect(blockedVerifier).toHaveBeenCalledTimes(1);
      const [stored] = await sql<{
        runs: number;
        results: number;
        record_audits: number;
        record_outbox: number;
        sign_audits: number;
        sign_outbox: number;
        batch_status: string;
        source_status: string;
      }[]>`
        select
          (select count(*)::int from reconciliation_runs
            where batch_id = ${fixture.batchId}) as runs,
          (select count(*)::int from reconciliation_results
            where run_id = ${writerA.runId}) as results,
          (select count(*)::int from audit_events where target_id = ${writerA.runId}
            and action = 'MIGRATION_RECONCILIATION_RUN_RECORDED') as record_audits,
          (select count(*)::int from outbox_events where aggregate_id = ${writerA.runId}
            and event_type = 'crm.migration.reconciliation_run_recorded') as record_outbox,
          (select count(*)::int from audit_events where target_id = ${writerA.runId}
            and action = 'MIGRATION_RECONCILIATION_RUN_SIGNED') as sign_audits,
          (select count(*)::int from outbox_events where aggregate_id = ${writerA.runId}
            and event_type = 'crm.migration.reconciliation_run_signed') as sign_outbox,
          (select status from import_batches where id = ${fixture.batchId}) as batch_status,
          (select status from migration_sources where id = ${fixture.sourceId}) as source_status
      `;
      expect(stored).toEqual({
        runs: 1,
        results: defaultRequirements.length,
        record_audits: 1,
        record_outbox: 1,
        sign_audits: 1,
        sign_outbox: 1,
        batch_status: "RECONCILED",
        source_status: "ARCHIVED_READ_ONLY",
      });
    },
  );

  it("refreshes a first-time MUTATION preflight when another writer reaches terminal state", async () => {
    const fixture = await seedFixture();
    const bundle = planBundle();
    const input = recordInput(fixture, bundle);
    const database = databaseClient.getDatabase();
    const originalTransaction = database.transaction.bind(database);
    let transactionCalls = 0;
    let signalSecondPreflightStarted!: () => void;
    const secondPreflightStarted = new Promise<void>((resolve) => {
      signalSecondPreflightStarted = resolve;
    });
    let releaseSecondPreflight!: () => void;
    const secondPreflightReleased = new Promise<void>((resolve) => {
      releaseSecondPreflight = resolve;
    });
    const gatedDatabase = new Proxy(database, {
      get(target, property, receiver) {
        if (property !== "transaction") return Reflect.get(target, property, receiver);
        return async (...args: Parameters<typeof database.transaction>) => {
          transactionCalls += 1;
          if (transactionCalls === 2) {
            signalSecondPreflightStarted();
            await secondPreflightReleased;
          }
          return originalTransaction(...args);
        };
      },
    });
    const databaseSpy = vi
      .spyOn(databaseClient, "getDatabase")
      .mockReturnValueOnce(gatedDatabase);
    const blockedVerifier = verifierFor(bundle);
    const writerB = recordReconciliationRun(
      fixture.signerActor,
      input,
      blockedVerifier,
    );
    await secondPreflightStarted;
    expect(blockedVerifier.verify).not.toHaveBeenCalled();

    databaseSpy.mockRestore();
    let writerA!: { runId: string; passed: boolean };
    try {
      writerA = await recordReconciliationRun(
        fixture.signerActor,
        input,
        verifierFor(bundle),
      );
      await signReconciliationRun(fixture.signerActor, {
        runId: writerA.runId,
        expectedRunVersion: 1,
        approvalReason: "Independent reconciliation review complete",
      });
      await archiveCanonicalSource(fixture);
    } finally {
      databaseSpy.mockRestore();
      releaseSecondPreflight();
    }

    await expect(writerB).resolves.toEqual(writerA);
    expect(blockedVerifier.verify).toHaveBeenCalledTimes(1);
    const [stored] = await sql<{
      runs: number;
      record_audits: number;
      record_outbox: number;
      sign_audits: number;
      sign_outbox: number;
    }[]>`
      select
        (select count(*)::int from reconciliation_runs
          where batch_id = ${fixture.batchId}) as runs,
        (select count(*)::int from audit_events where target_id = ${writerA.runId}
          and action = 'MIGRATION_RECONCILIATION_RUN_RECORDED') as record_audits,
        (select count(*)::int from outbox_events where aggregate_id = ${writerA.runId}
          and event_type = 'crm.migration.reconciliation_run_recorded') as record_outbox,
        (select count(*)::int from audit_events where target_id = ${writerA.runId}
          and action = 'MIGRATION_RECONCILIATION_RUN_SIGNED') as sign_audits,
        (select count(*)::int from outbox_events where aggregate_id = ${writerA.runId}
          and event_type = 'crm.migration.reconciliation_run_signed') as sign_outbox
    `;
    expect(stored).toEqual({
      runs: 1,
      record_audits: 1,
      record_outbox: 1,
      sign_audits: 1,
      sign_outbox: 1,
    });
  });

  it("refreshes a MUTATION preflight after sign-off while authority remains active", async () => {
    const fixture = await seedFixture();
    const bundle = planBundle();
    const input = recordInput(fixture, bundle);
    const database = databaseClient.getDatabase();
    const originalTransaction = database.transaction.bind(database);
    let transactionCalls = 0;
    let signalSecondPreflightStarted!: () => void;
    const secondPreflightStarted = new Promise<void>((resolve) => {
      signalSecondPreflightStarted = resolve;
    });
    let releaseSecondPreflight!: () => void;
    const secondPreflightReleased = new Promise<void>((resolve) => {
      releaseSecondPreflight = resolve;
    });
    const gatedDatabase = new Proxy(database, {
      get(target, property, receiver) {
        if (property !== "transaction") return Reflect.get(target, property, receiver);
        return async (...args: Parameters<typeof database.transaction>) => {
          transactionCalls += 1;
          if (transactionCalls === 2) {
            signalSecondPreflightStarted();
            await secondPreflightReleased;
          }
          return originalTransaction(...args);
        };
      },
    });
    const databaseSpy = vi
      .spyOn(databaseClient, "getDatabase")
      .mockReturnValueOnce(gatedDatabase);
    const blockedVerifier = verifierFor(bundle);
    const writerB = recordReconciliationRun(
      fixture.signerActor,
      input,
      blockedVerifier,
    );
    await secondPreflightStarted;
    expect(blockedVerifier.verify).not.toHaveBeenCalled();

    databaseSpy.mockRestore();
    let writerA!: { runId: string; passed: boolean };
    try {
      writerA = await recordReconciliationRun(
        fixture.signerActor,
        input,
        verifierFor(bundle),
      );
      await signReconciliationRun(fixture.signerActor, {
        runId: writerA.runId,
        expectedRunVersion: 1,
        approvalReason: "Independent reconciliation review complete",
      });
    } finally {
      databaseSpy.mockRestore();
      releaseSecondPreflight();
    }

    await expect(writerB).resolves.toEqual(writerA);
    expect(blockedVerifier.verify).toHaveBeenCalledTimes(1);
    const [stored] = await sql<{
      runs: number;
      record_audits: number;
      record_outbox: number;
      source_status: string;
      grants: number;
    }[]>`
      select
        (select count(*)::int from reconciliation_runs
          where batch_id = ${fixture.batchId}) as runs,
        (select count(*)::int from audit_events where target_id = ${writerA.runId}
          and action = 'MIGRATION_RECONCILIATION_RUN_RECORDED') as record_audits,
        (select count(*)::int from outbox_events where aggregate_id = ${writerA.runId}
          and event_type = 'crm.migration.reconciliation_run_recorded') as record_outbox,
        (select status from migration_sources where id = ${fixture.sourceId}) as source_status,
        (select count(*)::int from membership_roles
          where organization_id = ${fixture.organizationId}
            and membership_id = ${fixture.signerMembershipId}) as grants
    `;
    expect(stored).toEqual({
      runs: 1,
      record_audits: 1,
      record_outbox: 1,
      source_status: "ACTIVE",
      grants: 1,
    });
  });

  it("rejects a record replay when its original audit/outbox proof is incomplete", async () => {
    const fixture = await seedFixture();
    const bundle = planBundle();
    const input = recordInput(fixture, bundle);
    const recorded = await recordReconciliationRun(
      fixture.signerActor,
      input,
      verifierFor(bundle),
    );
    await sql`
      delete from outbox_events
      where aggregate_id = ${recorded.runId}
        and event_type = 'crm.migration.reconciliation_run_recorded'
    `;
    await expect(
      recordReconciliationRun(fixture.signerActor, input, verifierFor(bundle)),
    ).rejects.toMatchObject({
      status: 409,
      code: "RECONCILIATION_RUN_REPLAY_CONFLICT",
    });
  });

  it.each([
    {
      name: "typed result",
      mutate: (results: ReconciliationResultInput[]) => {
        results[3] = { ...results[3]!, passed: false };
      },
    },
    {
      name: "redacted evidence",
      mutate: (results: ReconciliationResultInput[]) => {
        results[3] = {
          ...results[3]!,
          redactedEvidence: { ruleCode: "DIFFERENT_REVIEW" },
        };
      },
    },
  ])("rejects a divergent replay with the same run number: $name", async ({ mutate }) => {
    const fixture = await seedFixture();
    const bundle = planBundle();
    await recordReconciliationRun(
      fixture.signerActor,
      recordInput(fixture, bundle),
      verifierFor(bundle),
    );
    const results = resultsFor(bundle.requirements);
    mutate(results);
    await expect(
      recordReconciliationRun(
        fixture.signerActor,
        recordInput(fixture, bundle, { results }),
        verifierFor(bundle),
      ),
    ).rejects.toMatchObject({ status: 409, code: "RECONCILIATION_RUN_CONFLICT" });
  });

  it("requires each new run number to be the next monotonic batch value", async () => {
    const fixture = await seedFixture();
    const bundle = planBundle();
    await expect(
      recordReconciliationRun(
        fixture.signerActor,
        recordInput(fixture, bundle, { runNo: 2 }),
        verifierFor(bundle),
      ),
    ).rejects.toMatchObject({ status: 409, code: "RECONCILIATION_RUN_SEQUENCE_INVALID" });
    await recordReconciliationRun(
      fixture.signerActor,
      recordInput(fixture, bundle),
      verifierFor(bundle),
    );
    await expect(
      recordReconciliationRun(
        fixture.signerActor,
        recordInput(fixture, bundle, { runNo: 3 }),
        verifierFor(bundle),
      ),
    ).rejects.toMatchObject({ status: 409, code: "RECONCILIATION_RUN_SEQUENCE_INVALID" });
    await expect(
      recordReconciliationRun(
        fixture.signerActor,
        recordInput(fixture, bundle, { runNo: 2 }),
        verifierFor(bundle),
      ),
    ).resolves.toMatchObject({ passed: true });
  });

  it("converges concurrent identical writers on the same run", async () => {
    const fixture = await seedFixture();
    const bundle = planBundle();
    const attempts = await Promise.all([
      recordReconciliationRun(
        fixture.signerActor,
        recordInput(fixture, bundle),
        verifierFor(bundle),
      ),
      recordReconciliationRun(
        fixture.signerActor,
        recordInput(fixture, bundle),
        verifierFor(bundle),
      ),
    ]);
    expect(attempts[0]).toEqual(attempts[1]);
    const [stored] = await sql<{
      runs: number;
      results: number;
      audits: number;
      outbox: number;
    }[]>`
      select count(distinct run.id)::int as runs, count(result.id)::int as results,
             count(distinct audit.id)::int as audits,
             count(distinct event.id)::int as outbox
      from reconciliation_runs run
      left join reconciliation_results result on result.run_id = run.id
      left join audit_events audit on audit.target_id = run.id
        and audit.action = 'MIGRATION_RECONCILIATION_RUN_RECORDED'
      left join outbox_events event on event.aggregate_id = run.id
        and event.event_type = 'crm.migration.reconciliation_run_recorded'
      where run.batch_id = ${fixture.batchId} and run.run_no = 1
    `;
    expect(stored).toEqual({
      runs: 1,
      results: defaultRequirements.length,
      audits: 1,
      outbox: 1,
    });
  });

  it("allows only one concurrent divergent writer for the same run number", async () => {
    const fixture = await seedFixture();
    const bundle = planBundle();
    const divergentResults = resultsFor(bundle.requirements);
    divergentResults[3] = { ...divergentResults[3]!, passed: false };
    const attempts = await Promise.allSettled([
      recordReconciliationRun(
        fixture.signerActor,
        recordInput(fixture, bundle),
        verifierFor(bundle),
      ),
      recordReconciliationRun(
        fixture.signerActor,
        recordInput(fixture, bundle, { results: divergentResults }),
        verifierFor(bundle),
      ),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const rejection = attempts.find((attempt) => attempt.status === "rejected");
    expect(rejection).toMatchObject({
      reason: { status: 409, code: "RECONCILIATION_RUN_CONFLICT" },
    });
  });

  it.each(["audit", "outbox"] as const)(
    "rolls back run, results, audit, and outbox when the %s effect fails",
    async (kind) => {
      const fixture = await seedFixture();
      const bundle = planBundle();
      const functionName = `crm_test_fail_reconcile_${kind}`;
      const table = kind === "audit" ? "audit_events" : "outbox_events";
      const condition =
        kind === "audit"
          ? "new.action = 'MIGRATION_RECONCILIATION_RUN_RECORDED'"
          : "new.event_type = 'crm.migration.reconciliation_run_recorded'";
      await sql.unsafe(`
        create function ${functionName}() returns trigger language plpgsql as $$
        begin
          if ${condition} then raise exception 'synthetic reconciliation ${kind} failure'; end if;
          return new;
        end; $$;
        create trigger ${functionName}_trigger before insert on ${table}
        for each row execute function ${functionName}();
      `);
      try {
        await expect(
          recordReconciliationRun(
            fixture.signerActor,
            recordInput(fixture, bundle),
            verifierFor(bundle),
          ),
        ).rejects.toMatchObject({ status: 500, code: "RECONCILIATION_RECORD_FAILED" });
      } finally {
        await sql.unsafe(`
          drop trigger if exists ${functionName}_trigger on ${table};
          drop function if exists ${functionName}();
        `);
      }
      const [stored] = await sql<{
        runs: number;
        results: number;
        audits: number;
        outbox: number;
      }[]>`
        select
          (select count(*)::int from reconciliation_runs where batch_id = ${fixture.batchId}) as runs,
          (select count(*)::int from reconciliation_results
            where organization_id = ${fixture.organizationId}) as results,
          (select count(*)::int from audit_events where correlation_id = ${fixture.batchId}
            and action = 'MIGRATION_RECONCILIATION_RUN_RECORDED') as audits,
          (select count(*)::int from outbox_events where correlation_id = ${fixture.batchId}
            and event_type = 'crm.migration.reconciliation_run_recorded') as outbox
      `;
      expect(stored).toEqual({ runs: 0, results: 0, audits: 0, outbox: 0 });
    },
  );

  it("records typed results and audit/outbox atomically without changing the batch", async () => {
    const fixture = await seedFixture();
    const bundle = planBundle();
    const recorded = await recordReconciliationRun(
      fixture.signerActor,
      recordInput(fixture, bundle),
      verifierFor(bundle),
    );
    const [stored] = await sql<{
      run_status: string;
      run_version: number;
      batch_status: string;
      batch_version: number;
      results: number;
      audits: number;
      outbox: number;
    }[]>`
      select run.status as run_status, run.version::int as run_version,
             batch.status as batch_status, batch.version::int as batch_version,
             (select count(*)::int from reconciliation_results where run_id = run.id) as results,
             (select count(*)::int from audit_events where target_id = run.id
               and action = 'MIGRATION_RECONCILIATION_RUN_RECORDED') as audits,
             (select count(*)::int from outbox_events where aggregate_id = run.id
               and event_type = 'crm.migration.reconciliation_run_recorded') as outbox
      from reconciliation_runs run
      join import_batches batch on batch.id = run.batch_id
      where run.id = ${recorded.runId}
    `;
    expect(stored).toEqual({
      run_status: "PASSED",
      run_version: 1,
      batch_status: "APPLIED",
      batch_version: fixture.batchVersion,
      results: defaultRequirements.length,
      audits: 1,
      outbox: 1,
    });
  });
});

describe("signReconciliationRun", () => {
  it("keeps a passed run unsigned and the batch APPLIED until explicit sign-off", async () => {
    const fixture = await seedFixture();
    const { runId } = await recordPassedRun(fixture);
    const [stored] = await sql<{
      run_status: string;
      signer: string | null;
      signed_at: Date | null;
      batch_status: string;
    }[]>`
      select run.status as run_status, run.signed_by_membership_id as signer,
             run.signed_at, batch.status as batch_status
      from reconciliation_runs run
      join import_batches batch on batch.id = run.batch_id
      where run.id = ${runId}
    `;
    expect(stored).toEqual({
      run_status: "PASSED",
      signer: null,
      signed_at: null,
      batch_status: "APPLIED",
    });
  });

  it("denies sign-off for a failed run", async () => {
    const fixture = await seedFixture();
    const requirement = defaultRequirements[3];
    const bundle = planBundle([requirement]);
    const recorded = await recordReconciliationRun(
      fixture.signerActor,
      recordInput(fixture, bundle, {
        results: [resultFor(requirement, { passed: false })],
      }),
      verifierFor(bundle),
    );
    await expect(
      signReconciliationRun(fixture.signerActor, {
        runId: recorded.runId,
        expectedRunVersion: 1,
        approvalReason: "Reviewed failed reconciliation evidence",
      }),
    ).rejects.toMatchObject({ status: 409, code: "RECONCILIATION_RUN_NOT_PASSED" });
  });

  it("denies an older passed run after a newer failed attempt", async () => {
    const fixture = await seedFixture();
    const bundle = planBundle();
    const passed = await recordReconciliationRun(
      fixture.signerActor,
      recordInput(fixture, bundle),
      verifierFor(bundle),
    );
    const failedResults = resultsFor(bundle.requirements);
    failedResults[3] = { ...failedResults[3]!, passed: false };
    const failed = await recordReconciliationRun(
      fixture.signerActor,
      recordInput(fixture, bundle, { runNo: 2, results: failedResults }),
      verifierFor(bundle),
    );
    expect(failed.passed).toBe(false);

    await expect(
      signReconciliationRun(fixture.signerActor, {
        runId: passed.runId,
        expectedRunVersion: 1,
        approvalReason: "Independent reconciliation review complete",
      }),
    ).rejects.toMatchObject({ status: 409, code: "RECONCILIATION_RUN_NOT_LATEST" });
    const [stored] = await sql<{
      passed_status: string;
      failed_status: string;
      batch_status: string;
      sign_audits: number;
      sign_outbox: number;
    }[]>`
      select older.status as passed_status, latest.status as failed_status,
             batch.status as batch_status,
             (select count(*)::int from audit_events where target_id = older.id
               and action = 'MIGRATION_RECONCILIATION_RUN_SIGNED') as sign_audits,
             (select count(*)::int from outbox_events where aggregate_id = older.id
               and event_type = 'crm.migration.reconciliation_run_signed') as sign_outbox
      from reconciliation_runs older
      join reconciliation_runs latest on latest.batch_id = older.batch_id and latest.run_no = 2
      join import_batches batch on batch.id = older.batch_id
      where older.id = ${passed.runId}
    `;
    expect(stored).toEqual({
      passed_status: "PASSED",
      failed_status: "FAILED",
      batch_status: "APPLIED",
      sign_audits: 0,
      sign_outbox: 0,
    });
  });

  it.each([
    ["empty", ""],
    ["sensitive", "password=do-not-store"],
    ["oversized", "R".repeat(2_001)],
  ])("rejects an %s approval reason", async (_name, approvalReason) => {
    const fixture = await seedFixture();
    const { runId } = await recordPassedRun(fixture);
    await expect(
      signReconciliationRun(fixture.signerActor, {
        runId,
        expectedRunVersion: 1,
        approvalReason,
      }),
    ).rejects.toMatchObject({ status: 422, code: "RECONCILIATION_APPROVAL_REASON_INVALID" });
  });

  it("requires a live migration.sign grant", async () => {
    const fixture = await seedFixture();
    const { runId } = await recordPassedRun(fixture);
    await expect(
      signReconciliationRun(
        { ...fixture.signerActor, capabilities: [] },
        {
          runId,
          expectedRunVersion: 1,
          approvalReason: "Independent reconciliation review complete",
        },
      ),
    ).rejects.toMatchObject({ status: 403, code: "MIGRATION_CAPABILITY_REQUIRED" });
    await sql`
      delete from membership_roles
      where organization_id = ${fixture.organizationId}
        and membership_id = ${fixture.signerMembershipId}
    `;
    await expect(
      signReconciliationRun(fixture.signerActor, {
        runId,
        expectedRunVersion: 1,
        approvalReason: "Independent reconciliation review complete",
      }),
    ).rejects.toMatchObject({ status: 403, code: "MIGRATION_CAPABILITY_REQUIRED" });
  });

  it("rejects a stale run version", async () => {
    const fixture = await seedFixture();
    const { runId } = await recordPassedRun(fixture);
    await expect(
      signReconciliationRun(fixture.signerActor, {
        runId,
        expectedRunVersion: 2,
        approvalReason: "Independent reconciliation review complete",
      }),
    ).rejects.toMatchObject({ status: 409, code: "RECONCILIATION_RUN_VERSION_CONFLICT" });
  });

  it("does not disclose a run across the wrong tenant or business unit", async () => {
    const fixture = await seedFixture();
    const other = await seedFixture();
    const { runId } = await recordPassedRun(fixture);
    const input = {
      runId,
      expectedRunVersion: 1,
      approvalReason: "Independent reconciliation review complete",
    };
    await expect(signReconciliationRun(other.signerActor, input)).rejects.toMatchObject({
      status: 404,
      code: "RECONCILIATION_RUN_NOT_FOUND",
    });
    await expect(
      signReconciliationRun(
        { ...fixture.signerActor, businessUnitId: randomUUID() },
        input,
      ),
    ).rejects.toMatchObject({ status: 404, code: "RECONCILIATION_RUN_NOT_FOUND" });
  });

  it.each([
    ["approver", (fixture: Fixture) => fixture.approverAsSignerActor],
    ["applier", (fixture: Fixture) => fixture.applierAsSignerActor],
  ])(
    "rejects the same underlying %s signing through another membership",
    async (_name, actorFor) => {
      const fixture = await seedFixture();
      const { runId } = await recordPassedRun(fixture);
      await expect(
        signReconciliationRun(actorFor(fixture), {
          runId,
          expectedRunVersion: 1,
          approvalReason: "Independent reconciliation review complete",
        }),
      ).rejects.toMatchObject({ status: 409, code: "RECONCILIATION_MAKER_CHECKER_REQUIRED" });
      await expectUnsignedState(fixture, runId);
    },
  );

  it("converges an exact sign lost-response replay with one effect set", async () => {
    const fixture = await seedFixture();
    const { runId } = await recordPassedRun(fixture);
    const input = {
      runId,
      expectedRunVersion: 1,
      approvalReason: "Independent reconciliation review complete",
    };
    await signReconciliationRun(fixture.signerActor, input);
    await expect(signReconciliationRun(fixture.signerActor, input)).resolves.toBeUndefined();
    const [stored] = await sql<{
      run_status: string;
      run_version: number;
      batch_status: string;
      batch_version: number;
      audits: number;
      outbox: number;
    }[]>`
      select run.status as run_status, run.version::int as run_version,
             batch.status as batch_status, batch.version::int as batch_version,
             (select count(*)::int from audit_events where target_id = run.id
               and action = 'MIGRATION_RECONCILIATION_RUN_SIGNED') as audits,
             (select count(*)::int from outbox_events where aggregate_id = run.id
               and event_type = 'crm.migration.reconciliation_run_signed') as outbox
      from reconciliation_runs run
      join import_batches batch on batch.id = run.batch_id
      where run.id = ${runId}
    `;
    expect(stored).toEqual({
      run_status: "SIGNED",
      run_version: 2,
      batch_status: "RECONCILED",
      batch_version: 2,
      audits: 1,
      outbox: 1,
    });
  });

  it("converges a sign replay whose locator straddles sign-off and source archival", async () => {
    const fixture = await seedFixture();
    const { runId } = await recordPassedRun(fixture);
    const input = {
      runId,
      expectedRunVersion: 1,
      approvalReason: "Independent reconciliation review complete",
    };
    const database = databaseClient.getDatabase();
    const originalTransaction = database.transaction.bind(database);
    let signalTransactionStarted!: () => void;
    const transactionStarted = new Promise<void>((resolve) => {
      signalTransactionStarted = resolve;
    });
    let releaseTransaction!: () => void;
    const transactionReleased = new Promise<void>((resolve) => {
      releaseTransaction = resolve;
    });
    const gatedDatabase = new Proxy(database, {
      get(target, property, receiver) {
        if (property !== "transaction") return Reflect.get(target, property, receiver);
        return async (...args: Parameters<typeof database.transaction>) => {
          signalTransactionStarted();
          await transactionReleased;
          return originalTransaction(...args);
        };
      },
    });
    const databaseSpy = vi
      .spyOn(databaseClient, "getDatabase")
      .mockReturnValueOnce(gatedDatabase);

    const staleReplay = signReconciliationRun(fixture.signerActor, input);
    await transactionStarted;
    databaseSpy.mockRestore();
    try {
      await signReconciliationRun(fixture.signerActor, input);
      await archiveCanonicalSource(fixture);
    } finally {
      databaseSpy.mockRestore();
      releaseTransaction();
    }

    await expect(staleReplay).resolves.toBeUndefined();
  });

  it.each([
    {
      authorityChange: "the sign grant is removed",
      revokeCurrentAuthority: async (fixture: Fixture) => {
        await sql`
          delete from membership_roles
          where organization_id = ${fixture.organizationId}
            and membership_id = ${fixture.signerMembershipId}
        `;
      },
    },
    {
      authorityChange: "the signer membership is revoked",
      revokeCurrentAuthority: async (fixture: Fixture) => {
        await sql`
          update memberships set status = 'REVOKED'
          where organization_id = ${fixture.organizationId}
            and id = ${fixture.signerMembershipId}
        `;
      },
    },
    {
      authorityChange: "the signer user is suspended",
      revokeCurrentAuthority: async (fixture: Fixture) => {
        await sql`
          update users set status = 'SUSPENDED'
          where id = ${fixture.signerActor.userId}
        `;
      },
    },
  ])(
    "converges a stale sign replay after $authorityChange",
    async ({ revokeCurrentAuthority }) => {
      const fixture = await seedFixture();
      const { runId } = await recordPassedRun(fixture);
      const input = {
        runId,
        expectedRunVersion: 1,
        approvalReason: "Independent reconciliation review complete",
      };
      const database = databaseClient.getDatabase();
      const originalTransaction = database.transaction.bind(database);
      let signalTransactionStarted!: () => void;
      const transactionStarted = new Promise<void>((resolve) => {
        signalTransactionStarted = resolve;
      });
      let releaseTransaction!: () => void;
      const transactionReleased = new Promise<void>((resolve) => {
        releaseTransaction = resolve;
      });
      const gatedDatabase = new Proxy(database, {
        get(target, property, receiver) {
          if (property !== "transaction") return Reflect.get(target, property, receiver);
          return async (...args: Parameters<typeof database.transaction>) => {
            signalTransactionStarted();
            await transactionReleased;
            return originalTransaction(...args);
          };
        },
      });
      const databaseSpy = vi
        .spyOn(databaseClient, "getDatabase")
        .mockReturnValueOnce(gatedDatabase);

      const staleReplay = signReconciliationRun(fixture.signerActor, input);
      await transactionStarted;
      databaseSpy.mockRestore();
      try {
        await signReconciliationRun(fixture.signerActor, input);
        await revokeCurrentAuthority(fixture);
      } finally {
        databaseSpy.mockRestore();
        releaseTransaction();
      }

      await expect(staleReplay).resolves.toBeUndefined();
      const [stored] = await sql<{
        run_status: string;
        batch_status: string;
        audits: number;
        outbox: number;
        source_status: string;
      }[]>`
        select run.status as run_status, batch.status as batch_status,
               (select count(*)::int from audit_events where target_id = run.id
                 and action = 'MIGRATION_RECONCILIATION_RUN_SIGNED') as audits,
               (select count(*)::int from outbox_events where aggregate_id = run.id
                 and event_type = 'crm.migration.reconciliation_run_signed') as outbox,
               (select status from migration_sources where id = ${fixture.sourceId})
                 as source_status
        from reconciliation_runs run
        join import_batches batch on batch.id = run.batch_id
        where run.id = ${runId}
      `;
      expect(stored).toEqual({
        run_status: "SIGNED",
        batch_status: "RECONCILED",
        audits: 1,
        outbox: 1,
        source_status: "ACTIVE",
      });
    },
  );

  it("keeps exact record and sign replays available after canonical source archival", async () => {
    const fixture = await seedFixture();
    const bundle = planBundle();
    const recordCommand = recordInput(fixture, bundle);
    const recorded = await recordReconciliationRun(
      fixture.signerActor,
      recordCommand,
      verifierFor(bundle),
    );
    const signCommand = {
      runId: recorded.runId,
      expectedRunVersion: 1,
      approvalReason: "Independent reconciliation review complete",
    };
    await signReconciliationRun(fixture.signerActor, signCommand);
    await archiveCanonicalSource(fixture);

    await expect(
      recordReconciliationRun(
        fixture.signerActor,
        recordCommand,
        verifierFor(bundle),
      ),
    ).resolves.toEqual(recorded);
    await expect(
      signReconciliationRun(fixture.signerActor, signCommand),
    ).resolves.toBeUndefined();
  });

  it("replays terminal historical proof after signer revocation, suspension, and type change", async () => {
    const fixture = await seedFixture();
    const bundle = planBundle();
    const recordCommand = recordInput(fixture, bundle);
    const recorded = await recordReconciliationRun(
      fixture.signerActor,
      recordCommand,
      verifierFor(bundle),
    );
    const signCommand = {
      runId: recorded.runId,
      expectedRunVersion: 1,
      approvalReason: "Independent reconciliation review complete",
    };
    await signReconciliationRun(fixture.signerActor, signCommand);
    await archiveCanonicalSource(fixture);
    await sql`
      delete from membership_roles
      where organization_id = ${fixture.organizationId}
        and membership_id = ${fixture.signerMembershipId}
    `;
    await sql`
      update memberships set status = 'REVOKED'
      where id = ${fixture.signerMembershipId}
    `;
    await sql`
      update users set status = 'SUSPENDED', user_type = 'SERVICE'
      where id = ${fixture.signerActor.userId}
    `;

    await expect(
      recordReconciliationRun(
        fixture.signerActor,
        recordCommand,
        verifierFor(bundle),
      ),
    ).resolves.toEqual(recorded);
    await expect(
      signReconciliationRun(fixture.signerActor, signCommand),
    ).resolves.toBeUndefined();

    const [proof] = await sql<{
      audit_actor_type: string;
      outbox_actor_type: string;
      audits: number;
      outbox: number;
    }[]>`
      select audit.actor_type as audit_actor_type,
             event.actor_type as outbox_actor_type,
             (select count(*)::int from audit_events where target_id = ${recorded.runId}
               and action = 'MIGRATION_RECONCILIATION_RUN_SIGNED') as audits,
             (select count(*)::int from outbox_events where aggregate_id = ${recorded.runId}
               and event_type = 'crm.migration.reconciliation_run_signed') as outbox
      from audit_events audit
      join outbox_events event
        on event.aggregate_id = audit.target_id
       and event.event_type = 'crm.migration.reconciliation_run_signed'
      where audit.target_id = ${recorded.runId}
        and audit.action = 'MIGRATION_RECONCILIATION_RUN_SIGNED'
    `;
    expect(proof).toEqual({
      audit_actor_type: "USER",
      outbox_actor_type: "USER",
      audits: 1,
      outbox: 1,
    });
  });

  it("snapshots SERVICE actor type at initial sign-off and replays it exactly", async () => {
    const fixture = await seedFixture();
    await sql`
      update users set user_type = 'SERVICE'
      where id = ${fixture.signerActor.userId}
    `;
    const { runId } = await recordPassedRun(fixture);
    const input = {
      runId,
      expectedRunVersion: 1,
      approvalReason: "Independent reconciliation review complete",
    };
    await signReconciliationRun(fixture.signerActor, input);
    await sql`
      update users set user_type = 'HUMAN'
      where id = ${fixture.signerActor.userId}
    `;

    await expect(signReconciliationRun(fixture.signerActor, input)).resolves.toBeUndefined();
    const [proof] = await sql<{
      signed_actor_type: string;
      signed_actor_user_id: string;
      audit_actor_type: string;
      outbox_actor_type: string;
    }[]>`
      select run.signed_actor_type, run.signed_actor_user_id,
             audit.actor_type as audit_actor_type, event.actor_type as outbox_actor_type
      from audit_events audit
      join reconciliation_runs run on run.id = audit.target_id
      join outbox_events event
        on event.aggregate_id = audit.target_id
       and event.event_type = 'crm.migration.reconciliation_run_signed'
      where audit.target_id = ${runId}
        and audit.action = 'MIGRATION_RECONCILIATION_RUN_SIGNED'
    `;
    expect(proof).toEqual({
      signed_actor_type: "SERVICE",
      signed_actor_user_id: fixture.signerActor.userId,
      audit_actor_type: "SERVICE",
      outbox_actor_type: "SERVICE",
    });
  });

  it("rejects divergent actor, membership, reason, and version sign replays", async () => {
    const fixture = await seedFixture();
    const { runId } = await recordPassedRun(fixture);
    const approvalReason = "Independent reconciliation review complete";
    await signReconciliationRun(fixture.signerActor, {
      runId,
      expectedRunVersion: 1,
      approvalReason,
    });
    const divergent = [
      {
        actor: fixture.signerAlternateActor,
        expectedRunVersion: 1,
        approvalReason,
      },
      {
        actor: fixture.otherSignerActor,
        expectedRunVersion: 1,
        approvalReason,
      },
      {
        actor: fixture.signerActor,
        expectedRunVersion: 1,
        approvalReason: "Different independent review reason",
      },
      {
        actor: fixture.signerActor,
        expectedRunVersion: 2,
        approvalReason,
      },
    ];
    for (const candidate of divergent) {
      await expect(
        signReconciliationRun(candidate.actor, {
          runId,
          expectedRunVersion: candidate.expectedRunVersion,
          approvalReason: candidate.approvalReason,
        }),
      ).rejects.toMatchObject({
        status: 409,
        code: "RECONCILIATION_SIGN_REPLAY_CONFLICT",
      });
    }
  });

  it("protects signed outbox proof while allowing delivery-only updates and replay", async () => {
    const fixture = await seedFixture();
    const { runId } = await recordPassedRun(fixture);
    const input = {
      runId,
      expectedRunVersion: 1,
      approvalReason: "Independent reconciliation review complete",
    };
    await signReconciliationRun(fixture.signerActor, input);
    await expect(
      sql`
        update outbox_events set payload = payload || ${sql.json({ divergent: true })}
        where aggregate_id = ${runId}
          and event_type = 'crm.migration.reconciliation_run_signed'
      `,
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      sql`
        delete from outbox_events
        where aggregate_id = ${runId}
          and event_type = 'crm.migration.reconciliation_run_signed'
      `,
    ).rejects.toMatchObject({ code: "55000" });
    await sql`
      update outbox_events
      set status = 'PUBLISHED', attempt_count = attempt_count + 1,
          published_at = clock_timestamp(), last_error_code = null
      where aggregate_id = ${runId}
        and event_type = 'crm.migration.reconciliation_run_signed'
    `;

    await expect(signReconciliationRun(fixture.signerActor, input)).resolves.toBeUndefined();
    const [event] = await sql<{ status: string; attempt_count: number; proof_count: number }[]>`
      select status, attempt_count,
             count(*) over ()::int as proof_count
      from outbox_events
      where aggregate_id = ${runId}
        and event_type = 'crm.migration.reconciliation_run_signed'
    `;
    expect(event).toEqual({ status: "PUBLISHED", attempt_count: 1, proof_count: 1 });
  });

  it("converges concurrent identical signers on one lifecycle transition", async () => {
    const fixture = await seedFixture();
    const { runId } = await recordPassedRun(fixture);
    const input = {
      runId,
      expectedRunVersion: 1,
      approvalReason: "Independent reconciliation review complete",
    };
    await Promise.all([
      signReconciliationRun(fixture.signerActor, input),
      signReconciliationRun(fixture.signerActor, input),
    ]);
    const [stored] = await sql<{
      run_status: string;
      batch_status: string;
      audits: number;
      outbox: number;
    }[]>`
      select run.status as run_status, batch.status as batch_status,
             (select count(*)::int from audit_events where target_id = run.id
               and action = 'MIGRATION_RECONCILIATION_RUN_SIGNED') as audits,
             (select count(*)::int from outbox_events where aggregate_id = run.id
               and event_type = 'crm.migration.reconciliation_run_signed') as outbox
      from reconciliation_runs run
      join import_batches batch on batch.id = run.batch_id
      where run.id = ${runId}
    `;
    expect(stored).toEqual({
      run_status: "SIGNED",
      batch_status: "RECONCILED",
      audits: 1,
      outbox: 1,
    });
  });

  it.each(["audit", "outbox"] as const)(
    "rolls back run signature, batch transition, audit, and outbox when the %s effect fails",
    async (kind) => {
      const fixture = await seedFixture();
      const { runId } = await recordPassedRun(fixture);
      const functionName = `crm_test_fail_reconcile_sign_${kind}`;
      const table = kind === "audit" ? "audit_events" : "outbox_events";
      const condition =
        kind === "audit"
          ? "new.action = 'MIGRATION_RECONCILIATION_RUN_SIGNED'"
          : "new.event_type = 'crm.migration.reconciliation_run_signed'";
      await sql.unsafe(`
        create function ${functionName}() returns trigger language plpgsql as $$
        begin
          if ${condition} then raise exception 'synthetic reconciliation sign ${kind} failure'; end if;
          return new;
        end; $$;
        create trigger ${functionName}_trigger before insert on ${table}
        for each row execute function ${functionName}();
      `);
      try {
        await expect(
          signReconciliationRun(fixture.signerActor, {
            runId,
            expectedRunVersion: 1,
            approvalReason: "Independent reconciliation review complete",
          }),
        ).rejects.toMatchObject({ status: 500, code: "RECONCILIATION_SIGN_FAILED" });
      } finally {
        await sql.unsafe(`
          drop trigger if exists ${functionName}_trigger on ${table};
          drop function if exists ${functionName}();
        `);
      }
      const [stored] = await sql<{
        run_status: string;
        run_version: number;
        signer: string | null;
        batch_status: string;
        batch_version: number;
        audits: number;
        outbox: number;
      }[]>`
        select run.status as run_status, run.version::int as run_version,
               run.signed_by_membership_id as signer,
               batch.status as batch_status, batch.version::int as batch_version,
               (select count(*)::int from audit_events where target_id = run.id
                 and action = 'MIGRATION_RECONCILIATION_RUN_SIGNED') as audits,
               (select count(*)::int from outbox_events where aggregate_id = run.id
                 and event_type = 'crm.migration.reconciliation_run_signed') as outbox
        from reconciliation_runs run
        join import_batches batch on batch.id = run.batch_id
        where run.id = ${runId}
      `;
      expect(stored).toEqual({
        run_status: "PASSED",
        run_version: 1,
        signer: null,
        batch_status: "APPLIED",
        batch_version: fixture.batchVersion,
        audits: 0,
        outbox: 0,
      });
    },
  );

  it("returns stable 403 and rolls back when the final capability recheck loses its grant", async () => {
    const fixture = await seedFixture();
    const { runId } = await recordPassedRun(fixture);
    await sql.unsafe(`
      create function crm_test_remove_sign_capability() returns trigger language plpgsql as $$
      begin
        if new.event_type = 'crm.migration.reconciliation_run_signed' then
          delete from membership_roles assignment
          using memberships membership
          where assignment.organization_id = new.organization_id
            and assignment.membership_id = membership.id
            and membership.organization_id = new.organization_id
            and membership.user_id = new.actor_user_id;
        end if;
        return new;
      end; $$;
      create trigger crm_test_remove_sign_capability_trigger
      after insert on outbox_events
      for each row execute function crm_test_remove_sign_capability();
    `);
    try {
      await expect(
        signReconciliationRun(fixture.signerActor, {
          runId,
          expectedRunVersion: 1,
          approvalReason: "Independent reconciliation review complete",
        }),
      ).rejects.toMatchObject({ status: 403, code: "MIGRATION_CAPABILITY_REQUIRED" });
    } finally {
      await sql.unsafe(`
        drop trigger if exists crm_test_remove_sign_capability_trigger on outbox_events;
        drop function if exists crm_test_remove_sign_capability();
      `);
    }
    await expectUnsignedState(fixture, runId);
    const [assignment] = await sql<{ count: number }[]>`
      select count(*)::int as count from membership_roles
      where organization_id = ${fixture.organizationId}
        and membership_id = ${fixture.signerMembershipId}
    `;
    expect(assignment).toEqual({ count: 1 });
  });

  it("maps deferred sign proof divergence to generic 500 and rolls back every effect", async () => {
    const fixture = await seedFixture();
    const { runId } = await recordPassedRun(fixture);
    await sql.unsafe(`
      create function crm_test_diverge_sign_proof() returns trigger language plpgsql as $$
      begin
        if new.event_type = 'crm.migration.reconciliation_run_signed' then
          new.actor_type := 'SYSTEM';
        end if;
        return new;
      end; $$;
      create trigger crm_test_diverge_sign_proof_trigger
      before insert on outbox_events
      for each row execute function crm_test_diverge_sign_proof();
    `);
    try {
      await expect(
        signReconciliationRun(fixture.signerActor, {
          runId,
          expectedRunVersion: 1,
          approvalReason: "Independent reconciliation review complete",
        }),
      ).rejects.toMatchObject({ status: 500, code: "RECONCILIATION_SIGN_FAILED" });
    } finally {
      await sql.unsafe(`
        drop trigger if exists crm_test_diverge_sign_proof_trigger on outbox_events;
        drop function if exists crm_test_diverge_sign_proof();
      `);
    }
    await expectUnsignedState(fixture, runId);
  });

  it("preserves database microseconds across every signed proof timestamp", async () => {
    const fixture = await seedFixture();
    const { runId } = await recordPassedRun(fixture);
    await sql.unsafe(`
      create function crm_test_force_sign_microseconds() returns trigger language plpgsql as $$
      begin
        if new.status = 'SIGNED' and old.status = 'PASSED' then
          new.signed_at := date_trunc('milliseconds', new.signed_at)
            + interval '123 microseconds';
        end if;
        return new;
      end; $$;
      create trigger zzz_crm_test_force_sign_microseconds
      before update on reconciliation_runs
      for each row execute function crm_test_force_sign_microseconds();
    `);
    try {
      await signReconciliationRun(fixture.signerActor, {
        runId,
        expectedRunVersion: 1,
        approvalReason: "Independent reconciliation review complete",
      });
    } finally {
      await sql.unsafe(`
        drop trigger if exists zzz_crm_test_force_sign_microseconds
          on reconciliation_runs;
        drop function if exists crm_test_force_sign_microseconds();
      `);
    }
    const [timestamps] = await sql<{
      signed_at: string;
      audit_occurred_at: string;
      audit_recorded_at: string;
      audit_created_at: string;
      outbox_occurred_at: string;
      outbox_created_at: string;
    }[]>`
      select to_char(run.signed_at, 'YYYY-MM-DD HH24:MI:SS.US') as signed_at,
             to_char(audit.occurred_at, 'YYYY-MM-DD HH24:MI:SS.US') as audit_occurred_at,
             to_char(audit.recorded_at, 'YYYY-MM-DD HH24:MI:SS.US') as audit_recorded_at,
             to_char(audit.created_at, 'YYYY-MM-DD HH24:MI:SS.US') as audit_created_at,
             to_char(event.occurred_at, 'YYYY-MM-DD HH24:MI:SS.US') as outbox_occurred_at,
             to_char(event.created_at, 'YYYY-MM-DD HH24:MI:SS.US') as outbox_created_at
      from reconciliation_runs run
      join audit_events audit on audit.target_id = run.id
        and audit.action = 'MIGRATION_RECONCILIATION_RUN_SIGNED'
      join outbox_events event on event.aggregate_id = run.id
        and event.event_type = 'crm.migration.reconciliation_run_signed'
      where run.id = ${runId}
    `;
    expect(timestamps?.signed_at).toMatch(/123$/);
    expect(timestamps).toEqual({
      signed_at: timestamps?.signed_at,
      audit_occurred_at: timestamps?.signed_at,
      audit_recorded_at: timestamps?.signed_at,
      audit_created_at: timestamps?.signed_at,
      outbox_occurred_at: timestamps?.signed_at,
      outbox_created_at: timestamps?.signed_at,
    });
  });

  it("forces exact-set deferred constraints before committing effects", async () => {
    const fixture = await seedFixture();
    const { runId } = await recordPassedRun(fixture);
    await sql.unsafe(`
      create function crm_test_remove_reconciliation_result() returns trigger language plpgsql as $$
      begin
        if new.status = 'SIGNED' and old.status = 'PASSED' then
          delete from reconciliation_results where run_id = old.id
            and id = (select min(id) from reconciliation_results where run_id = old.id);
        end if;
        return new;
      end; $$;
      create trigger aaa_crm_test_remove_reconciliation_result
      before update on reconciliation_runs
      for each row execute function crm_test_remove_reconciliation_result();
    `);
    try {
      await expect(
        signReconciliationRun(fixture.signerActor, {
          runId,
          expectedRunVersion: 1,
          approvalReason: "Independent reconciliation review complete",
        }),
      ).rejects.toMatchObject({ status: 500, code: "RECONCILIATION_SIGN_FAILED" });
    } finally {
      await sql.unsafe(`
        drop trigger if exists aaa_crm_test_remove_reconciliation_result
          on reconciliation_runs;
        drop function if exists crm_test_remove_reconciliation_result();
      `);
    }
    const [stored] = await sql<{
      run_status: string;
      result_count: number;
      batch_status: string;
      sign_audits: number;
      sign_outbox: number;
    }[]>`
      select run.status as run_status,
             (select count(*)::int from reconciliation_results where run_id = run.id)
               as result_count,
             batch.status as batch_status,
             (select count(*)::int from audit_events where target_id = run.id
               and action = 'MIGRATION_RECONCILIATION_RUN_SIGNED') as sign_audits,
             (select count(*)::int from outbox_events where aggregate_id = run.id
               and event_type = 'crm.migration.reconciliation_run_signed') as sign_outbox
      from reconciliation_runs run
      join import_batches batch on batch.id = run.batch_id
      where run.id = ${runId}
    `;
    expect(stored).toEqual({
      run_status: "PASSED",
      result_count: defaultRequirements.length,
      batch_status: "APPLIED",
      sign_audits: 0,
      sign_outbox: 0,
    });
  });

  it("signs an exact passed set and transitions APPLIED to RECONCILED atomically", async () => {
    const fixture = await seedFixture();
    const { runId } = await recordPassedRun(fixture);
    const approvalReason = "Independent reconciliation review complete";
    await signReconciliationRun(fixture.signerActor, {
      runId,
      expectedRunVersion: 1,
      approvalReason,
    });
    const [stored] = await sql<{
      run_status: string;
      run_version: number;
      signer: string;
      signed_at: Date;
      signed_transaction_id: string;
      signed_actor_user_id: string;
      signed_actor_type: string;
      signed_user_status: string;
      signed_membership_status: string;
      audit_occurred_at: Date;
      audit_recorded_at: Date;
      audit_created_at: Date;
      outbox_occurred_at: Date;
      outbox_created_at: Date;
      batch_status: string;
      batch_version: number;
      audit_reason: string;
      audit_summary: Record<string, unknown>;
      outbox_payload: Record<string, unknown>;
    }[]>`
      select run.status as run_status, run.version::int as run_version,
             run.signed_by_membership_id as signer, run.signed_at,
             run.signed_transaction_id::text as signed_transaction_id,
             run.signed_actor_user_id, run.signed_actor_type,
             run.signed_user_status, run.signed_membership_status,
             batch.status as batch_status, batch.version::int as batch_version,
             audit.reason as audit_reason, audit.change_summary as audit_summary,
             audit.occurred_at as audit_occurred_at,
             audit.recorded_at as audit_recorded_at,
             audit.created_at as audit_created_at,
             event.payload as outbox_payload,
             event.occurred_at as outbox_occurred_at,
             event.created_at as outbox_created_at
      from reconciliation_runs run
      join import_batches batch on batch.id = run.batch_id
      join audit_events audit on audit.target_id = run.id
        and audit.action = 'MIGRATION_RECONCILIATION_RUN_SIGNED'
      join outbox_events event on event.aggregate_id = run.id
        and event.event_type = 'crm.migration.reconciliation_run_signed'
      where run.id = ${runId}
    `;
    if (!stored) throw new Error("Expected signed reconciliation proof to be stored.");
    expect(stored).toMatchObject({
      run_status: "SIGNED",
      run_version: 2,
      signer: fixture.signerMembershipId,
      signed_at: expect.any(Date),
      signed_transaction_id: expect.stringMatching(/^\d+$/),
      signed_actor_user_id: fixture.signerActor.userId,
      signed_actor_type: "USER",
      signed_user_status: "ACTIVE",
      signed_membership_status: "ACTIVE",
      batch_status: "RECONCILED",
      batch_version: 2,
      audit_reason: approvalReason,
      audit_summary: {
        schemaVersion: 1,
        runId,
        batchId: fixture.batchId,
        previousBatchStatus: "APPLIED",
        batchStatus: "RECONCILED",
      },
      outbox_payload: {
        schemaVersion: 1,
        runId,
        batchId: fixture.batchId,
        approvalReason,
      },
    });
    expect(stored.audit_occurred_at).toEqual(stored.signed_at);
    expect(stored.audit_recorded_at).toEqual(stored.signed_at);
    expect(stored.audit_created_at).toEqual(stored.signed_at);
    expect(stored.outbox_occurred_at).toEqual(stored.signed_at);
    expect(stored.outbox_created_at).toEqual(stored.signed_at);
    const [leak] = await sql<{ batch_reason: string | null; run_has_reason: boolean }[]>`
      select batch.approval_reason as batch_reason,
             to_jsonb(run) ? 'approval_reason' as run_has_reason
      from reconciliation_runs run
      join import_batches batch on batch.id = run.batch_id
      where run.id = ${runId}
    `;
    expect(leak).toEqual({
      batch_reason: "Reviewed import approved",
      run_has_reason: false,
    });
  });

  it("makes a signed run and every signed result immutable to direct SQL", async () => {
    const fixture = await seedFixture();
    const { runId } = await recordPassedRun(fixture);
    await signReconciliationRun(fixture.signerActor, {
      runId,
      expectedRunVersion: 1,
      approvalReason: "Independent reconciliation review complete",
    });

    await expect(
      sql`update reconciliation_results set passed = false where run_id = ${runId}`,
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      sql`delete from reconciliation_results where run_id = ${runId}`,
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      sql`
        insert into reconciliation_results (
          organization_id, business_unit_id, run_id, check_kind, check_key, scope_key,
          passed, evidence_metadata
        ) values (
          ${fixture.organizationId}, ${fixture.businessUnitId}, ${runId}, 'SAMPLE',
          'late.sample', 'all', true, ${sql.json({ ruleCode: "LATE" })}
        )
      `,
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      sql`update reconciliation_runs set plan_artifact_ref = ${protectedRef("changed")}
          where id = ${runId}`,
    ).rejects.toMatchObject({ code: "55000" });
    await expect(sql`delete from reconciliation_runs where id = ${runId}`).rejects.toMatchObject({
      code: "55000",
    });

    const [stored] = await sql<{
      run_status: string;
      result_count: number;
      failed_count: number;
      batch_status: string;
    }[]>`
      select run.status as run_status,
             (select count(*)::int from reconciliation_results where run_id = run.id)
               as result_count,
             (select count(*)::int from reconciliation_results where run_id = run.id
               and not passed) as failed_count,
             batch.status as batch_status
      from reconciliation_runs run
      join import_batches batch on batch.id = run.batch_id
      where run.id = ${runId}
    `;
    expect(stored).toEqual({
      run_status: "SIGNED",
      result_count: defaultRequirements.length,
      failed_count: 0,
      batch_status: "RECONCILED",
    });
  });
});

describe("reconciliation database integrity backstops", () => {
  it("rejects membership user reassignment even before the membership is evidence-bound", async () => {
    const fixture = await seedFixture();
    const replacementUserId = randomUUID();
    await sql`
      insert into users (id, auth_subject, display_name, user_type, status)
      values (${replacementUserId}, ${`replacement:${replacementUserId}`},
              'Replacement User', 'HUMAN', 'ACTIVE')
    `;
    const [before] = await sql<{ user_id: string }[]>`
      select user_id from memberships where id = ${fixture.signerMembershipId}
    `;
    await expect(
      sql`
        update memberships set user_id = ${replacementUserId}
        where id = ${fixture.signerMembershipId}
      `,
    ).rejects.toMatchObject({ code: "23514" });
    const [after] = await sql<{ user_id: string }[]>`
      select user_id from memberships where id = ${fixture.signerMembershipId}
    `;
    expect(after).toEqual(before);
  });

  const derivedRequirements = [
    defaultRequirements[0],
    defaultRequirements[1],
    {
      checkKind: "FINANCE_BALANCE",
      checkKey: "balances.finance",
      scopeKey: "global",
      measureUnit: "MYR",
      decimalScale: 2,
    },
    defaultRequirements[2],
  ] as const satisfies readonly ReconciliationRequirement[];

  it.each([
    {
      name: "COUNT mismatch reported as passed",
      mutate: async (runId: string) =>
        sql`update reconciliation_results set target_count = target_count + 1
            where run_id = ${runId} and check_kind = 'COUNT'`,
    },
    {
      name: "COUNT equality reported as failed",
      mutate: async (runId: string) =>
        sql`update reconciliation_results set passed = false
            where run_id = ${runId} and check_kind = 'COUNT'`,
    },
    {
      name: "AMOUNT mismatch reported as passed",
      mutate: async (runId: string) =>
        sql`update reconciliation_results set target_amount = target_amount + 1
            where run_id = ${runId} and check_kind = 'AMOUNT'`,
    },
    {
      name: "AMOUNT equality reported as failed",
      mutate: async (runId: string) =>
        sql`update reconciliation_results set passed = false
            where run_id = ${runId} and check_kind = 'AMOUNT'`,
    },
    {
      name: "FINANCE_BALANCE mismatch reported as passed",
      mutate: async (runId: string) =>
        sql`update reconciliation_results set target_amount = target_amount + 1
            where run_id = ${runId} and check_kind = 'FINANCE_BALANCE'`,
    },
    {
      name: "FINANCE_BALANCE equality reported as failed",
      mutate: async (runId: string) =>
        sql`update reconciliation_results set passed = false
            where run_id = ${runId} and check_kind = 'FINANCE_BALANCE'`,
    },
    {
      name: "CHECKSUM mismatch reported as passed",
      mutate: async (runId: string) =>
        sql`update reconciliation_results set target_checksum = ${sha256("direct-sql-mismatch")}
            where run_id = ${runId} and check_kind = 'CHECKSUM'`,
    },
    {
      name: "CHECKSUM equality reported as failed",
      mutate: async (runId: string) =>
        sql`update reconciliation_results set passed = false
            where run_id = ${runId} and check_kind = 'CHECKSUM'`,
    },
  ])("rejects direct SQL derived-truth corruption: $name", async ({ mutate }) => {
    const fixture = await seedFixture();
    const bundle = planBundle(derivedRequirements);
    const recorded = await recordReconciliationRun(
      fixture.signerActor,
      recordInput(fixture, bundle),
      verifierFor(bundle),
    );
    await expect(mutate(recorded.runId)).rejects.toMatchObject({ code: "23514" });
    const [stored] = await sql<{ failed: number; mismatched: number }[]>`
      select count(*) filter (where not passed)::int as failed,
             count(*) filter (where
               (check_kind = 'COUNT' and source_count is distinct from target_count)
               or (check_kind in ('AMOUNT', 'FINANCE_BALANCE')
                   and source_amount is distinct from target_amount)
               or (check_kind = 'CHECKSUM'
                   and source_checksum is distinct from target_checksum)
             )::int as mismatched
      from reconciliation_results where run_id = ${recorded.runId}
    `;
    expect(stored).toEqual({ failed: 0, mismatched: 0 });
  });

  it.each([
    ["AMOUNT", "NaN", "23514"],
    ["AMOUNT", "Infinity", "22003"],
    ["AMOUNT", "-Infinity", "22003"],
    ["FINANCE_BALANCE", "NaN", "23514"],
    ["FINANCE_BALANCE", "Infinity", "22003"],
    ["FINANCE_BALANCE", "-Infinity", "22003"],
  ] as const)("rejects non-finite direct SQL %s values: %s", async (kind, value, code) => {
    const fixture = await seedFixture();
    const bundle = planBundle(derivedRequirements);
    const recorded = await recordReconciliationRun(
      fixture.signerActor,
      recordInput(fixture, bundle),
      verifierFor(bundle),
    );
    await expect(
      sql`
        update reconciliation_results
        set source_amount = ${value}::numeric, target_amount = ${value}::numeric
        where run_id = ${recorded.runId} and check_kind = ${kind}
      `,
    ).rejects.toMatchObject({ code });
    const [stored] = await sql<{ source_amount: string; target_amount: string }[]>`
      select source_amount, target_amount from reconciliation_results
      where run_id = ${recorded.runId} and check_kind = ${kind}
    `;
    if (!stored) throw new Error("Expected the typed reconciliation result to remain stored.");
    expect(stored.source_amount).not.toMatch(/NaN|Infinity/);
    expect(stored.target_amount).not.toMatch(/NaN|Infinity/);
  });
});

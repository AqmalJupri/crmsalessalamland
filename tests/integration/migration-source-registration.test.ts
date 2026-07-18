import { createHash, randomUUID } from "node:crypto";
import postgres, { type Sql, type TransactionSql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDatabaseConnection } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { resetRuntimeConfigForTests } from "@/server/env";
import { ApiError } from "@/server/http/errors";
import { computeSha256 } from "@/server/migration/artifact-checksum";
import type {
  AuthorityTransitionGroupInput,
  AuthorityTransitionPlanVerifier,
  MigrationActor,
  ReviewedTransformRelease,
  ReviewedTransformReleaseRegistry,
  RegisterMigrationSourceInput,
  RegisterTransformVersionInput,
  SourceArtifactStore,
  VerifiedAuthorityTransitionPlan,
} from "@/server/migration/contracts";
import {
  registerMigrationSource,
  transitionSourceAuthorityGroup,
} from "@/server/migration/register-source";
import { registerTransformVersion } from "@/server/migration/register-transform";
import { seedReconciliationLifecycle } from "./reconciliation-fixture";

const expectedDatabaseName = "crm_salam_codex_migration_platform";
const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) {
  throw new Error("TEST_DATABASE_URL is required for migration source registration tests.");
}

const parsedDatabaseUrl = new URL(databaseUrl);
if (
  parsedDatabaseUrl.protocol !== "postgresql:" ||
  parsedDatabaseUrl.hostname !== "127.0.0.1" ||
  parsedDatabaseUrl.port !== "5432" ||
  parsedDatabaseUrl.pathname.slice(1) !== expectedDatabaseName
) {
  throw new Error(
    `Migration source tests may reset only 127.0.0.1:5432/${expectedDatabaseName}.`,
  );
}

const sql = postgres(databaseUrl, {
  max: 12,
  prepare: false,
  onnotice: () => undefined,
});

type TestSql = Sql | TransactionSql;

const SOURCE_CAPABILITY = "migration.source.manage";
const AUTHORITY_CAPABILITY = "migration.authority_switch";

function sha256(value: string | Uint8Array): Buffer {
  return createHash("sha256").update(value).digest();
}

function protectedRef(label: string): string {
  return `protected://migration-tests/${label}/${randomUUID()}`;
}

const unsafeProtectedReferences = [
  "",
  ".",
  "..",
  "http://bucket.example/artifact",
  "https://bucket.example/artifact",
  "file:///tmp/artifact",
  "/tmp/artifact",
  "../../tmp/artifact",
  "C:\\temp\\artifact",
  "protected://bucket/../artifact",
  "protected://user:password@bucket/artifact",
  "protected://bucket/artifact?token=secret",
  "protected://bucket/artifact#fragment",
  "protected://bucket/%2e%2e/artifact",
  "protected://bucket/TODO",
  "protected://bucket/TBD",
  "protected://bucket/placeholder",
  "protected://bucket/changeme",
  "protected://bucket/example",
  " protected://bucket/artifact",
  "protected://bucket/artifact ",
  "protected://bucket/line\nbreak",
  "protected://bucket/tab\tbreak",
  "protected://bucket/nul\0break",
  "protected://bucket/back\\slash",
  `protected://bucket/${"a".repeat(2_049)}`,
] as const;

async function* chunks(...values: readonly (string | Uint8Array)[]): AsyncIterable<Uint8Array> {
  for (const value of values) {
    yield typeof value === "string" ? Buffer.from(value) : value;
  }
}

function artifactStore(entries: Readonly<Record<string, readonly Uint8Array[]>>): SourceArtifactStore {
  return {
    async *open(ref: string) {
      const stored = entries[ref];
      if (!stored) throw new Error("ARTIFACT_NOT_FOUND");
      for (const value of stored) yield value;
    },
  };
}

function reviewedRelease(input: {
  manifestRef: string;
  mappingArtifactRef: string;
  mappingSha256: Uint8Array;
  sourceSchemaVersion?: string;
  overrides?: Partial<ReviewedTransformRelease>;
}): ReviewedTransformRelease {
  return {
    manifestRef: input.manifestRef,
    manifestSha256: sha256(`manifest:${input.manifestRef}`),
    mappingArtifactRef: input.mappingArtifactRef,
    mappingSha256: input.mappingSha256,
    sourceSchemaVersion: input.sourceSchemaVersion ?? "sales.v1",
    releaseSha256: sha256(`release:${input.manifestRef}`),
    gitCommitSha: "0123456789abcdef0123456789abcdef01234567",
    signatureKeyId: "migration-release-signing-key-v1",
    ...input.overrides,
  };
}

function releaseRegistry(release: ReviewedTransformRelease): ReviewedTransformReleaseRegistry {
  return {
    async getReviewedRelease() {
      return release;
    },
  };
}

interface TenantFixture {
  organizationId: string;
  businessUnitIds: readonly [string, string, string];
  businessUnitMembershipIds: readonly [string, string, string];
  businessUnitUserIds: readonly [string, string, string];
  orgWideMembershipId: string;
  orgWideUserId: string;
  noCapabilityMembershipId: string;
  noCapabilityUserId: string;
  expiredMembershipId: string;
  expiredUserId: string;
  inactiveMembershipId: string;
  inactiveUserId: string;
  sourceActors: readonly [MigrationActor, MigrationActor, MigrationActor];
  authorityActor: MigrationActor;
  noCapabilityActor: MigrationActor;
  expiredActor: MigrationActor;
  inactiveActor: MigrationActor;
}

async function seedTenant(db: TestSql = sql): Promise<TenantFixture> {
  const organizationId = randomUUID();
  const businessUnitIds = [randomUUID(), randomUUID(), randomUUID()] as const;
  const businessUnitUserIds = [randomUUID(), randomUUID(), randomUUID()] as const;
  const businessUnitMembershipIds = [randomUUID(), randomUUID(), randomUUID()] as const;
  const orgWideUserId = randomUUID();
  const orgWideMembershipId = randomUUID();
  const noCapabilityUserId = randomUUID();
  const noCapabilityMembershipId = randomUUID();
  const expiredUserId = randomUUID();
  const expiredMembershipId = randomUUID();
  const inactiveUserId = randomUUID();
  const inactiveMembershipId = randomUUID();

  await db`
    insert into organizations (id, code, name)
    values (${organizationId}, ${`org-${organizationId}`}, 'Migration Test Organisation')
  `;
  await db`
    insert into business_units (id, organization_id, code, name)
    values
      (${businessUnitIds[0]}, ${organizationId}, ${`salam-${organizationId}`}, 'Salam Land'),
      (${businessUnitIds[1]}, ${organizationId}, ${`bumi-${organizationId}`}, 'Bumi Hayat Printing'),
      (${businessUnitIds[2]}, ${organizationId}, ${`barakah-${organizationId}`}, 'Barakah Emas')
  `;
  await db`
    insert into users (id, auth_subject, display_name, user_type, status)
    values
      (${businessUnitUserIds[0]}, ${`test:${businessUnitUserIds[0]}`}, 'Salam Migration Manager', 'HUMAN', 'ACTIVE'),
      (${businessUnitUserIds[1]}, ${`test:${businessUnitUserIds[1]}`}, 'Bumi Migration Manager', 'HUMAN', 'ACTIVE'),
      (${businessUnitUserIds[2]}, ${`test:${businessUnitUserIds[2]}`}, 'Barakah Migration Manager', 'HUMAN', 'ACTIVE'),
      (${orgWideUserId}, ${`test:${orgWideUserId}`}, 'Migration Switcher', 'HUMAN', 'ACTIVE'),
      (${noCapabilityUserId}, ${`test:${noCapabilityUserId}`}, 'No Capability', 'HUMAN', 'ACTIVE'),
      (${expiredUserId}, ${`test:${expiredUserId}`}, 'Expired Manager', 'HUMAN', 'ACTIVE'),
      (${inactiveUserId}, ${`test:${inactiveUserId}`}, 'Inactive Manager', 'HUMAN', 'SUSPENDED')
  `;
  await db`
    insert into memberships (
      id, organization_id, business_unit_id, user_id, status, valid_from, valid_until
    ) values
      (${businessUnitMembershipIds[0]}, ${organizationId}, ${businessUnitIds[0]}, ${businessUnitUserIds[0]}, 'ACTIVE', clock_timestamp() - interval '1 day', null),
      (${businessUnitMembershipIds[1]}, ${organizationId}, ${businessUnitIds[1]}, ${businessUnitUserIds[1]}, 'ACTIVE', clock_timestamp() - interval '1 day', null),
      (${businessUnitMembershipIds[2]}, ${organizationId}, ${businessUnitIds[2]}, ${businessUnitUserIds[2]}, 'ACTIVE', clock_timestamp() - interval '1 day', null),
      (${orgWideMembershipId}, ${organizationId}, null, ${orgWideUserId}, 'ACTIVE', clock_timestamp() - interval '1 day', null),
      (${noCapabilityMembershipId}, ${organizationId}, ${businessUnitIds[0]}, ${noCapabilityUserId}, 'ACTIVE', clock_timestamp() - interval '1 day', null),
      (${expiredMembershipId}, ${organizationId}, ${businessUnitIds[0]}, ${expiredUserId}, 'ACTIVE', clock_timestamp() - interval '2 days', clock_timestamp() - interval '1 day'),
      (${inactiveMembershipId}, ${organizationId}, ${businessUnitIds[0]}, ${inactiveUserId}, 'ACTIVE', clock_timestamp() - interval '1 day', null)
  `;

  const roleIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()] as const;
  await db`
    insert into roles (id, organization_id, key, name, status)
    values
      (${roleIds[0]}, ${organizationId}, 'migration-source-salam', 'Migration Source Salam', 'ACTIVE'),
      (${roleIds[1]}, ${organizationId}, 'migration-source-bumi', 'Migration Source Bumi', 'ACTIVE'),
      (${roleIds[2]}, ${organizationId}, 'migration-source-barakah', 'Migration Source Barakah', 'ACTIVE'),
      (${roleIds[3]}, ${organizationId}, 'migration-authority-switcher', 'Migration Authority Switcher', 'ACTIVE')
  `;
  await db`
    insert into role_capabilities (organization_id, role_id, capability_key)
    values
      (${organizationId}, ${roleIds[0]}, ${SOURCE_CAPABILITY}),
      (${organizationId}, ${roleIds[1]}, ${SOURCE_CAPABILITY}),
      (${organizationId}, ${roleIds[2]}, ${SOURCE_CAPABILITY}),
      (${organizationId}, ${roleIds[3]}, ${SOURCE_CAPABILITY}),
      (${organizationId}, ${roleIds[3]}, ${AUTHORITY_CAPABILITY})
  `;
  await db`
    insert into membership_roles (organization_id, membership_id, role_id, valid_from)
    values
      (${organizationId}, ${businessUnitMembershipIds[0]}, ${roleIds[0]}, clock_timestamp() - interval '1 day'),
      (${organizationId}, ${businessUnitMembershipIds[1]}, ${roleIds[1]}, clock_timestamp() - interval '1 day'),
      (${organizationId}, ${businessUnitMembershipIds[2]}, ${roleIds[2]}, clock_timestamp() - interval '1 day'),
      (${organizationId}, ${orgWideMembershipId}, ${roleIds[3]}, clock_timestamp() - interval '1 day'),
      (${organizationId}, ${expiredMembershipId}, ${roleIds[0]}, clock_timestamp() - interval '2 days'),
      (${organizationId}, ${inactiveMembershipId}, ${roleIds[0]}, clock_timestamp() - interval '1 day')
  `;

  const sourceActors = businessUnitIds.map((businessUnitId, index) => ({
    userId: businessUnitUserIds[index]!,
    organizationId,
    activeMembershipId: businessUnitMembershipIds[index]!,
    businessUnitId,
    capabilities: [SOURCE_CAPABILITY],
  })) as unknown as readonly [MigrationActor, MigrationActor, MigrationActor];

  return {
    organizationId,
    businessUnitIds,
    businessUnitMembershipIds,
    businessUnitUserIds,
    orgWideMembershipId,
    orgWideUserId,
    noCapabilityMembershipId,
    noCapabilityUserId,
    expiredMembershipId,
    expiredUserId,
    inactiveMembershipId,
    inactiveUserId,
    sourceActors,
    authorityActor: {
      userId: orgWideUserId,
      organizationId,
      activeMembershipId: orgWideMembershipId,
      businessUnitId: businessUnitIds[0],
      capabilities: [SOURCE_CAPABILITY, AUTHORITY_CAPABILITY],
    },
    noCapabilityActor: {
      userId: noCapabilityUserId,
      organizationId,
      activeMembershipId: noCapabilityMembershipId,
      businessUnitId: businessUnitIds[0],
      capabilities: [SOURCE_CAPABILITY, AUTHORITY_CAPABILITY],
    },
    expiredActor: {
      userId: expiredUserId,
      organizationId,
      activeMembershipId: expiredMembershipId,
      businessUnitId: businessUnitIds[0],
      capabilities: [SOURCE_CAPABILITY],
    },
    inactiveActor: {
      userId: inactiveUserId,
      organizationId,
      activeMembershipId: inactiveMembershipId,
      businessUnitId: businessUnitIds[0],
      capabilities: [SOURCE_CAPABILITY],
    },
  };
}

interface DirectSourceFixture {
  sourceId: string;
  scopeId: string;
  authorityId: string;
  transformId: string;
  domainKey: string;
  businessUnitId: string;
  cutoffAt: Date;
  finalBatchId: string;
}

async function insertApprovedTransform(
  db: TestSql,
  tenant: TenantFixture,
  businessUnitIndex: number,
  sourceId: string,
): Promise<string> {
  const transformId = randomUUID();
  await db`
    insert into transform_versions (
      id, organization_id, business_unit_id, migration_source_id, version_no,
      source_schema_version, mapping_artifact_ref, mapping_sha256,
      release_manifest_ref, release_manifest_sha256, transform_release_sha256,
      rationale, approved_by_membership_id, approved_at
    ) values (
      ${transformId}, ${tenant.organizationId}, ${tenant.businessUnitIds[businessUnitIndex]!},
      ${sourceId}, 1, 'sales.v1', ${protectedRef("mapping")}, ${sha256(`mapping:${transformId}`)},
      ${protectedRef("release")}, ${sha256(`manifest:${transformId}`)},
      ${sha256(`release:${transformId}`)}, 'Reviewed synthetic transform',
      ${tenant.businessUnitMembershipIds[businessUnitIndex]!}, clock_timestamp()
    )
  `;
  return transformId;
}

async function insertReconciledBatch(
  db: Sql,
  tenant: TenantFixture,
  businessUnitIndex: number,
  sourceId: string,
  transformId: string,
  options: {
    cutoffAt?: Date;
    signed?: boolean;
    unsignedPassedRun?: boolean;
    checksumLabel?: string;
    status?: "APPLIED" | "RECONCILED";
  } = {},
): Promise<{ finalBatchId: string; cutoffAt: Date }> {
  const businessUnitId = tenant.businessUnitIds[businessUnitIndex]!;
  const membershipId = tenant.businessUnitMembershipIds[businessUnitIndex]!;
  const cutoffAt = options.cutoffAt ?? new Date(Date.now() - 30_000);
  const capturedAt = new Date(cutoffAt.getTime() + 1_000);
  const sourceDigest = sha256(options.checksumLabel ?? randomUUID());
  const dryRunId = randomUUID();
  const finalBatchId = randomUUID();
  const terminalStatus = options.status ?? "RECONCILED";

  await db`
    insert into import_batches (
      id, organization_id, business_unit_id, migration_source_id, transform_version_id,
      protected_artifact_ref, source_sha256, size_bytes, captured_at, cutoff_at,
      schema_version, status, dry_run, total_row_count, valid_row_count,
      validated_by_membership_id, validated_at
    ) values (
      ${dryRunId}, ${tenant.organizationId}, ${businessUnitId}, ${sourceId}, ${transformId},
      ${protectedRef("dry-run")}, ${sourceDigest}, 1, ${capturedAt}, ${cutoffAt},
      'sales.v1', 'DRY_RUN_COMPLETE', true, 1, 1,
      ${membershipId}, clock_timestamp()
    )
  `;
  await db`
    insert into import_batches (
      id, organization_id, business_unit_id, migration_source_id, transform_version_id,
      validated_dry_run_batch_id, protected_artifact_ref, source_sha256, size_bytes,
      captured_at, cutoff_at, schema_version, status, dry_run,
      total_row_count, imported_row_count, approved_row_count,
      validated_by_membership_id, validated_at, approved_by_membership_id,
      approved_at, approval_mode, approval_reason, applied_by_membership_id,
      apply_run_id, apply_lease_expires_at, apply_started_at, applied_at
    ) values (
      ${finalBatchId}, ${tenant.organizationId}, ${businessUnitId}, ${sourceId}, ${transformId},
      ${dryRunId}, ${protectedRef("final-live")}, ${sourceDigest}, 1,
      ${capturedAt}, ${cutoffAt}, 'sales.v1', 'APPLIED', false,
      1, 1, 1, ${membershipId}, clock_timestamp(), ${membershipId},
      clock_timestamp(), 'FULL', 'Reviewed full migration', ${membershipId},
      ${randomUUID()}, clock_timestamp() + interval '5 minutes', clock_timestamp(),
      clock_timestamp()
    )
  `;

  if (
    terminalStatus === "RECONCILED" &&
    (options.signed !== false || options.unsignedPassedRun === true)
  ) {
    await seedReconciliationLifecycle(db, {
      organizationId: tenant.organizationId,
      businessUnitId,
      batchId: finalBatchId,
      signed: options.signed !== false,
    });
  }

  return { finalBatchId, cutoffAt };
}

async function insertDirectShadowSource(
  tenant: TenantFixture,
  businessUnitIndex: number,
  options: {
    domainKey?: string;
    signed?: boolean;
    unsignedPassedRun?: boolean;
    cutoffAt?: Date;
    sourceKind?: "SALAM_CRM_JSON" | "TASHA_SQLITE" | "NIAGAWAN_CSV" | "BARAKAH_SHEET";
    sourceMode?: "ONE_TIME_MIGRATION" | "RECURRING_READ_ONLY_SNAPSHOT";
  } = {},
): Promise<DirectSourceFixture> {
  const sourceId = randomUUID();
  const scopeId = randomUUID();
  const authorityId = randomUUID();
  const businessUnitId = tenant.businessUnitIds[businessUnitIndex]!;
  const domainKey = options.domainKey ?? `sales.domain_${businessUnitIndex}`;
  const sourceMode = options.sourceMode ?? "ONE_TIME_MIGRATION";
  await sql`
    insert into migration_sources (
      id, organization_id, business_unit_id, source_key, source_kind, source_mode,
      owner_membership_id, status
    ) values (
      ${sourceId}, ${tenant.organizationId}, ${businessUnitId}, ${`source-${sourceId}`},
      ${options.sourceKind ?? "SALAM_CRM_JSON"}, ${sourceMode},
      ${tenant.businessUnitMembershipIds[businessUnitIndex]!}, 'ACTIVE'
    )
  `;
  await sql`
    insert into migration_source_scopes (
      id, organization_id, business_unit_id, migration_source_id, domain_key,
      canonical_target, transition_mode, source_status
    ) values (
      ${scopeId}, ${tenant.organizationId}, ${businessUnitId}, ${sourceId},
      ${domainKey}, 'crm.canonical',
      ${sourceMode === "ONE_TIME_MIGRATION" ? "ONE_TIME_CUTOVER" : "RECURRING_EXTERNAL_SNAPSHOT"},
      'ACTIVE_AUTHORITY'
    )
  `;
  await sql`
    insert into migration_domain_authorities (
      id, organization_id, business_unit_id, domain_key, canonical_target,
      authority_state, authority_source_scope_id
    ) values (
      ${authorityId}, ${tenant.organizationId}, ${businessUnitId}, ${domainKey},
      'crm.canonical', 'SHADOW_READ', ${scopeId}
    )
  `;
  const transformId = await insertApprovedTransform(sql, tenant, businessUnitIndex, sourceId);
  const batch = await insertReconciledBatch(
    sql,
    tenant,
    businessUnitIndex,
    sourceId,
    transformId,
    {
      ...(options.cutoffAt ? { cutoffAt: options.cutoffAt } : {}),
      ...(options.signed === undefined ? {} : { signed: options.signed }),
      ...(options.unsignedPassedRun === undefined
        ? {}
        : { unsignedPassedRun: options.unsignedPassedRun }),
    },
  );
  return {
    sourceId,
    scopeId,
    authorityId,
    transformId,
    domainKey,
    businessUnitId,
    cutoffAt: batch.cutoffAt,
    finalBatchId: batch.finalBatchId,
  };
}

interface CutoverFixture {
  tenant: TenantFixture;
  sources: readonly [DirectSourceFixture, DirectSourceFixture, DirectSourceFixture];
  input: AuthorityTransitionGroupInput;
  plan: VerifiedAuthorityTransitionPlan;
  verifier: AuthorityTransitionPlanVerifier;
}

function verifierFor(plan: VerifiedAuthorityTransitionPlan): AuthorityTransitionPlanVerifier {
  return {
    async verify() {
      return plan;
    },
  };
}

function canonicalGroupDigest(
  organizationId: string,
  input: AuthorityTransitionGroupInput,
): Buffer {
  const members = [...input.members]
    .sort((left, right) =>
      left.domainAuthorityId < right.domainAuthorityId
        ? -1
        : left.domainAuthorityId > right.domainAuthorityId
          ? 1
          : 0,
    )
    .map((member) => ({
      domainAuthorityId: member.domainAuthorityId,
      toState: member.toState,
      writeFrozenAt: member.writeFrozenAt?.toISOString() ?? null,
      finalBatchId: member.finalBatchId,
      expectedVersion: member.expectedVersion,
    }));
  return sha256(
    JSON.stringify({
      organizationId,
      cutoverGroupId: input.cutoverGroupId,
      idempotencyKey: input.idempotencyKey,
      planArtifactRef: input.planArtifactRef,
      planSha256Hex: Buffer.from(input.expectedPlanSha256).toString("hex"),
      approvalReason: input.approvalReason.trim(),
      members,
    }),
  );
}

async function authorityMutationSnapshot(organizationId: string): Promise<unknown> {
  const [snapshot] = await sql<{
    heads: unknown;
    scopes: unknown;
    sources: unknown;
    groups: unknown;
    transitions: unknown;
    audits: unknown;
    outbox: unknown;
  }[]>`
    select
      (select coalesce(jsonb_agg(to_jsonb(row_data) order by row_data.id), '[]'::jsonb)
       from (
         select id, authority_state, authority_source_scope_id, version, updated_at
         from migration_domain_authorities
         where organization_id = ${organizationId}
       ) row_data) as heads,
      (select coalesce(jsonb_agg(to_jsonb(row_data) order by row_data.id), '[]'::jsonb)
       from (
         select id, source_status, version, updated_at
         from migration_source_scopes
         where organization_id = ${organizationId}
       ) row_data) as scopes,
      (select coalesce(jsonb_agg(to_jsonb(row_data) order by row_data.id), '[]'::jsonb)
       from (
         select id, status, version, updated_at
         from migration_sources
         where organization_id = ${organizationId}
       ) row_data) as sources,
      (select coalesce(jsonb_agg(to_jsonb(row_data) order by row_data.id), '[]'::jsonb)
       from (
         select id, idempotency_key, group_size, encode(group_sha256, 'hex') as group_sha256,
                effective_at, approved_by_membership_id, approval_reason, created_at
         from source_authority_transition_groups
         where organization_id = ${organizationId}
       ) row_data) as groups,
      (select coalesce(jsonb_agg(to_jsonb(row_data) order by row_data.id), '[]'::jsonb)
       from (
         select id, transition_group_id, domain_authority_id, from_state, to_state,
                write_frozen_at, final_batch_id, final_cutoff_at, created_at
         from source_authority_transitions
         where organization_id = ${organizationId}
       ) row_data) as transitions,
      (select coalesce(jsonb_agg(to_jsonb(row_data) order by row_data.id), '[]'::jsonb)
       from (
         select id, actor_type, actor_user_id, action, target_id, correlation_id,
                change_summary, occurred_at, recorded_at, created_at
         from audit_events
         where organization_id = ${organizationId}
           and action = 'MIGRATION_AUTHORITY_SWITCHED'
       ) row_data) as audits,
      (select coalesce(jsonb_agg(to_jsonb(row_data) order by row_data.id), '[]'::jsonb)
       from (
         select id, event_type, event_version, aggregate_id, actor_type,
                actor_user_id, correlation_id, payload, status, version,
                occurred_at, created_at, updated_at
         from outbox_events
         where organization_id = ${organizationId}
           and event_type = 'crm.migration.authority_switched'
       ) row_data) as outbox
  `;
  return snapshot;
}

function syntheticGroupContract(): {
  actor: MigrationActor;
  input: AuthorityTransitionGroupInput;
  plan: VerifiedAuthorityTransitionPlan;
} {
  const organizationId = randomUUID();
  const businessUnitIds = [randomUUID(), randomUUID(), randomUUID()];
  const planArtifactRef = protectedRef("synthetic-cutover-plan");
  const planSha256 = sha256(planArtifactRef);
  const cutoffAt = new Date(Date.now() - 30_000);
  const authorities = businessUnitIds.map(() => randomUUID());
  const batches = businessUnitIds.map(() => randomUUID());
  const members = authorities.map((domainAuthorityId, index) => ({
    domainAuthorityId,
    toState: "CANONICAL_WRITABLE" as const,
    writeFrozenAt: new Date(cutoffAt.getTime() - 1_000),
    finalBatchId: batches[index]!,
    expectedVersion: 1,
  }));
  return {
    actor: {
      userId: randomUUID(),
      organizationId,
      activeMembershipId: randomUUID(),
      businessUnitId: businessUnitIds[0]!,
      capabilities: [SOURCE_CAPABILITY, AUTHORITY_CAPABILITY],
    },
    input: {
      cutoverGroupId: randomUUID(),
      planArtifactRef,
      expectedPlanSha256: planSha256,
      members,
      approvalReason: "Synthetic reviewed cutover",
      idempotencyKey: `synthetic-${randomUUID()}`,
    },
    plan: {
      artifactRef: planArtifactRef,
      planSha256,
      organizationId,
      notBefore: new Date(Date.now() - 60_000),
      expiresAt: new Date(Date.now() + 60_000),
      requiredMembers: members.map((member, index) => ({
        businessUnitId: businessUnitIds[index]!,
        domainAuthorityId: member.domainAuthorityId,
        domainKey: `sales.domain_${index}`,
        toState: member.toState,
        writeFrozenAt: member.writeFrozenAt,
        finalBatchId: member.finalBatchId,
      })),
    },
  };
}

async function seedCutoverFixture(options: {
  signedIndex?: number;
  unsignedPassedIndex?: number;
  notBefore?: Date;
  expiresAt?: Date;
  cutoffAt?: Date;
  sourceModes?: readonly (
    | "ONE_TIME_MIGRATION"
    | "RECURRING_READ_ONLY_SNAPSHOT"
  )[];
  sourceKinds?: readonly (
    | "SALAM_CRM_JSON"
    | "TASHA_SQLITE"
    | "NIAGAWAN_CSV"
    | "BARAKAH_SHEET"
  )[];
} = {}): Promise<CutoverFixture> {
  const tenant = await seedTenant();
  const sources = (await Promise.all(
    [0, 1, 2].map((index) =>
      insertDirectShadowSource(tenant, index, {
        signed: options.signedIndex === index ? false : true,
        unsignedPassedRun: options.unsignedPassedIndex === index,
        cutoffAt: options.cutoffAt ?? new Date(Date.now() - 30_000),
        ...(options.sourceModes?.[index]
          ? { sourceMode: options.sourceModes[index] }
          : {}),
        ...(options.sourceKinds?.[index]
          ? { sourceKind: options.sourceKinds[index] }
          : {}),
      }),
    ),
  )) as unknown as readonly [DirectSourceFixture, DirectSourceFixture, DirectSourceFixture];
  const planArtifactRef = protectedRef("cutover-plan");
  const planSha256 = sha256(`cutover-plan:${planArtifactRef}`);
  const input: AuthorityTransitionGroupInput = {
    cutoverGroupId: randomUUID(),
    planArtifactRef,
    expectedPlanSha256: planSha256,
    members: [...sources]
      .reverse()
      .map((source) => ({
        domainAuthorityId: source.authorityId,
        toState: "CANONICAL_WRITABLE" as const,
        writeFrozenAt: new Date(source.cutoffAt.getTime() - 1_000),
        finalBatchId: source.finalBatchId,
        expectedVersion: 1,
      })),
    approvalReason: "Reviewed coordinated production cutover",
    idempotencyKey: `cutover-${randomUUID()}`,
  };
  const plan: VerifiedAuthorityTransitionPlan = {
    artifactRef: planArtifactRef,
    planSha256,
    organizationId: tenant.organizationId,
    notBefore: options.notBefore ?? new Date(Date.now() - 60_000),
    expiresAt: options.expiresAt ?? new Date(Date.now() + 60_000),
    requiredMembers: sources.map((source) => {
      const member = input.members.find(
        (candidate) => candidate.domainAuthorityId === source.authorityId,
      )!;
      return {
        businessUnitId: source.businessUnitId,
        domainAuthorityId: source.authorityId,
        domainKey: source.domainKey,
        toState: member.toState,
        writeFrozenAt: member.writeFrozenAt,
        finalBatchId: member.finalBatchId,
      };
    }),
  };
  return { tenant, sources, input, plan, verifier: verifierFor(plan) };
}

async function insertLaterUnresolvedBatch(
  tenant: TenantFixture,
  source: DirectSourceFixture,
  cutoffAt = new Date(Date.now() - 5_000),
  db: TestSql = sql,
  status: "REGISTERED" | "STAGED" | "VALIDATED" | "APPROVED" | "APPLYING" = "REGISTERED",
): Promise<string> {
  const digest = sha256(randomUUID());
  const dryRunId = randomUUID();
  const liveBatchId = randomUUID();
  const membershipId = tenant.businessUnitMembershipIds[
    tenant.businessUnitIds.indexOf(source.businessUnitId)
  ]!;
  const capturedAt = new Date(cutoffAt.getTime() + 1_000);
  const staged = status === "STAGED";
  const validated = ["VALIDATED", "APPROVED", "APPLYING"].includes(status);
  const approved = ["APPROVED", "APPLYING"].includes(status);
  const applying = status === "APPLYING";
  await db`
    insert into import_batches (
      id, organization_id, business_unit_id, migration_source_id, transform_version_id,
      protected_artifact_ref, source_sha256, size_bytes, captured_at, cutoff_at,
      schema_version, status, dry_run, validated_by_membership_id, validated_at
    ) values (
      ${dryRunId}, ${tenant.organizationId}, ${source.businessUnitId}, ${source.sourceId},
      ${source.transformId}, ${protectedRef("later-dry")}, ${digest}, 0,
      ${capturedAt}, ${cutoffAt}, 'sales.v1', 'DRY_RUN_COMPLETE', true,
      ${membershipId}, clock_timestamp()
    )
  `;
  await db`
    insert into import_batches (
      id, organization_id, business_unit_id, migration_source_id, transform_version_id,
      validated_dry_run_batch_id, protected_artifact_ref, source_sha256, size_bytes,
      captured_at, cutoff_at, schema_version, status, dry_run,
      total_row_count, staged_row_count, valid_row_count,
      validated_by_membership_id, validated_at, approval_mode,
      approved_row_count, approved_by_membership_id, approved_at, approval_reason,
      applied_by_membership_id, apply_run_id, apply_started_at, apply_lease_expires_at
    ) values (
      ${liveBatchId}, ${tenant.organizationId}, ${source.businessUnitId}, ${source.sourceId},
      ${source.transformId}, ${dryRunId}, ${protectedRef("later-live")}, ${digest}, 0,
      ${capturedAt}, ${cutoffAt}, 'sales.v1', ${status}, false,
      ${status === "REGISTERED" ? 0 : 1}, ${staged ? 1 : 0}, ${validated ? 1 : 0},
      ${validated ? membershipId : null}, ${validated ? capturedAt : null},
      ${approved ? "FULL" : null}, ${approved ? 1 : 0},
      ${approved ? membershipId : null}, ${approved ? capturedAt : null},
      ${approved ? "Reviewed later delta" : null},
      ${applying ? membershipId : null}, ${applying ? randomUUID() : null},
      ${applying ? capturedAt : null},
      ${applying ? new Date(capturedAt.getTime() + 60_000) : null}
    )
  `;
  return liveBatchId;
}

function validSourceInput(
  tenant: TenantFixture,
  businessUnitIndex = 0,
  domainKey?: string,
): RegisterMigrationSourceInput {
  return {
    businessUnitId: tenant.businessUnitIds[businessUnitIndex]!,
    sourceKey: `source_${randomUUID()}`,
    sourceKind: "SALAM_CRM_JSON" as const,
    sourceMode: "ONE_TIME_MIGRATION" as const,
    ownerMembershipId: tenant.businessUnitMembershipIds[businessUnitIndex]!,
    domains: [
      {
        domainKey: domainKey ?? `sales.leads_${randomUUID().replaceAll("-", "_")}`,
        canonicalTarget: "crm.canonical",
        transitionMode: "ONE_TIME_CUTOVER" as const,
        initialAuthorityState: "LEGACY_WRITABLE" as const,
      },
    ],
  };
}

async function seedTransformRegistrationFixture() {
  const tenant = await seedTenant();
  const sourceInput = validSourceInput(tenant);
  const sourceId = await registerMigrationSource(tenant.sourceActors[0], sourceInput);
  const mappingArtifactRef = protectedRef("reviewed-mapping");
  const releaseManifestRef = protectedRef("reviewed-release");
  const mappingChunks = [Buffer.from("reviewed "), Buffer.from("mapping\n")];
  const mappingSha256 = sha256(Buffer.concat(mappingChunks));
  const release = reviewedRelease({
    manifestRef: releaseManifestRef,
    mappingArtifactRef,
    mappingSha256,
  });
  const input = {
    businessUnitId: tenant.businessUnitIds[0],
    migrationSourceId: sourceId,
    versionNo: 1,
    sourceSchemaVersion: release.sourceSchemaVersion,
    mappingArtifactRef,
    expectedMappingSha256: mappingSha256,
    releaseManifestRef,
    expectedReleaseManifestSha256: release.manifestSha256,
    expectedReleaseSha256: release.releaseSha256,
    rationale: "Reviewed source-to-canonical mapping",
    repairOfTransformId: null,
  };
  return {
    tenant,
    sourceId,
    sourceInput,
    mappingChunks,
    mappingSha256,
    release,
    input,
    store: artifactStore({ [mappingArtifactRef]: mappingChunks }),
    registry: releaseRegistry(release),
  };
}

async function waitUntilBlockedBy(blockerPid: number): Promise<number> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const [row] = await sql<{ pid: number }[]>`
      select activity.pid
      from pg_stat_activity activity
      where activity.datname = ${expectedDatabaseName}
        and activity.pid <> pg_backend_pid()
        and ${blockerPid} = any(pg_blocking_pids(activity.pid))
      order by activity.pid
      limit 1
    `;
    if (row) return row.pid;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Expected a backend to block behind PID ${blockerPid}.`);
}

async function waitUntilBackendBlockedBy(
  backendPid: number,
  blockerPid: number,
): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const [row] = await sql<{ blocked: boolean }[]>`
      select ${blockerPid} = any(pg_blocking_pids(${backendPid})) as blocked
    `;
    if (row?.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Expected backend ${backendPid} to block behind PID ${blockerPid}.`);
}

beforeAll(async () => {
  process.env = {
    ...process.env,
    NODE_ENV: "test",
    PRODUCT_SURFACE: "crm",
    DEPLOYMENT_ENVIRONMENT: "local",
    DATABASE_URL: databaseUrl,
    DATABASE_POOL_MAX: "10",
    APP_URL: "http://127.0.0.1:3000",
    CRM_DEMO_MODE: "false",
    AUTH_HASH_KEY: "migration-tests-auth-hash-key-at-least-32-characters",
    OIDC_ISSUER: "https://identity.example.test",
    OIDC_CLIENT_ID: "migration-integration",
    OIDC_CLIENT_SECRET: "migration-integration-client-secret",
    OIDC_REDIRECT_URI: "http://127.0.0.1:3000/api/v1/auth/oidc/callback",
  };
  resetRuntimeConfigForTests();
  await sql.unsafe("drop schema if exists public cascade; create schema public");
  await runMigrations(databaseUrl);
  await sql`
    insert into capabilities (key, description, risk_level)
    values
      (${SOURCE_CAPABILITY}, 'Manage reviewed migration sources', 'SENSITIVE'),
      (${AUTHORITY_CAPABILITY}, 'Switch durable migration authority', 'PRIVILEGED')
  `;
});

afterAll(async () => {
  await closeDatabaseConnection();
  await sql.unsafe("drop schema if exists public cascade; create schema public");
  await sql.end();
  resetRuntimeConfigForTests();
});

describe("protected migration artifacts", () => {
  it("streams a checksum and exact bigint size without requiring one buffered value", async () => {
    const values = [Buffer.from("salam"), Buffer.alloc(65_537, 7), Buffer.from("land")];
    const expected = sha256(Buffer.concat(values));

    const result = await computeSha256(chunks(...values));

    expect(Buffer.from(result.sha256)).toEqual(expected);
    expect(result.sizeBytes).toBe(65_546n);
    expect(typeof result.sizeBytes).toBe("bigint");
  });

  it("hashes an empty stream deterministically for generic source-artifact callers", async () => {
    const result = await computeSha256(chunks());
    expect(Buffer.from(result.sha256)).toEqual(sha256(Buffer.alloc(0)));
    expect(result.sizeBytes).toBe(0n);
  });

  it("rejects malformed runtime chunks with a stable application error", async () => {
    async function* malformed() {
      yield "not-bytes" as unknown as Uint8Array;
    }

    await expect(computeSha256(malformed())).rejects.toMatchObject({
      code: "ARTIFACT_CHUNK_INVALID",
      status: 422,
    });
  });

  it("consumes many reused chunks incrementally instead of retaining mutable chunk references", async () => {
    const mutable = new Uint8Array(1);
    const expected = createHash("sha256");
    async function* manyChunks() {
      for (let index = 0; index < 10_000; index += 1) {
        mutable[0] = index % 251;
        expected.update(Uint8Array.of(mutable[0]));
        yield mutable;
      }
    }

    const result = await computeSha256(manyChunks());

    expect(Buffer.from(result.sha256)).toEqual(expected.digest());
    expect(result.sizeBytes).toBe(10_000n);
  });

  it("sanitizes a source-stream read failure without producing a partial digest", async () => {
    const providerDetail = "SYNTHETIC_STREAM_PROVIDER_SECRET_DETAIL";
    async function* failingStream() {
      yield Buffer.from("partial");
      throw new Error(providerDetail);
    }
    let error: unknown;
    try {
      await computeSha256(failingStream());
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "ARTIFACT_READ_FAILED", status: 422 });
    expect(String(error)).not.toContain(providerDetail);
  });

  it("sanitizes an ApiError thrown by an untrusted source-stream provider", async () => {
    const providerDetail = "SYNTHETIC_PROVIDER_API_ERROR_SECRET";
    async function* failingStream() {
      throw new ApiError(418, "PROVIDER_PRIVATE_FAILURE", providerDetail);
    }
    let error: unknown;
    try {
      await computeSha256(failingStream());
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "ARTIFACT_READ_FAILED", status: 422 });
    expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain(providerDetail);
    expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain(
      "PROVIDER_PRIVATE_FAILURE",
    );
  });
});

describe("migration source registration", () => {
  it("rejects malformed source commands before any tenant database lookup", async () => {
    const organizationId = randomUUID();
    const businessUnitId = randomUUID();
    const actor: MigrationActor = {
      userId: randomUUID(),
      organizationId,
      activeMembershipId: randomUUID(),
      businessUnitId,
      capabilities: [SOURCE_CAPABILITY],
    };
    const input: RegisterMigrationSourceInput = {
      businessUnitId,
      sourceKey: "source_runtime_contract",
      sourceKind: "SALAM_CRM_JSON",
      sourceMode: "ONE_TIME_MIGRATION",
      ownerMembershipId: randomUUID(),
      domains: [
        {
          domainKey: "sales.runtime_contract",
          canonicalTarget: "crm.canonical",
          transitionMode: "ONE_TIME_CUTOVER",
          initialAuthorityState: "LEGACY_WRITABLE",
        },
      ],
    };
    await expect(registerMigrationSource(null as never, input)).rejects.toMatchObject({
      code: "MIGRATION_INPUT_INVALID",
      status: 422,
    });
    await expect(registerMigrationSource(actor, null as never)).rejects.toMatchObject({
      code: "MIGRATION_INPUT_INVALID",
      status: 422,
    });
    const cases: readonly {
      label: string;
      actor?: MigrationActor;
      input?: RegisterMigrationSourceInput;
    }[] = [
      { label: "actor user UUID", actor: { ...actor, userId: "bad" } },
      { label: "actor organization UUID", actor: { ...actor, organizationId: "bad" } },
      { label: "actor membership UUID", actor: { ...actor, activeMembershipId: "bad" } },
      { label: "actor business-unit UUID", actor: { ...actor, businessUnitId: "bad" } },
      {
        label: "capability element runtime type",
        actor: { ...actor, capabilities: [SOURCE_CAPABILITY, 7 as never] },
      },
      { label: "input business-unit UUID", input: { ...input, businessUnitId: "bad" } },
      { label: "owner UUID", input: { ...input, ownerMembershipId: "bad" } },
      { label: "source kind", input: { ...input, sourceKind: "SQL_DUMP" as never } },
      { label: "source mode", input: { ...input, sourceMode: "DUAL_WRITE" as never } },
      { label: "source key", input: { ...input, sourceKey: "../unsafe" } },
      { label: "empty domains", input: { ...input, domains: [] } },
      {
        label: "oversized domains",
        input: {
          ...input,
          domains: Array.from({ length: 101 }, (_, index) => ({
            ...input.domains[0]!,
            domainKey: `sales.runtime_${index}`,
          })),
        },
      },
      {
        label: "domain key",
        input: {
          ...input,
          domains: [{ ...input.domains[0]!, domainKey: "../unsafe" }],
        },
      },
      {
        label: "canonical target",
        input: {
          ...input,
          domains: [{ ...input.domains[0]!, canonicalTarget: "http://target" }],
        },
      },
    ];
    for (const scenario of cases) {
      await expect(
        registerMigrationSource(scenario.actor ?? actor, scenario.input ?? input),
        scenario.label,
      ).rejects.toMatchObject({ status: 422 });
    }

    await expect(
      registerMigrationSource({ ...actor, capabilities: [] }, input),
    ).rejects.toMatchObject({ code: "MIGRATION_CAPABILITY_REQUIRED", status: 403 });
  });

  it("creates the first approved source, active scopes, and durable missing heads", async () => {
    const tenant = await seedTenant();
    const input = validSourceInput(tenant);
    input.domains = [
      ...input.domains,
      {
        ...input.domains[0]!,
        domainKey: `sales.orders_${randomUUID().replaceAll("-", "_")}`,
      },
    ];

    const sourceId = await registerMigrationSource(tenant.sourceActors[0], input);

    const [source] = await sql<{ status: string; owner_membership_id: string }[]>`
      select status, owner_membership_id
      from migration_sources
      where organization_id = ${tenant.organizationId} and id = ${sourceId}
    `;
    expect(source).toEqual({
      status: "ACTIVE",
      owner_membership_id: tenant.businessUnitMembershipIds[0],
    });
    const scopes = await sql<{
      id: string;
      domain_key: string;
      source_status: string;
    }[]>`
      select id, domain_key, source_status
      from migration_source_scopes
      where organization_id = ${tenant.organizationId} and migration_source_id = ${sourceId}
      order by domain_key
    `;
    expect(scopes).toHaveLength(2);
    expect(scopes.every((scope) => scope.source_status === "ACTIVE_AUTHORITY")).toBe(true);
    const heads = await sql<{ domain_key: string; authority_source_scope_id: string }[]>`
      select domain_key, authority_source_scope_id
      from migration_domain_authorities
      where organization_id = ${tenant.organizationId}
        and business_unit_id = ${tenant.businessUnitIds[0]}
      order by domain_key
    `;
    expect(heads.map((head) => head.domain_key)).toEqual(
      [...input.domains].map((domain) => domain.domainKey).sort(),
    );
    expect(heads.map((head) => head.authority_source_scope_id).sort()).toEqual(
      scopes.map((scope) => scope.id).sort(),
    );
  });

  it("rejects duplicate source keys without treating registration as replay", async () => {
    const tenant = await seedTenant();
    const first = validSourceInput(tenant);
    await registerMigrationSource(tenant.sourceActors[0], first);

    await expect(
      registerMigrationSource(tenant.sourceActors[0], {
        ...validSourceInput(tenant),
        sourceKey: first.sourceKey,
      }),
    ).rejects.toMatchObject({ code: "MIGRATION_SOURCE_CONFLICT", status: 409 });

    const [countRow] = await sql<{ count: number }[]>`
      select count(*)::int as count
      from migration_sources
      where organization_id = ${tenant.organizationId}
        and business_unit_id = ${tenant.businessUnitIds[0]}
        and source_key = ${first.sourceKey}
    `;
    expect(countRow?.count).toBe(1);
  });

  it("sanitizes unexpected source database failures behind a stable application error", async () => {
    const tenant = await seedTenant();
    await sql.unsafe(`
      create function crm_test_fail_source_insert() returns trigger
      language plpgsql as $$
      begin
        raise exception 'synthetic source database secret';
      end; $$;
      create trigger crm_test_fail_source_insert_trigger
      before insert on migration_sources
      for each row execute function crm_test_fail_source_insert();
    `);
    let failure: unknown;
    try {
      try {
        await registerMigrationSource(tenant.sourceActors[0], validSourceInput(tenant));
      } catch (error: unknown) {
        failure = error;
      }
    } finally {
      await sql.unsafe(`
        drop trigger if exists crm_test_fail_source_insert_trigger on migration_sources;
        drop function if exists crm_test_fail_source_insert();
      `);
    }
    expect(failure).toMatchObject({
      code: "MIGRATION_SOURCE_REGISTRATION_FAILED",
      status: 500,
    });
    const exposed = `${String(failure)} ${JSON.stringify(failure)}`;
    expect(exposed).not.toContain("synthetic source database secret");
    expect(exposed).not.toContain("crm_test_fail_source_insert");
    expect(exposed).not.toContain("migration_sources_source_unique");
  });

  it("keeps a later matching scope registered and never displaces the durable head", async () => {
    const tenant = await seedTenant();
    const domainKey = `sales.shared_${randomUUID().replaceAll("-", "_")}`;
    const firstId = await registerMigrationSource(
      tenant.sourceActors[0],
      validSourceInput(tenant, 0, domainKey),
    );
    const [before] = await sql<{ authority_source_scope_id: string }[]>`
      select authority_source_scope_id
      from migration_domain_authorities
      where organization_id = ${tenant.organizationId}
        and business_unit_id = ${tenant.businessUnitIds[0]}
        and domain_key = ${domainKey}
    `;

    const secondId = await registerMigrationSource(
      tenant.sourceActors[0],
      validSourceInput(tenant, 0, domainKey),
    );

    const [after] = await sql<{ authority_source_scope_id: string }[]>`
      select authority_source_scope_id
      from migration_domain_authorities
      where organization_id = ${tenant.organizationId}
        and business_unit_id = ${tenant.businessUnitIds[0]}
        and domain_key = ${domainKey}
    `;
    const [secondScope] = await sql<{ source_status: string }[]>`
      select source_status
      from migration_source_scopes
      where organization_id = ${tenant.organizationId} and migration_source_id = ${secondId}
    `;
    const [secondSource] = await sql<{ status: string }[]>`
      select status from migration_sources
      where organization_id = ${tenant.organizationId} and id = ${secondId}
    `;
    expect(after?.authority_source_scope_id).toBe(before?.authority_source_scope_id);
    expect(secondScope?.source_status).toBe("REGISTERED");
    expect(secondSource?.status).toBe("REGISTERED");
    expect(secondId).not.toBe(firstId);
  });

  it("rejects a later source whose canonical target conflicts with the durable head", async () => {
    const tenant = await seedTenant();
    const domainKey = `sales.target_${randomUUID().replaceAll("-", "_")}`;
    await registerMigrationSource(
      tenant.sourceActors[0],
      validSourceInput(tenant, 0, domainKey),
    );
    const conflicting = validSourceInput(tenant, 0, domainKey);
    conflicting.domains = [{ ...conflicting.domains[0]!, canonicalTarget: "crm.other" }];

    await expect(
      registerMigrationSource(tenant.sourceActors[0], conflicting),
    ).rejects.toMatchObject({ code: "MIGRATION_DOMAIN_CONFLICT", status: 409 });
  });

  it("serializes concurrent first claims so exactly one source owns the new domain", async () => {
    const tenant = await seedTenant();
    const domainKey = `sales.race_${randomUUID().replaceAll("-", "_")}`;

    const [leftId, rightId] = await Promise.all([
      registerMigrationSource(tenant.sourceActors[0], validSourceInput(tenant, 0, domainKey)),
      registerMigrationSource(tenant.sourceActors[0], validSourceInput(tenant, 0, domainKey)),
    ]);

    const scopes = await sql<{ migration_source_id: string; source_status: string }[]>`
      select migration_source_id, source_status
      from migration_source_scopes
      where organization_id = ${tenant.organizationId}
        and business_unit_id = ${tenant.businessUnitIds[0]}
        and domain_key = ${domainKey}
      order by migration_source_id
    `;
    expect(scopes).toHaveLength(2);
    expect(scopes.filter((scope) => scope.source_status === "ACTIVE_AUTHORITY")).toHaveLength(1);
    expect(scopes.filter((scope) => scope.source_status === "REGISTERED")).toHaveLength(1);
    expect(scopes.map((scope) => scope.migration_source_id).sort()).toEqual(
      [leftId, rightId].sort(),
    );
  });

  it(
    "forces an observable unique-head wait and preserves one winner plus one registered loser",
    async () => {
      const tenant = await seedTenant();
      const domainKey = `sales.forced_overlap_${randomUUID().replaceAll("-", "_")}`;
      const advisoryKey = 917_271;
      const firstInput = {
        ...validSourceInput(tenant, 0, domainKey),
        sourceKey: "source_forced_first",
      };
      const secondInput = {
        ...validSourceInput(tenant, 0, domainKey),
        sourceKey: "source_forced_second",
      };
      await sql.unsafe(`
        create function crm_test_pause_first_head_claim() returns trigger
        language plpgsql as $$
        begin
          if exists (
            select 1
            from migration_source_scopes scope
            join migration_sources source
              on source.organization_id = scope.organization_id
             and source.business_unit_id = scope.business_unit_id
             and source.id = scope.migration_source_id
            where scope.organization_id = new.organization_id
              and scope.business_unit_id = new.business_unit_id
              and scope.id = new.authority_source_scope_id
              and source.source_key = 'source_forced_first'
          ) then
            perform pg_advisory_xact_lock(${advisoryKey});
          end if;
          return new;
        end; $$;
        create trigger crm_test_pause_first_head_claim_trigger
        after insert on migration_domain_authorities
        for each row execute function crm_test_pause_first_head_claim();
      `);
      let releaseAdvisory!: () => void;
      const mayReleaseAdvisory = new Promise<void>((resolve) => {
        releaseAdvisory = resolve;
      });
      let reportAdvisory!: (pid: number) => void;
      const advisoryHeld = new Promise<number>((resolve) => {
        reportAdvisory = resolve;
      });
      const blocker = sql.begin(async (transaction) => {
        const [backend] = await transaction<{ pid: number }[]>`
          select pg_backend_pid() as pid
        `;
        await transaction`select pg_advisory_xact_lock(${advisoryKey})`;
        reportAdvisory(backend!.pid);
        await mayReleaseAdvisory;
      });
      let firstRegistration: Promise<string> | undefined;
      let secondRegistration: Promise<string> | undefined;
      try {
        const blockerPid = await advisoryHeld;
        firstRegistration = registerMigrationSource(tenant.sourceActors[0], firstInput);
        const firstPid = await waitUntilBlockedBy(blockerPid);
        secondRegistration = registerMigrationSource(tenant.sourceActors[0], secondInput);
        await waitUntilBlockedBy(firstPid);
        releaseAdvisory();
        await blocker;
        await expect(firstRegistration).resolves.toEqual(expect.any(String));
        await expect(secondRegistration).resolves.toEqual(expect.any(String));
      } finally {
        releaseAdvisory();
        const pending: Promise<unknown>[] = [blocker];
        if (firstRegistration) pending.push(firstRegistration);
        if (secondRegistration) pending.push(secondRegistration);
        await Promise.allSettled(pending);
        await sql.unsafe(`
          drop trigger if exists crm_test_pause_first_head_claim_trigger
            on migration_domain_authorities;
          drop function if exists crm_test_pause_first_head_claim();
        `);
      }
      const scopes = await sql<{ source_status: string }[]>`
        select scope.source_status
        from migration_source_scopes scope
        join migration_sources source
          on source.organization_id = scope.organization_id
         and source.business_unit_id = scope.business_unit_id
         and source.id = scope.migration_source_id
        where scope.organization_id = ${tenant.organizationId}
          and scope.business_unit_id = ${tenant.businessUnitIds[0]}
          and scope.domain_key = ${domainKey}
          and source.source_key in ('source_forced_first', 'source_forced_second')
        order by scope.source_status
      `;
      expect(scopes).toHaveLength(2);
      expect(scopes.filter((scope) => scope.source_status === "ACTIVE_AUTHORITY")).toHaveLength(1);
      expect(scopes.filter((scope) => scope.source_status === "REGISTERED")).toHaveLength(1);
    },
    20_000,
  );

  it(
    "sorts reversed concurrent domain inventories before claiming heads and scopes",
    async () => {
      const tenant = await seedTenant();
      const domains = [
        `sales.alpha_${randomUUID().replaceAll("-", "_")}`,
        `sales.omega_${randomUUID().replaceAll("-", "_")}`,
      ];
      const left = validSourceInput(tenant, 0, domains[0]);
      left.domains = [
        left.domains[0]!,
        { ...left.domains[0]!, domainKey: domains[1]! },
      ];
      const right = validSourceInput(tenant, 0, domains[1]);
      right.domains = [
        right.domains[0]!,
        { ...right.domains[0]!, domainKey: domains[0]! },
      ];

      const sourceIds = await Promise.all([
        registerMigrationSource(tenant.sourceActors[0], left),
        registerMigrationSource(tenant.sourceActors[0], right),
      ]);

      const heads = await sql<{ domain_key: string }[]>`
        select domain_key from migration_domain_authorities
        where organization_id = ${tenant.organizationId}
          and business_unit_id = ${tenant.businessUnitIds[0]}
          and domain_key = any(${domains})
        order by domain_key
      `;
      expect(heads.map((head) => head.domain_key)).toEqual([...domains].sort());
      const scopes = await sql<{ migration_source_id: string }[]>`
        select migration_source_id from migration_source_scopes
        where organization_id = ${tenant.organizationId}
          and migration_source_id = any(${sourceIds})
      `;
      expect(scopes).toHaveLength(4);
    },
    15_000,
  );

  it("uses deterministic ASCII byte order instead of locale collation for domain writes", async () => {
    const tenant = await seedTenant();
    const domains = ["sales.a_", "sales.a0"] as const;
    await sql.unsafe(`
      create table crm_test_domain_insert_order (
        sequence_no bigserial primary key,
        domain_key text not null
      );
      create function crm_test_capture_domain_insert_order() returns trigger
      language plpgsql as $$
      begin
        insert into crm_test_domain_insert_order (domain_key) values (new.domain_key);
        return new;
      end; $$;
      create trigger crm_test_capture_domain_insert_order_trigger
      after insert on migration_source_scopes
      for each row execute function crm_test_capture_domain_insert_order();
    `);
    try {
      const input = validSourceInput(tenant, 0, domains[0]);
      input.domains = [
        { ...input.domains[0]!, domainKey: domains[0] },
        { ...input.domains[0]!, domainKey: domains[1] },
      ];
      await registerMigrationSource(tenant.sourceActors[0], input);
      const inserted = await sql<{ domain_key: string }[]>`
        select domain_key from crm_test_domain_insert_order order by sequence_no
      `;
      expect(inserted.map((row) => row.domain_key)).toEqual(["sales.a0", "sales.a_"]);
    } finally {
      await sql.unsafe(`
        drop trigger if exists crm_test_capture_domain_insert_order_trigger
          on migration_source_scopes;
        drop function if exists crm_test_capture_domain_insert_order();
        drop table if exists crm_test_domain_insert_order;
      `);
    }
  });

  it("rejects cross-tenant owners, wrong active-BU context, and invalid mode pairings", async () => {
    const tenant = await seedTenant();
    const otherTenant = await seedTenant();
    const crossTenant = validSourceInput(tenant);
    crossTenant.ownerMembershipId = otherTenant.businessUnitMembershipIds[0];
    await expect(
      registerMigrationSource(tenant.sourceActors[0], crossTenant),
    ).rejects.toMatchObject({ status: 404 });

    await expect(
      registerMigrationSource(tenant.sourceActors[0], validSourceInput(tenant, 1)),
    ).rejects.toMatchObject({ code: "MIGRATION_SCOPE_FORBIDDEN", status: 403 });

    const invalidPair = validSourceInput(tenant);
    invalidPair.domains = [
      {
        ...invalidPair.domains[0]!,
        transitionMode: "RECURRING_EXTERNAL_SNAPSHOT",
      },
    ];
    await expect(
      registerMigrationSource(tenant.sourceActors[0], invalidPair),
    ).rejects.toMatchObject({ code: "MIGRATION_SOURCE_MODE_INVALID", status: 422 });

    const duplicateDomain = validSourceInput(tenant);
    duplicateDomain.domains = [
      duplicateDomain.domains[0]!,
      {
        ...duplicateDomain.domains[0]!,
        domainKey: ` ${duplicateDomain.domains[0]!.domainKey.toUpperCase()} `,
      },
    ];
    await expect(
      registerMigrationSource(tenant.sourceActors[0], duplicateDomain),
    ).rejects.toMatchObject({ code: "MIGRATION_DOMAIN_DUPLICATE", status: 422 });
  });

  it("requires both trusted claimed capability and a live database grant", async () => {
    const tenant = await seedTenant();
    await expect(
      registerMigrationSource(
        { ...tenant.sourceActors[0], capabilities: [] },
        validSourceInput(tenant),
      ),
    ).rejects.toMatchObject({ code: "MIGRATION_CAPABILITY_REQUIRED", status: 403 });
    await expect(
      registerMigrationSource(tenant.noCapabilityActor, validSourceInput(tenant)),
    ).rejects.toMatchObject({ code: "MIGRATION_CAPABILITY_REQUIRED", status: 403 });
  });

  it("rejects expired memberships and inactive joined users at transaction time", async () => {
    const tenant = await seedTenant();
    await expect(
      registerMigrationSource(tenant.expiredActor, validSourceInput(tenant)),
    ).rejects.toMatchObject({ code: "MIGRATION_MEMBERSHIP_INVALID", status: 403 });
    await expect(
      registerMigrationSource(tenant.inactiveActor, validSourceInput(tenant)),
    ).rejects.toMatchObject({ code: "MIGRATION_MEMBERSHIP_INVALID", status: 403 });
  });

  it("rejects actor identity mismatch and wrong-BU, expired, or inactive source owners", async () => {
    const identity = await seedTenant();
    await expect(
      registerMigrationSource(
        { ...identity.sourceActors[0], userId: randomUUID() },
        validSourceInput(identity),
      ),
    ).rejects.toMatchObject({ code: "MIGRATION_MEMBERSHIP_INVALID", status: 403 });

    const ownerCases = [
      {
        label: "same-tenant wrong-BU owner",
        membershipId: (tenant: TenantFixture) => tenant.businessUnitMembershipIds[1],
      },
      {
        label: "expired owner",
        membershipId: (tenant: TenantFixture) => tenant.expiredMembershipId,
      },
      {
        label: "inactive owner",
        membershipId: (tenant: TenantFixture) => tenant.inactiveMembershipId,
      },
    ] as const;
    for (const scenario of ownerCases) {
      const tenant = await seedTenant();
      await expect(
        registerMigrationSource(tenant.sourceActors[0], {
          ...validSourceInput(tenant),
          ownerMembershipId: scenario.membershipId(tenant),
        }),
        scenario.label,
      ).rejects.toMatchObject({ code: "MIGRATION_OWNER_NOT_FOUND", status: 404 });
    }
  });

  it("registers a recurring external snapshot with external-system authority", async () => {
    const tenant = await seedTenant();
    const input = validSourceInput(tenant);
    input.sourceKind = "NIAGAWAN_CSV";
    input.sourceMode = "RECURRING_READ_ONLY_SNAPSHOT";
    input.ownerMembershipId = tenant.orgWideMembershipId;
    input.domains = [
      {
        ...input.domains[0]!,
        transitionMode: "RECURRING_EXTERNAL_SNAPSHOT",
        initialAuthorityState: "EXTERNAL_SYSTEM_AUTHORITY",
      },
    ];
    const sourceId = await registerMigrationSource(tenant.sourceActors[0], input);
    const [head] = await sql<{ authority_state: string }[]>`
      select authority_state
      from migration_domain_authorities
      where organization_id = ${tenant.organizationId}
        and business_unit_id = ${tenant.businessUnitIds[0]}
        and domain_key = ${input.domains[0]!.domainKey}
    `;
    const [source] = await sql<{ owner_membership_id: string; status: string }[]>`
      select owner_membership_id, status from migration_sources where id = ${sourceId}
    `;
    expect(head?.authority_state).toBe("EXTERNAL_SYSTEM_AUTHORITY");
    expect(source).toEqual({
      owner_membership_id: tenant.orgWideMembershipId,
      status: "ACTIVE",
    });
  });

  it("rejects every remaining source-mode, transition-mode, and initial-state mismatch", async () => {
    const cases = [
      {
        sourceMode: "ONE_TIME_MIGRATION" as const,
        transitionMode: "ONE_TIME_CUTOVER" as const,
        initialAuthorityState: "EXTERNAL_SYSTEM_AUTHORITY" as const,
      },
      {
        sourceMode: "RECURRING_READ_ONLY_SNAPSHOT" as const,
        transitionMode: "ONE_TIME_CUTOVER" as const,
        initialAuthorityState: "EXTERNAL_SYSTEM_AUTHORITY" as const,
      },
      {
        sourceMode: "RECURRING_READ_ONLY_SNAPSHOT" as const,
        transitionMode: "RECURRING_EXTERNAL_SNAPSHOT" as const,
        initialAuthorityState: "LEGACY_WRITABLE" as const,
      },
    ];
    for (const mismatch of cases) {
      const tenant = await seedTenant();
      const input = validSourceInput(tenant);
      input.sourceMode = mismatch.sourceMode;
      input.domains = [
        {
          ...input.domains[0]!,
          transitionMode: mismatch.transitionMode,
          initialAuthorityState: mismatch.initialAuthorityState,
        },
      ];
      await expect(
        registerMigrationSource(tenant.sourceActors[0], input),
      ).rejects.toMatchObject({ code: "MIGRATION_SOURCE_MODE_INVALID", status: 422 });
    }
  });

  it(
    "rechecks the database capability after waiting on the organization inventory lock",
    async () => {
      const tenant = await seedTenant();
      let releaseOrganization!: () => void;
      const mayRelease = new Promise<void>((resolve) => {
        releaseOrganization = resolve;
      });
      let reportLock!: (pid: number) => void;
      const lockHeld = new Promise<number>((resolve) => {
        reportLock = resolve;
      });
      const blocker = sql.begin(async (transaction) => {
        const [backend] = await transaction<{ pid: number }[]>`
          select pg_backend_pid() as pid
        `;
        await transaction`
          select id from organizations where id = ${tenant.organizationId} for update
        `;
        reportLock(backend!.pid);
        await mayRelease;
      });
      const blockerPid = await lockHeld;
      const registration = registerMigrationSource(
        tenant.sourceActors[0],
        validSourceInput(tenant),
      );
      await waitUntilBlockedBy(blockerPid);
      const [role] = await sql<{ role_id: string }[]>`
        select role_id from membership_roles
        where organization_id = ${tenant.organizationId}
          and membership_id = ${tenant.businessUnitMembershipIds[0]}
      `;
      await sql`
        delete from role_capabilities
        where organization_id = ${tenant.organizationId}
          and role_id = ${role!.role_id}
          and capability_key = ${SOURCE_CAPABILITY}
      `;
      releaseOrganization();
      await blocker;
      await expect(registration).rejects.toMatchObject({
        code: "MIGRATION_CAPABILITY_REQUIRED",
        status: 403,
      });
    },
    15_000,
  );

  it(
    "rechecks identity, membership time, organization, and business-unit status after lock waits",
    async () => {
      const scenarios = [
        {
          label: "joined user suspended",
          block: async (transaction: TransactionSql, tenant: TenantFixture) => {
            await transaction`
              select id from organizations where id = ${tenant.organizationId} for update
            `;
          },
          mutate: async (tenant: TenantFixture) => {
            await sql`
              update users set status = 'SUSPENDED'
              where id = ${tenant.businessUnitUserIds[0]}
            `;
          },
          expected: { code: "MIGRATION_MEMBERSHIP_INVALID", status: 403 },
        },
        {
          label: "membership expires",
          block: async (transaction: TransactionSql, tenant: TenantFixture) => {
            await transaction`
              select id from organizations where id = ${tenant.organizationId} for update
            `;
          },
          mutate: async (tenant: TenantFixture) => {
            await sql`
              update memberships set valid_until = clock_timestamp() - interval '1 second'
              where organization_id = ${tenant.organizationId}
                and id = ${tenant.businessUnitMembershipIds[0]}
            `;
          },
          expected: { code: "MIGRATION_MEMBERSHIP_INVALID", status: 403 },
        },
        {
          label: "organization suspended",
          block: async (transaction: TransactionSql, tenant: TenantFixture) => {
            await transaction`
              update organizations set status = 'SUSPENDED'
              where id = ${tenant.organizationId}
            `;
          },
          mutate: async () => undefined,
          expected: { code: "MIGRATION_ORGANIZATION_NOT_FOUND", status: 404 },
        },
        {
          label: "business unit suspended",
          block: async (transaction: TransactionSql, tenant: TenantFixture) => {
            await transaction`
              update business_units set status = 'SUSPENDED'
              where organization_id = ${tenant.organizationId}
                and id = ${tenant.businessUnitIds[0]}
            `;
          },
          mutate: async () => undefined,
          expected: { code: "MIGRATION_BUSINESS_UNIT_NOT_FOUND", status: 404 },
        },
      ] as const;

      for (const scenario of scenarios) {
        const tenant = await seedTenant();
        let release!: () => void;
        const mayRelease = new Promise<void>((resolve) => {
          release = resolve;
        });
        let reportLock!: (pid: number) => void;
        const lockHeld = new Promise<number>((resolve) => {
          reportLock = resolve;
        });
        const blocker = sql.begin(async (transaction) => {
          const [backend] = await transaction<{ pid: number }[]>`
            select pg_backend_pid() as pid
          `;
          await scenario.block(transaction, tenant);
          reportLock(backend!.pid);
          await mayRelease;
        });
        const blockerPid = await lockHeld;
        const registration = registerMigrationSource(
          tenant.sourceActors[0],
          validSourceInput(tenant),
        );
        await waitUntilBlockedBy(blockerPid);
        await scenario.mutate(tenant);
        release();
        await blocker;
        await expect(registration, scenario.label).rejects.toMatchObject(scenario.expected);
      }
    },
    20_000,
  );
});

describe("reviewed transform registration", () => {
  it("rejects malformed transform commands before object-store, registry, or database work", async () => {
    const mappingArtifactRef = protectedRef("preflight-mapping");
    const releaseManifestRef = protectedRef("preflight-release");
    const digest = sha256("preflight-mapping");
    const actor: MigrationActor = {
      userId: randomUUID(),
      organizationId: randomUUID(),
      activeMembershipId: randomUUID(),
      businessUnitId: randomUUID(),
      capabilities: [SOURCE_CAPABILITY],
    };
    const input: RegisterTransformVersionInput = {
      businessUnitId: actor.businessUnitId,
      migrationSourceId: randomUUID(),
      versionNo: 1,
      sourceSchemaVersion: "sales.v1",
      mappingArtifactRef,
      expectedMappingSha256: digest,
      releaseManifestRef,
      expectedReleaseManifestSha256: sha256("preflight-manifest"),
      expectedReleaseSha256: sha256("preflight-release"),
      rationale: "Reviewed preflight mapping",
      repairOfTransformId: null,
    };
    const neverStore = artifactStore({});
    const neverRegistry: ReviewedTransformReleaseRegistry = {
      async getReviewedRelease() {
        throw new Error("must not be called");
      },
    };
    await expect(
      registerTransformVersion(null as never, input, neverStore, neverRegistry),
    ).rejects.toMatchObject({ code: "MIGRATION_INPUT_INVALID", status: 422 });
    await expect(
      registerTransformVersion(actor, null as never, neverStore, neverRegistry),
    ).rejects.toMatchObject({ code: "MIGRATION_INPUT_INVALID", status: 422 });
    const cases: readonly {
      label: string;
      actor?: MigrationActor;
      input?: RegisterTransformVersionInput;
    }[] = [
      { label: "actor user UUID", actor: { ...actor, userId: "bad" } },
      { label: "actor organization UUID", actor: { ...actor, organizationId: "bad" } },
      { label: "actor membership UUID", actor: { ...actor, activeMembershipId: "bad" } },
      { label: "actor business-unit UUID", actor: { ...actor, businessUnitId: "bad" } },
      {
        label: "capability element runtime type",
        actor: { ...actor, capabilities: [SOURCE_CAPABILITY, 7 as never] },
      },
      { label: "input business-unit UUID", input: { ...input, businessUnitId: "bad" } },
      { label: "source UUID", input: { ...input, migrationSourceId: "bad" } },
      { label: "zero version", input: { ...input, versionNo: 0 } },
      { label: "fractional version", input: { ...input, versionNo: 1.5 } },
      { label: "unsafe version", input: { ...input, versionNo: Number.MAX_SAFE_INTEGER + 1 } },
      { label: "repair UUID", input: { ...input, repairOfTransformId: "bad" } },
      { label: "blank schema", input: { ...input, sourceSchemaVersion: "" } },
      {
        label: "oversized schema",
        input: { ...input, sourceSchemaVersion: `s${"x".repeat(128)}` },
      },
      { label: "blank rationale", input: { ...input, rationale: "   " } },
      {
        label: "oversized rationale",
        input: { ...input, rationale: "x".repeat(2_001) },
      },
      {
        label: "mapping digest",
        input: { ...input, expectedMappingSha256: new Uint8Array(31) },
      },
      {
        label: "manifest digest",
        input: { ...input, expectedReleaseManifestSha256: new Uint8Array(31) },
      },
      {
        label: "release digest",
        input: { ...input, expectedReleaseSha256: new Uint8Array(31) },
      },
    ];
    for (const scenario of cases) {
      let storeCalled = false;
      let registryCalled = false;
      await expect(
        registerTransformVersion(
          scenario.actor ?? actor,
          scenario.input ?? input,
          {
            async *open() {
              storeCalled = true;
              yield Buffer.from("must not be read");
            },
          },
          {
            async getReviewedRelease() {
              registryCalled = true;
              throw new Error("must not be called");
            },
          },
        ),
        scenario.label,
      ).rejects.toMatchObject({ status: 422 });
      expect(storeCalled, scenario.label).toBe(false);
      expect(registryCalled, scenario.label).toBe(false);
    }
  });

  it("rejects a missing trusted source-management claim before external adapters", async () => {
    const fixture = await seedTransformRegistrationFixture();
    let storeCalled = false;
    let registryCalled = false;
    await expect(
      registerTransformVersion(
        { ...fixture.tenant.sourceActors[0], capabilities: [] },
        fixture.input,
        {
          async *open() {
            storeCalled = true;
            yield fixture.mappingChunks[0]!;
          },
        },
        {
          async getReviewedRelease() {
            registryCalled = true;
            return fixture.release;
          },
        },
      ),
    ).rejects.toMatchObject({ code: "MIGRATION_CAPABILITY_REQUIRED", status: 403 });
    expect(storeCalled).toBe(false);
    expect(registryCalled).toBe(false);
  });

  it("streams and persists an exact signed release binding as immutable approved evidence", async () => {
    const fixture = await seedTransformRegistrationFixture();
    const transformId = await registerTransformVersion(
      fixture.tenant.sourceActors[0],
      fixture.input,
      fixture.store,
      fixture.registry,
    );

    const [stored] = await sql<{
      mapping_artifact_ref: string;
      mapping_sha256: Buffer;
      release_manifest_ref: string;
      release_manifest_sha256: Buffer;
      transform_release_sha256: Buffer;
      approved_by_membership_id: string;
      approved_at: Date;
    }[]>`
      select mapping_artifact_ref, mapping_sha256, release_manifest_ref,
             release_manifest_sha256, transform_release_sha256,
             approved_by_membership_id, approved_at
      from transform_versions
      where organization_id = ${fixture.tenant.organizationId} and id = ${transformId}
    `;
    expect(stored).toMatchObject({
      mapping_artifact_ref: fixture.input.mappingArtifactRef,
      release_manifest_ref: fixture.input.releaseManifestRef,
      approved_by_membership_id: fixture.tenant.businessUnitMembershipIds[0],
    });
    expect(Buffer.from(stored!.mapping_sha256)).toEqual(fixture.mappingSha256);
    expect(Buffer.from(stored!.release_manifest_sha256)).toEqual(
      fixture.release.manifestSha256,
    );
    expect(Buffer.from(stored!.transform_release_sha256)).toEqual(
      fixture.release.releaseSha256,
    );
    expect(stored?.approved_at).toBeInstanceOf(Date);

    await expect(
      sql`update transform_versions set rationale = 'mutated' where id = ${transformId}`,
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      sql`delete from transform_versions where id = ${transformId}`,
    ).rejects.toMatchObject({ code: "55000" });
  });

  it("rejects empty mappings and streamed checksum mismatches", async () => {
    const fixture = await seedTransformRegistrationFixture();
    await expect(
      registerTransformVersion(
        fixture.tenant.sourceActors[0],
        fixture.input,
        artifactStore({ [fixture.input.mappingArtifactRef]: [] }),
        fixture.registry,
      ),
    ).rejects.toMatchObject({ code: "MAPPING_ARTIFACT_EMPTY", status: 422 });

    await expect(
      registerTransformVersion(
        fixture.tenant.sourceActors[0],
        { ...fixture.input, expectedMappingSha256: sha256("wrong") },
        fixture.store,
        fixture.registry,
      ),
    ).rejects.toMatchObject({ code: "ARTIFACT_CHECKSUM_MISMATCH", status: 422 });
  });

  it("never pairs a valid signed release with another mapping or release envelope", async () => {
    const mismatchKeys: readonly (keyof ReviewedTransformRelease)[] = [
      "manifestRef",
      "manifestSha256",
      "mappingArtifactRef",
      "mappingSha256",
      "sourceSchemaVersion",
      "releaseSha256",
    ];
    for (const key of mismatchKeys) {
      const fixture = await seedTransformRegistrationFixture();
      const mismatched: ReviewedTransformRelease = {
        ...fixture.release,
        [key]:
          key.endsWith("Sha256")
            ? sha256(`wrong-${key}`)
            : key.endsWith("Ref")
              ? protectedRef(`wrong-${key}`)
              : "wrong.schema",
      };
      await expect(
        registerTransformVersion(
          fixture.tenant.sourceActors[0],
          fixture.input,
          fixture.store,
          releaseRegistry(mismatched),
        ),
        `release field ${key}`,
      ).rejects.toMatchObject({ code: "TRANSFORM_RELEASE_MISMATCH", status: 422 });
    }
  });

  it("rejects unsafe and placeholder protected references from callers and registries", async () => {
    for (const field of ["mappingArtifactRef", "releaseManifestRef"] as const) {
      for (const ref of unsafeProtectedReferences) {
        const fixture = await seedTransformRegistrationFixture();
        await expect(
          registerTransformVersion(
            fixture.tenant.sourceActors[0],
            { ...fixture.input, [field]: ref },
            artifactStore({ [ref]: fixture.mappingChunks }),
            fixture.registry,
          ),
          `caller ${field}: ${JSON.stringify(ref)}`,
        ).rejects.toMatchObject({ code: "PROTECTED_ARTIFACT_REF_INVALID", status: 422 });
      }
    }

    for (const field of ["manifestRef", "mappingArtifactRef"] as const) {
      for (const ref of unsafeProtectedReferences) {
        const fixture = await seedTransformRegistrationFixture();
        await expect(
          registerTransformVersion(
            fixture.tenant.sourceActors[0],
            fixture.input,
            fixture.store,
            releaseRegistry({ ...fixture.release, [field]: ref }),
          ),
          `registry ${field}: ${JSON.stringify(ref)}`,
        ).rejects.toMatchObject({ code: "PROTECTED_ARTIFACT_REF_INVALID", status: 422 });
      }
    }
  });

  it("rejects malformed reviewed commit and signing-key provenance", async () => {
    for (const overrides of [
      { gitCommitSha: "main" },
      { signatureKeyId: "TODO" },
    ] satisfies readonly Partial<ReviewedTransformRelease>[]) {
      const fixture = await seedTransformRegistrationFixture();
      await expect(
        registerTransformVersion(
          fixture.tenant.sourceActors[0],
          fixture.input,
          fixture.store,
          releaseRegistry({ ...fixture.release, ...overrides }),
        ),
      ).rejects.toMatchObject({ code: "TRANSFORM_RELEASE_INVALID", status: 422 });
    }
  });

  it("rejects malformed registry runtime types and every 31-byte release digest", async () => {
    const fixture = await seedTransformRegistrationFixture();
    const cases: readonly { label: string; release: unknown }[] = [
      { label: "null release", release: null },
      {
        label: "manifest digest length",
        release: { ...fixture.release, manifestSha256: new Uint8Array(31) },
      },
      {
        label: "mapping digest length",
        release: { ...fixture.release, mappingSha256: new Uint8Array(31) },
      },
      {
        label: "release digest length",
        release: { ...fixture.release, releaseSha256: new Uint8Array(31) },
      },
      {
        label: "schema runtime type",
        release: { ...fixture.release, sourceSchemaVersion: null },
      },
      {
        label: "commit runtime type",
        release: { ...fixture.release, gitCommitSha: [] },
      },
      {
        label: "key runtime type",
        release: { ...fixture.release, signatureKeyId: {} },
      },
    ];
    for (const scenario of cases) {
      await expect(
        registerTransformVersion(
          fixture.tenant.sourceActors[0],
          fixture.input,
          fixture.store,
          {
            async getReviewedRelease() {
              return scenario.release as ReviewedTransformRelease;
            },
          },
        ),
        scenario.label,
      ).rejects.toMatchObject({ status: 422 });
    }
    const [countRow] = await sql<{ count: number }[]>`
      select count(*)::int as count from transform_versions
      where organization_id = ${fixture.tenant.organizationId}
        and migration_source_id = ${fixture.sourceId}
    `;
    expect(countRow?.count).toBe(0);
  });

  it("does not write a transform when external artifact or registry verification fails", async () => {
    const fixture = await seedTransformRegistrationFixture();
    await expect(
      registerTransformVersion(
        fixture.tenant.sourceActors[0],
        fixture.input,
        {
          async *open() {
            throw new Error("OBJECT_STORE_UNAVAILABLE_WITH_SECRET_DETAIL");
          },
        },
        fixture.registry,
      ),
    ).rejects.toMatchObject({ code: "ARTIFACT_READ_FAILED", status: 422 });
    const openSecret = "SYNCHRONOUS_OBJECT_STORE_API_ERROR_SECRET";
    let openFailure: unknown;
    try {
      await registerTransformVersion(
        fixture.tenant.sourceActors[0],
        fixture.input,
        {
          open() {
            throw new ApiError(503, "OBJECT_STORE_PRIVATE_FAILURE", openSecret);
          },
        },
        fixture.registry,
      );
    } catch (caught) {
      openFailure = caught;
    }
    expect(openFailure).toMatchObject({ code: "ARTIFACT_READ_FAILED", status: 422 });
    expect(`${String(openFailure)} ${JSON.stringify(openFailure)}`).not.toContain(openSecret);
    expect(`${String(openFailure)} ${JSON.stringify(openFailure)}`).not.toContain(
      "OBJECT_STORE_PRIVATE_FAILURE",
    );
    const [countRow] = await sql<{ count: number }[]>`
      select count(*)::int as count from transform_versions
      where organization_id = ${fixture.tenant.organizationId}
        and migration_source_id = ${fixture.sourceId}
    `;
    expect(countRow?.count).toBe(0);

    const registryFixture = await seedTransformRegistrationFixture();
    const secret = "REGISTRY_PROVIDER_SECRET_DETAIL";
    let error: unknown;
    try {
      await registerTransformVersion(
        registryFixture.tenant.sourceActors[0],
        registryFixture.input,
        registryFixture.store,
        {
          async getReviewedRelease() {
            throw new Error(secret);
          },
        },
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "TRANSFORM_RELEASE_LOOKUP_FAILED", status: 422 });
    expect(String(error)).not.toContain(secret);
  });

  it("sanitizes unexpected transform database failures behind a stable application error", async () => {
    const fixture = await seedTransformRegistrationFixture();
    await sql.unsafe(`
      create function crm_test_fail_transform_insert() returns trigger
      language plpgsql as $$
      begin
        raise exception 'synthetic transform database secret';
      end; $$;
      create trigger crm_test_fail_transform_insert_trigger
      before insert on transform_versions
      for each row execute function crm_test_fail_transform_insert();
    `);
    let failure: unknown;
    try {
      try {
        await registerTransformVersion(
          fixture.tenant.sourceActors[0],
          fixture.input,
          fixture.store,
          fixture.registry,
        );
      } catch (error: unknown) {
        failure = error;
      }
    } finally {
      await sql.unsafe(`
        drop trigger if exists crm_test_fail_transform_insert_trigger on transform_versions;
        drop function if exists crm_test_fail_transform_insert();
      `);
    }
    expect(failure).toMatchObject({
      code: "TRANSFORM_REGISTRATION_FAILED",
      status: 500,
    });
    const exposed = `${String(failure)} ${JSON.stringify(failure)}`;
    expect(exposed).not.toContain("synthetic transform database secret");
    expect(exposed).not.toContain("crm_test_fail_transform_insert");
    expect(exposed).not.toContain("transform_versions_version_unique");
  });

  it("rechecks actor identity, membership validity, tenant, and active org/BU after review", async () => {
    const foreign = await seedTransformRegistrationFixture();
    const local = await seedTransformRegistrationFixture();
    await expect(
      registerTransformVersion(
        local.tenant.sourceActors[0],
        { ...local.input, migrationSourceId: foreign.sourceId },
        local.store,
        local.registry,
      ),
    ).rejects.toMatchObject({ code: "MIGRATION_SOURCE_NOT_FOUND", status: 404 });

    const wrongIdentity = await seedTransformRegistrationFixture();
    await expect(
      registerTransformVersion(
        { ...wrongIdentity.tenant.sourceActors[0], userId: randomUUID() },
        wrongIdentity.input,
        wrongIdentity.store,
        wrongIdentity.registry,
      ),
    ).rejects.toMatchObject({ code: "MIGRATION_MEMBERSHIP_INVALID", status: 403 });

    const expired = await seedTransformRegistrationFixture();
    await expect(
      registerTransformVersion(
        expired.tenant.expiredActor,
        expired.input,
        expired.store,
        expired.registry,
      ),
    ).rejects.toMatchObject({ code: "MIGRATION_MEMBERSHIP_INVALID", status: 403 });

    const inactive = await seedTransformRegistrationFixture();
    await expect(
      registerTransformVersion(
        inactive.tenant.inactiveActor,
        inactive.input,
        inactive.store,
        inactive.registry,
      ),
    ).rejects.toMatchObject({ code: "MIGRATION_MEMBERSHIP_INVALID", status: 403 });

    const suspendedOrg = await seedTransformRegistrationFixture();
    await sql`
      update organizations set status = 'SUSPENDED'
      where id = ${suspendedOrg.tenant.organizationId}
    `;
    await expect(
      registerTransformVersion(
        suspendedOrg.tenant.sourceActors[0],
        suspendedOrg.input,
        suspendedOrg.store,
        suspendedOrg.registry,
      ),
    ).rejects.toMatchObject({ code: "MIGRATION_ORGANIZATION_NOT_FOUND", status: 404 });

    const suspendedBu = await seedTransformRegistrationFixture();
    await sql`
      update business_units set status = 'SUSPENDED'
      where organization_id = ${suspendedBu.tenant.organizationId}
        and id = ${suspendedBu.tenant.businessUnitIds[0]}
    `;
    await expect(
      registerTransformVersion(
        suspendedBu.tenant.sourceActors[0],
        suspendedBu.input,
        suspendedBu.store,
        suspendedBu.registry,
      ),
    ).rejects.toMatchObject({ code: "MIGRATION_BUSINESS_UNIT_NOT_FOUND", status: 404 });
  });

  it("rechecks mutable authorization after the external release review callback", async () => {
    const cases = [
      {
        label: "database capability revoked",
        mutate: async (fixture: Awaited<ReturnType<typeof seedTransformRegistrationFixture>>) => {
          const [role] = await sql<{ role_id: string }[]>`
            select role_id from membership_roles
            where organization_id = ${fixture.tenant.organizationId}
              and membership_id = ${fixture.tenant.businessUnitMembershipIds[0]}
          `;
          await sql`
            delete from role_capabilities
            where organization_id = ${fixture.tenant.organizationId}
              and role_id = ${role!.role_id}
              and capability_key = ${SOURCE_CAPABILITY}
          `;
        },
        expected: { code: "MIGRATION_CAPABILITY_REQUIRED", status: 403 },
      },
      {
        label: "membership expired",
        mutate: async (fixture: Awaited<ReturnType<typeof seedTransformRegistrationFixture>>) => {
          await sql`
            update memberships set valid_until = clock_timestamp() - interval '1 second'
            where organization_id = ${fixture.tenant.organizationId}
              and id = ${fixture.tenant.businessUnitMembershipIds[0]}
          `;
        },
        expected: { code: "MIGRATION_MEMBERSHIP_INVALID", status: 403 },
      },
      {
        label: "joined identity suspended",
        mutate: async (fixture: Awaited<ReturnType<typeof seedTransformRegistrationFixture>>) => {
          await sql`
            update users set status = 'SUSPENDED'
            where id = ${fixture.tenant.businessUnitUserIds[0]}
          `;
        },
        expected: { code: "MIGRATION_MEMBERSHIP_INVALID", status: 403 },
      },
      {
        label: "organization suspended",
        mutate: async (fixture: Awaited<ReturnType<typeof seedTransformRegistrationFixture>>) => {
          await sql`
            update organizations set status = 'SUSPENDED'
            where id = ${fixture.tenant.organizationId}
          `;
        },
        expected: { code: "MIGRATION_ORGANIZATION_NOT_FOUND", status: 404 },
      },
      {
        label: "business unit suspended",
        mutate: async (fixture: Awaited<ReturnType<typeof seedTransformRegistrationFixture>>) => {
          await sql`
            update business_units set status = 'SUSPENDED'
            where organization_id = ${fixture.tenant.organizationId}
              and id = ${fixture.tenant.businessUnitIds[0]}
          `;
        },
        expected: { code: "MIGRATION_BUSINESS_UNIT_NOT_FOUND", status: 404 },
      },
    ] as const;

    for (const scenario of cases) {
      const fixture = await seedTransformRegistrationFixture();
      let callbackCompleted = false;
      await expect(
        registerTransformVersion(
          fixture.tenant.sourceActors[0],
          fixture.input,
          fixture.store,
          {
            async getReviewedRelease() {
              await scenario.mutate(fixture);
              callbackCompleted = true;
              return fixture.release;
            },
          },
        ),
        scenario.label,
      ).rejects.toMatchObject(scenario.expected);
      expect(callbackCompleted, scenario.label).toBe(true);
      const [countRow] = await sql<{ count: number }[]>`
        select count(*)::int as count from transform_versions
        where organization_id = ${fixture.tenant.organizationId}
          and migration_source_id = ${fixture.sourceId}
      `;
      expect(countRow?.count, scenario.label).toBe(0);
    }
  });

  it("rejects cross-tenant, archived-source, duplicate-version, and invalid repair lineage", async () => {
    const fixture = await seedTransformRegistrationFixture();
    const transformId = await registerTransformVersion(
      fixture.tenant.sourceActors[0],
      fixture.input,
      fixture.store,
      fixture.registry,
    );
    await expect(
      registerTransformVersion(
        fixture.tenant.sourceActors[0],
        fixture.input,
        fixture.store,
        fixture.registry,
      ),
    ).rejects.toMatchObject({ code: "TRANSFORM_VERSION_CONFLICT", status: 409 });

    const other = await seedTransformRegistrationFixture();
    await expect(
      registerTransformVersion(
        other.tenant.sourceActors[0],
        { ...other.input, versionNo: 2, repairOfTransformId: transformId },
        other.store,
        other.registry,
      ),
    ).rejects.toMatchObject({ status: 404 });

    await sql`
      update migration_sources set status = 'ARCHIVED_READ_ONLY'
      where organization_id = ${fixture.tenant.organizationId} and id = ${fixture.sourceId}
    `;
    await expect(
      registerTransformVersion(
        fixture.tenant.sourceActors[0],
        { ...fixture.input, versionNo: 2, repairOfTransformId: transformId },
        fixture.store,
        fixture.registry,
      ),
    ).rejects.toMatchObject({ code: "MIGRATION_SOURCE_ARCHIVED", status: 409 });
  });

  it("rejects a same-organization wrong-BU source and a source whose owner expired", async () => {
    const wrongBusinessUnit = await seedTransformRegistrationFixture();
    const otherSourceId = await registerMigrationSource(
      wrongBusinessUnit.tenant.sourceActors[1],
      validSourceInput(wrongBusinessUnit.tenant, 1),
    );
    await expect(
      registerTransformVersion(
        wrongBusinessUnit.tenant.sourceActors[0],
        { ...wrongBusinessUnit.input, migrationSourceId: otherSourceId },
        wrongBusinessUnit.store,
        wrongBusinessUnit.registry,
      ),
    ).rejects.toMatchObject({ code: "MIGRATION_SOURCE_NOT_FOUND", status: 404 });

    const expiredOwner = await seedTransformRegistrationFixture();
    await sql`
      update migration_sources set owner_membership_id = ${expiredOwner.tenant.expiredMembershipId}
      where organization_id = ${expiredOwner.tenant.organizationId}
        and id = ${expiredOwner.sourceId}
    `;
    await expect(
      registerTransformVersion(
        expiredOwner.tenant.sourceActors[0],
        expiredOwner.input,
        expiredOwner.store,
        expiredOwner.registry,
      ),
    ).rejects.toMatchObject({ code: "MIGRATION_OWNER_NOT_FOUND", status: 404 });
  });

  it("allows an explicit reviewed repair only within the same source lineage", async () => {
    const fixture = await seedTransformRegistrationFixture();
    const originalId = await registerTransformVersion(
      fixture.tenant.sourceActors[0],
      fixture.input,
      fixture.store,
      fixture.registry,
    );
    const repairId = await registerTransformVersion(
      fixture.tenant.sourceActors[0],
      {
        ...fixture.input,
        versionNo: 2,
        rationale: "Correct reviewed normalization rule",
        repairOfTransformId: originalId,
      },
      fixture.store,
      fixture.registry,
    );
    const [repair] = await sql<{ repair_of_transform_id: string }[]>`
      select repair_of_transform_id from transform_versions where id = ${repairId}
    `;
    expect(repair?.repair_of_transform_id).toBe(originalId);
  });

  it("rejects same-tenant cross-source repairs and non-advancing repair versions", async () => {
    const fixture = await seedTransformRegistrationFixture();
    const originalId = await registerTransformVersion(
      fixture.tenant.sourceActors[0],
      fixture.input,
      fixture.store,
      fixture.registry,
    );
    await expect(
      registerTransformVersion(
        fixture.tenant.sourceActors[0],
        {
          ...fixture.input,
          versionNo: 1,
          repairOfTransformId: originalId,
          rationale: "Reviewed but non-advancing repair",
        },
        fixture.store,
        fixture.registry,
      ),
    ).rejects.toMatchObject({ code: "TRANSFORM_REPAIR_VERSION_INVALID", status: 409 });

    const secondSourceInput = validSourceInput(
      fixture.tenant,
      0,
      fixture.sourceInput.domains[0]!.domainKey,
    );
    const secondSourceId = await registerMigrationSource(
      fixture.tenant.sourceActors[0],
      secondSourceInput,
    );
    await expect(
      registerTransformVersion(
        fixture.tenant.sourceActors[0],
        {
          ...fixture.input,
          migrationSourceId: secondSourceId,
          versionNo: 2,
          repairOfTransformId: originalId,
          rationale: "Attempted cross-source repair",
        },
        fixture.store,
        fixture.registry,
      ),
    ).rejects.toMatchObject({ code: "TRANSFORM_REPAIR_NOT_FOUND", status: 404 });
  });
});

describe("atomic authority transition groups", () => {
  it("switches the exact signed three-BU inventory atomically with durable evidence", async () => {
    const fixture = await seedCutoverFixture();
    const before = Date.now();

    const result = await transitionSourceAuthorityGroup(
      fixture.tenant.authorityActor,
      fixture.input,
      fixture.verifier,
    );

    const after = Date.now();
    expect(result).toMatchObject({
      cutoverGroupId: fixture.input.cutoverGroupId,
      replayed: false,
    });
    expect(result.transitionIds).toHaveLength(3);
    expect(new Set(result.transitionIds).size).toBe(3);
    expect(result.effectiveAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(result.effectiveAt.getTime()).toBeLessThanOrEqual(after);

    const [group] = await sql<{
      group_size: number;
      group_sha256: Buffer;
      plan_artifact_ref: string;
      plan_sha256: Buffer;
      effective_at: Date;
      approved_by_membership_id: string;
    }[]>`
      select group_size, group_sha256, plan_artifact_ref, plan_sha256,
             effective_at, approved_by_membership_id
      from source_authority_transition_groups
      where organization_id = ${fixture.tenant.organizationId}
        and id = ${fixture.input.cutoverGroupId}
    `;
    expect(group).toMatchObject({
      group_size: 3,
      plan_artifact_ref: fixture.input.planArtifactRef,
      approved_by_membership_id: fixture.tenant.orgWideMembershipId,
    });
    expect(Buffer.from(group!.group_sha256)).toEqual(
      canonicalGroupDigest(fixture.tenant.organizationId, fixture.input),
    );
    expect(Buffer.from(group!.plan_sha256)).toEqual(fixture.input.expectedPlanSha256);
    expect(group?.effective_at.toISOString()).toBe(result.effectiveAt.toISOString());

    const transitions = await sql<{
      id: string;
      domain_authority_id: string;
      from_state: string;
      to_state: string;
      final_batch_id: string;
      final_cutoff_at: Date;
    }[]>`
      select id, domain_authority_id, from_state, to_state,
             final_batch_id, final_cutoff_at
      from source_authority_transitions
      where organization_id = ${fixture.tenant.organizationId}
        and transition_group_id = ${fixture.input.cutoverGroupId}
      order by domain_authority_id
    `;
    expect(transitions).toHaveLength(3);
    expect(transitions.map((transition) => transition.id).sort()).toEqual(
      [...result.transitionIds].sort(),
    );
    for (const transition of transitions) {
      const source = fixture.sources.find(
        (candidate) => candidate.authorityId === transition.domain_authority_id,
      )!;
      expect(transition.from_state).toBe("SHADOW_READ");
      expect(transition.to_state).toBe("CANONICAL_WRITABLE");
      expect(transition.final_batch_id).toBe(source.finalBatchId);
      expect(transition.final_cutoff_at.toISOString()).toBe(source.cutoffAt.toISOString());
    }

    const heads = await sql<{
      id: string;
      authority_state: string;
      authority_source_scope_id: string | null;
    }[]>`
      select id, authority_state, authority_source_scope_id
      from migration_domain_authorities
      where organization_id = ${fixture.tenant.organizationId}
      order by id
    `;
    expect(heads).toHaveLength(3);
    expect(
      heads.every(
        (head) =>
          head.authority_state === "CANONICAL_WRITABLE" &&
          head.authority_source_scope_id === null,
      ),
    ).toBe(true);
    const scopes = await sql<{ source_status: string }[]>`
      select source_status from migration_source_scopes
      where organization_id = ${fixture.tenant.organizationId}
    `;
    expect(scopes.every((scope) => scope.source_status === "ARCHIVED_READ_ONLY")).toBe(true);
    const sources = await sql<{ status: string }[]>`
      select status from migration_sources where organization_id = ${fixture.tenant.organizationId}
    `;
    expect(sources.every((source) => source.status === "ARCHIVED_READ_ONLY")).toBe(true);

    const audit = await sql<{
      actor_type: string;
      actor_user_id: string;
      action: string;
      target_id: string;
      correlation_id: string;
      change_summary: Record<string, unknown>;
    }[]>`
      select actor_type, actor_user_id, action, target_id, correlation_id, change_summary
      from audit_events
      where organization_id = ${fixture.tenant.organizationId}
        and target_id = ${fixture.input.cutoverGroupId}
    `;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actor_type: "USER",
      actor_user_id: fixture.tenant.orgWideUserId,
      action: "MIGRATION_AUTHORITY_SWITCHED",
      target_id: fixture.input.cutoverGroupId,
      correlation_id: fixture.input.cutoverGroupId,
    });
    const outbox = await sql<{
      event_version: number;
      actor_type: string;
      actor_user_id: string;
      event_type: string;
      aggregate_id: string;
      correlation_id: string;
      payload: Record<string, unknown>;
    }[]>`
      select event_version, actor_type, actor_user_id, event_type,
             aggregate_id, correlation_id, payload
      from outbox_events
      where organization_id = ${fixture.tenant.organizationId}
        and aggregate_id = ${fixture.input.cutoverGroupId}
    `;
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({
      event_version: 1,
      actor_type: "USER",
      actor_user_id: fixture.tenant.orgWideUserId,
      event_type: "crm.migration.authority_switched",
      aggregate_id: fixture.input.cutoverGroupId,
      correlation_id: fixture.input.cutoverGroupId,
    });
    const memberSummary = fixture.plan.requiredMembers
      .map((member) => ({
        businessUnitId: member.businessUnitId,
        domainAuthorityId: member.domainAuthorityId,
        domainKey: member.domainKey,
        toState: member.toState,
      }))
      .sort((left, right) =>
        left.domainAuthorityId < right.domainAuthorityId
          ? -1
          : left.domainAuthorityId > right.domainAuthorityId
            ? 1
            : 0,
      );
    const expectedSummary = {
      schemaVersion: 1,
      cutoverGroupId: fixture.input.cutoverGroupId,
      effectiveAt: result.effectiveAt.toISOString(),
      memberCount: 3,
      members: memberSummary,
    };
    expect(audit[0]!.change_summary).toEqual(expectedSummary);
    expect(outbox[0]!.payload).toEqual(expectedSummary);
    expect(JSON.stringify(audit)).not.toContain(fixture.input.planArtifactRef);
    expect(JSON.stringify(outbox)).not.toContain(fixture.input.planArtifactRef);

    for (const source of fixture.sources) {
      const [head] = await sql<{ authority_state: string }[]>`
        select authority_state from migration_domain_authorities where id = ${source.authorityId}
      `;
      expect(head?.authority_state).toBe("CANONICAL_WRITABLE");
    }
  });

  it("derives SERVICE audit and outbox actor type from the locked database identity", async () => {
    const fixture = await seedCutoverFixture();
    const serviceUserId = randomUUID();
    const serviceMembershipId = randomUUID();
    await sql`
      insert into users (id, auth_subject, display_name, user_type, status)
      values (
        ${serviceUserId}, ${`service:${serviceUserId}`},
        'Migration Cutover Service', 'SERVICE', 'ACTIVE'
      )
    `;
    await sql`
      insert into memberships (
        id, organization_id, business_unit_id, user_id, status, valid_from, valid_until
      ) values (
        ${serviceMembershipId}, ${fixture.tenant.organizationId}, null,
        ${serviceUserId}, 'ACTIVE', clock_timestamp() - interval '1 day', null
      )
    `;
    const [authorityRole] = await sql<{ role_id: string }[]>`
      select role_id from membership_roles
      where organization_id = ${fixture.tenant.organizationId}
        and membership_id = ${fixture.tenant.orgWideMembershipId}
    `;
    await sql`
      insert into membership_roles (organization_id, membership_id, role_id, valid_from)
      values (
        ${fixture.tenant.organizationId}, ${serviceMembershipId},
        ${authorityRole!.role_id}, clock_timestamp() - interval '1 day'
      )
    `;
    const serviceActor: MigrationActor = {
      userId: serviceUserId,
      organizationId: fixture.tenant.organizationId,
      activeMembershipId: serviceMembershipId,
      businessUnitId: fixture.tenant.businessUnitIds[0],
      capabilities: [AUTHORITY_CAPABILITY],
    };
    await transitionSourceAuthorityGroup(serviceActor, fixture.input, fixture.verifier);
    const [evidence] = await sql<{
      audit_actor_type: string;
      audit_actor_user_id: string;
      outbox_actor_type: string;
      outbox_actor_user_id: string;
    }[]>`
      select
        (select actor_type from audit_events
         where organization_id = ${fixture.tenant.organizationId}
           and target_id = ${fixture.input.cutoverGroupId}) as audit_actor_type,
        (select actor_user_id from audit_events
         where organization_id = ${fixture.tenant.organizationId}
           and target_id = ${fixture.input.cutoverGroupId}) as audit_actor_user_id,
        (select actor_type from outbox_events
         where organization_id = ${fixture.tenant.organizationId}
           and aggregate_id = ${fixture.input.cutoverGroupId}) as outbox_actor_type,
        (select actor_user_id from outbox_events
         where organization_id = ${fixture.tenant.organizationId}
           and aggregate_id = ${fixture.input.cutoverGroupId}) as outbox_actor_user_id
    `;
    expect(evidence).toEqual({
      audit_actor_type: "SERVICE",
      audit_actor_user_id: serviceUserId,
      outbox_actor_type: "SERVICE",
      outbox_actor_user_id: serviceUserId,
    });
  });

  it("supports an exact signed legacy-to-shadow group without final-batch evidence", async () => {
    const fixture = await seedCutoverFixture();
    await sql`
      update migration_domain_authorities
      set authority_state = 'LEGACY_WRITABLE'
      where organization_id = ${fixture.tenant.organizationId}
    `;
    const input: AuthorityTransitionGroupInput = {
      ...fixture.input,
      cutoverGroupId: randomUUID(),
      idempotencyKey: `shadow-${randomUUID()}`,
      members: fixture.sources.map((source) => ({
        domainAuthorityId: source.authorityId,
        toState: "SHADOW_READ" as const,
        writeFrozenAt: null,
        finalBatchId: null,
        expectedVersion: 2,
      })),
    };
    const plan: VerifiedAuthorityTransitionPlan = {
      ...fixture.plan,
      requiredMembers: fixture.sources.map((source) => ({
        businessUnitId: source.businessUnitId,
        domainAuthorityId: source.authorityId,
        domainKey: source.domainKey,
        toState: "SHADOW_READ" as const,
        writeFrozenAt: null,
        finalBatchId: null,
      })),
    };

    await expect(
      transitionSourceAuthorityGroup(
        fixture.tenant.authorityActor,
        input,
        verifierFor(plan),
      ),
    ).resolves.toMatchObject({ replayed: false });

    const heads = await sql<{ authority_state: string; authority_source_scope_id: string }[]>`
      select authority_state, authority_source_scope_id
      from migration_domain_authorities
      where organization_id = ${fixture.tenant.organizationId}
    `;
    expect(heads.every((head) => head.authority_state === "SHADOW_READ")).toBe(true);
    expect(heads.every((head) => head.authority_source_scope_id !== null)).toBe(true);
  });

  it("coordinates mixed one-time and recurring sources from source authority into shadow read", async () => {
    const fixture = await seedCutoverFixture({
      sourceModes: [
        "ONE_TIME_MIGRATION",
        "RECURRING_READ_ONLY_SNAPSHOT",
        "RECURRING_READ_ONLY_SNAPSHOT",
      ],
      sourceKinds: ["TASHA_SQLITE", "NIAGAWAN_CSV", "BARAKAH_SHEET"],
    });
    await sql`
      update migration_domain_authorities authority
      set authority_state = case
        when source.source_mode = 'ONE_TIME_MIGRATION' then 'LEGACY_WRITABLE'
        else 'EXTERNAL_SYSTEM_AUTHORITY'
      end
      from migration_source_scopes scope
      join migration_sources source
        on source.organization_id = scope.organization_id
       and source.business_unit_id = scope.business_unit_id
       and source.id = scope.migration_source_id
      where authority.organization_id = ${fixture.tenant.organizationId}
        and authority.authority_source_scope_id = scope.id
    `;
    const planArtifactRef = protectedRef("mixed-shadow-plan");
    const planSha256 = sha256(`mixed-shadow-plan:${planArtifactRef}`);
    const input: AuthorityTransitionGroupInput = {
      ...fixture.input,
      cutoverGroupId: randomUUID(),
      idempotencyKey: `mixed-shadow-${randomUUID()}`,
      planArtifactRef,
      expectedPlanSha256: planSha256,
      members: fixture.sources.map((source) => ({
        domainAuthorityId: source.authorityId,
        toState: "SHADOW_READ" as const,
        writeFrozenAt: null,
        finalBatchId: null,
        expectedVersion: 2,
      })),
    };
    const plan: VerifiedAuthorityTransitionPlan = {
      ...fixture.plan,
      artifactRef: planArtifactRef,
      planSha256,
      requiredMembers: fixture.sources.map((source) => ({
        businessUnitId: source.businessUnitId,
        domainAuthorityId: source.authorityId,
        domainKey: source.domainKey,
        toState: "SHADOW_READ" as const,
        writeFrozenAt: null,
        finalBatchId: null,
      })),
    };
    await expect(
      transitionSourceAuthorityGroup(
        fixture.tenant.authorityActor,
        input,
        verifierFor(plan),
      ),
    ).resolves.toMatchObject({ replayed: false });
    const heads = await sql<{ authority_state: string }[]>`
      select authority_state from migration_domain_authorities
      where organization_id = ${fixture.tenant.organizationId}
    `;
    expect(heads.every((head) => head.authority_state === "SHADOW_READ")).toBe(true);
  });

  it("coordinates mixed one-time and recurring shadow sources into canonical authority", async () => {
    const fixture = await seedCutoverFixture({
      sourceModes: [
        "ONE_TIME_MIGRATION",
        "RECURRING_READ_ONLY_SNAPSHOT",
        "RECURRING_READ_ONLY_SNAPSHOT",
      ],
      sourceKinds: ["TASHA_SQLITE", "NIAGAWAN_CSV", "BARAKAH_SHEET"],
    });
    await expect(
      transitionSourceAuthorityGroup(
        fixture.tenant.authorityActor,
        fixture.input,
        fixture.verifier,
      ),
    ).resolves.toMatchObject({ replayed: false });
    const sources = await sql<{ source_kind: string; source_mode: string; status: string }[]>`
      select source_kind, source_mode, status from migration_sources
      where organization_id = ${fixture.tenant.organizationId}
      order by source_kind
    `;
    expect(sources).toHaveLength(3);
    expect(sources.filter((source) => source.source_mode === "RECURRING_READ_ONLY_SNAPSHOT"))
      .toHaveLength(2);
    expect(sources.every((source) => source.status === "ARCHIVED_READ_ONLY")).toBe(true);
  });

  it("rejects no-op and regressive authority transitions through lifecycle policy", async () => {
    for (const toState of ["SHADOW_READ", "LEGACY_WRITABLE"] as const) {
      const fixture = await seedCutoverFixture();
      const input: AuthorityTransitionGroupInput = {
        ...fixture.input,
        members: fixture.sources.map((source) => ({
          domainAuthorityId: source.authorityId,
          toState,
          writeFrozenAt: null,
          finalBatchId: null,
          expectedVersion: 1,
        })),
      };
      const plan: VerifiedAuthorityTransitionPlan = {
        ...fixture.plan,
        requiredMembers: fixture.sources.map((source) => ({
          businessUnitId: source.businessUnitId,
          domainAuthorityId: source.authorityId,
          domainKey: source.domainKey,
          toState,
          writeFrozenAt: null,
          finalBatchId: null,
        })),
      };
      await expect(
        transitionSourceAuthorityGroup(
          fixture.tenant.authorityActor,
          input,
          verifierFor(plan),
        ),
        toState,
      ).rejects.toMatchObject({ code: "AUTHORITY_TRANSITION_INVALID", status: 409 });
    }
  });

  it("rejects missing, extra, duplicate, and same-count-wrong signed member sets", async () => {
    const cases: readonly (
      | "missing-caller"
      | "missing-plan"
      | "duplicate-caller"
      | "wrong-plan-member"
    )[] = ["missing-caller", "missing-plan", "duplicate-caller", "wrong-plan-member"];
    for (const scenario of cases) {
      const fixture = await seedCutoverFixture();
      let input = fixture.input;
      let plan = fixture.plan;
      if (scenario === "missing-caller") {
        input = { ...input, members: input.members.slice(1) };
      } else if (scenario === "missing-plan") {
        plan = { ...plan, requiredMembers: plan.requiredMembers.slice(1) };
      } else if (scenario === "duplicate-caller") {
        input = { ...input, members: [...input.members, input.members[0]!] };
      } else {
        plan = {
          ...plan,
          requiredMembers: [
            { ...plan.requiredMembers[0]!, domainAuthorityId: randomUUID() },
            ...plan.requiredMembers.slice(1),
          ],
        };
      }
      await expect(
        transitionSourceAuthorityGroup(
          fixture.tenant.authorityActor,
          input,
          verifierFor(plan),
        ),
        scenario,
      ).rejects.toMatchObject({ status: 422 });
      const [countRow] = await sql<{ count: number }[]>`
        select count(*)::int as count from source_authority_transition_groups
        where organization_id = ${fixture.tenant.organizationId}
      `;
      expect(countRow?.count).toBe(0);
    }
  });

  it("rejects a signed caller subset when an extra noncanonical durable head exists", async () => {
    const fixture = await seedCutoverFixture();
    await registerMigrationSource(
      fixture.tenant.sourceActors[0],
      validSourceInput(fixture.tenant, 0),
    );
    await expect(
      transitionSourceAuthorityGroup(
        fixture.tenant.authorityActor,
        fixture.input,
        fixture.verifier,
      ),
    ).rejects.toMatchObject({ code: "AUTHORITY_INVENTORY_MISMATCH", status: 409 });
  });

  it("rejects an unexpected fourth-business-unit noncanonical head", async () => {
    const fixture = await seedCutoverFixture();
    const businessUnitId = randomUUID();
    const sourceId = randomUUID();
    const scopeId = randomUUID();
    await sql`
      insert into business_units (id, organization_id, code, name)
      values (
        ${businessUnitId}, ${fixture.tenant.organizationId},
        ${`fourth-${businessUnitId}`}, 'Unexpected Fourth Business'
      )
    `;
    await sql`
      insert into migration_sources (
        id, organization_id, business_unit_id, source_key, source_kind,
        source_mode, owner_membership_id, status
      ) values (
        ${sourceId}, ${fixture.tenant.organizationId}, ${businessUnitId},
        ${`source-${sourceId}`}, 'SALAM_CRM_JSON', 'ONE_TIME_MIGRATION',
        ${fixture.tenant.orgWideMembershipId}, 'ACTIVE'
      )
    `;
    await sql`
      insert into migration_source_scopes (
        id, organization_id, business_unit_id, migration_source_id, domain_key,
        canonical_target, transition_mode, source_status
      ) values (
        ${scopeId}, ${fixture.tenant.organizationId}, ${businessUnitId}, ${sourceId},
        'sales.unexpected_fourth', 'crm.canonical', 'ONE_TIME_CUTOVER', 'ACTIVE_AUTHORITY'
      )
    `;
    await sql`
      insert into migration_domain_authorities (
        organization_id, business_unit_id, domain_key, canonical_target,
        authority_state, authority_source_scope_id
      ) values (
        ${fixture.tenant.organizationId}, ${businessUnitId}, 'sales.unexpected_fourth',
        'crm.canonical', 'SHADOW_READ', ${scopeId}
      )
    `;
    await expect(
      transitionSourceAuthorityGroup(
        fixture.tenant.authorityActor,
        fixture.input,
        fixture.verifier,
      ),
    ).rejects.toMatchObject({ code: "AUTHORITY_INVENTORY_MISMATCH", status: 409 });
  });

  it("excludes already-terminal canonical heads from the signed noncanonical inventory", async () => {
    const fixture = await seedCutoverFixture();
    await sql`
      insert into migration_domain_authorities (
        organization_id, business_unit_id, domain_key, canonical_target,
        authority_state, authority_source_scope_id
      ) values (
        ${fixture.tenant.organizationId}, ${fixture.tenant.businessUnitIds[0]},
        'sales.already_terminal', 'crm.canonical', 'CANONICAL_WRITABLE', null
      )
    `;
    await expect(
      transitionSourceAuthorityGroup(
        fixture.tenant.authorityActor,
        fixture.input,
        fixture.verifier,
      ),
    ).resolves.toMatchObject({ replayed: false });
    const heads = await sql<{ authority_state: string }[]>`
      select authority_state from migration_domain_authorities
      where organization_id = ${fixture.tenant.organizationId}
    `;
    expect(heads).toHaveLength(4);
    expect(heads.every((head) => head.authority_state === "CANONICAL_WRITABLE")).toBe(true);
  });

  it("rejects safe verifier ref, digest, and tenant substitution", async () => {
    const cases = [
      (fixture: CutoverFixture) => ({ ...fixture.plan, artifactRef: protectedRef("other-plan") }),
      (fixture: CutoverFixture) => ({ ...fixture.plan, planSha256: sha256("other-plan") }),
      (fixture: CutoverFixture) => ({ ...fixture.plan, organizationId: randomUUID() }),
    ] as const;
    for (const mutate of cases) {
      const fixture = await seedCutoverFixture();
      await expect(
        transitionSourceAuthorityGroup(
          fixture.tenant.authorityActor,
          fixture.input,
          verifierFor(mutate(fixture)),
        ),
      ).rejects.toMatchObject({ code: "AUTHORITY_PLAN_INVALID", status: 422 });
    }
  });

  it("rejects every unsafe inbound or verifier-returned plan reference and sanitizes provider errors", async () => {
    for (const ref of unsafeProtectedReferences) {
      const inbound = syntheticGroupContract();
      let verifierCalled = false;
      await expect(
        transitionSourceAuthorityGroup(
          inbound.actor,
          { ...inbound.input, planArtifactRef: ref },
          {
            async verify() {
              verifierCalled = true;
              return inbound.plan;
            },
          },
        ),
        `inbound plan ref: ${JSON.stringify(ref)}`,
      ).rejects.toMatchObject({ code: "PROTECTED_ARTIFACT_REF_INVALID", status: 422 });
      expect(verifierCalled).toBe(false);

      const returned = syntheticGroupContract();
      await expect(
        transitionSourceAuthorityGroup(
          returned.actor,
          returned.input,
          verifierFor({ ...returned.plan, artifactRef: ref }),
        ),
        `returned plan ref: ${JSON.stringify(ref)}`,
      ).rejects.toMatchObject({ code: "PROTECTED_ARTIFACT_REF_INVALID", status: 422 });
    }

    const providerFailure = syntheticGroupContract();
    const secret = "PLAN_PROVIDER_SECRET_DETAIL";
    let error: unknown;
    try {
      await transitionSourceAuthorityGroup(
        providerFailure.actor,
        providerFailure.input,
        {
          async verify() {
            throw new Error(secret);
          },
        },
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "AUTHORITY_PLAN_VERIFICATION_FAILED", status: 422 });
    expect(String(error)).not.toContain(secret);
  });

  it("rejects malformed runtime commands before invoking the signed-plan adapter", async () => {
    const base = syntheticGroupContract();
    const cases: readonly {
      label: string;
      actor?: MigrationActor;
      input?: AuthorityTransitionGroupInput;
    }[] = [
      { label: "actor user UUID", actor: { ...base.actor, userId: "not-a-uuid" } },
      {
        label: "actor organization UUID",
        actor: { ...base.actor, organizationId: "not-a-uuid" },
      },
      {
        label: "actor membership UUID",
        actor: { ...base.actor, activeMembershipId: "not-a-uuid" },
      },
      {
        label: "actor business-unit UUID",
        actor: { ...base.actor, businessUnitId: "not-a-uuid" },
      },
      {
        label: "claimed capabilities runtime shape",
        actor: { ...base.actor, capabilities: "migration.authority_switch" as never },
      },
      {
        label: "claimed capability element runtime type",
        actor: {
          ...base.actor,
          capabilities: [AUTHORITY_CAPABILITY, 7 as never],
        },
      },
      {
        label: "group UUID",
        input: { ...base.input, cutoverGroupId: "not-a-uuid" },
      },
      {
        label: "digest length",
        input: { ...base.input, expectedPlanSha256: new Uint8Array(31) },
      },
      { label: "empty members", input: { ...base.input, members: [] } },
      { label: "members runtime type", input: { ...base.input, members: {} as never } },
      {
        label: "null member",
        input: { ...base.input, members: [null as never, ...base.input.members.slice(1)] },
      },
      {
        label: "oversized members",
        input: {
          ...base.input,
          members: Array.from({ length: 101 }, () => ({
            ...base.input.members[0]!,
            domainAuthorityId: randomUUID(),
            finalBatchId: randomUUID(),
          })),
        },
      },
      {
        label: "duplicate caller authority",
        input: { ...base.input, members: [...base.input.members, base.input.members[0]!] },
      },
      {
        label: "member authority UUID",
        input: {
          ...base.input,
          members: [
            { ...base.input.members[0]!, domainAuthorityId: "not-a-uuid" },
            ...base.input.members.slice(1),
          ],
        },
      },
      {
        label: "member final-batch UUID",
        input: {
          ...base.input,
          members: [
            { ...base.input.members[0]!, finalBatchId: "not-a-uuid" },
            ...base.input.members.slice(1),
          ],
        },
      },
      {
        label: "zero expected version",
        input: {
          ...base.input,
          members: [
            { ...base.input.members[0]!, expectedVersion: 0 },
            ...base.input.members.slice(1),
          ],
        },
      },
      {
        label: "fractional expected version",
        input: {
          ...base.input,
          members: [
            { ...base.input.members[0]!, expectedVersion: 1.5 },
            ...base.input.members.slice(1),
          ],
        },
      },
      {
        label: "unsafe expected version",
        input: {
          ...base.input,
          members: [
            { ...base.input.members[0]!, expectedVersion: Number.MAX_SAFE_INTEGER + 1 },
            ...base.input.members.slice(1),
          ],
        },
      },
      {
        label: "invalid target state",
        input: {
          ...base.input,
          members: [
            { ...base.input.members[0]!, toState: "DUAL_WRITABLE" as never },
            ...base.input.members.slice(1),
          ],
        },
      },
      {
        label: "invalid evidence date",
        input: {
          ...base.input,
          members: [
            { ...base.input.members[0]!, writeFrozenAt: new Date(Number.NaN) },
            ...base.input.members.slice(1),
          ],
        },
      },
      {
        label: "evidence date runtime type",
        input: {
          ...base.input,
          members: [
            { ...base.input.members[0]!, writeFrozenAt: "yesterday" as never },
            ...base.input.members.slice(1),
          ],
        },
      },
      {
        label: "canonical evidence missing",
        input: {
          ...base.input,
          members: [
            { ...base.input.members[0]!, writeFrozenAt: null, finalBatchId: null },
            ...base.input.members.slice(1),
          ],
        },
      },
      { label: "blank reason", input: { ...base.input, approvalReason: "   " } },
      {
        label: "oversized reason",
        input: { ...base.input, approvalReason: "x".repeat(2_001) },
      },
      {
        label: "blank idempotency key",
        input: { ...base.input, idempotencyKey: "   " },
      },
      {
        label: "idempotency key runtime type",
        input: { ...base.input, idempotencyKey: 42 as never },
      },
      {
        label: "oversized idempotency key",
        input: { ...base.input, idempotencyKey: "x".repeat(256) },
      },
    ];

    for (const scenario of cases) {
      let verifierCalled = false;
      await expect(
        transitionSourceAuthorityGroup(
          scenario.actor ?? base.actor,
          scenario.input ?? base.input,
          {
            async verify() {
              verifierCalled = true;
              return base.plan;
            },
          },
        ),
        scenario.label,
      ).rejects.toMatchObject({ status: 422 });
      expect(verifierCalled, scenario.label).toBe(false);
    }
  });

  it("rejects a missing trusted authority claim before invoking the signed-plan adapter", async () => {
    const fixture = syntheticGroupContract();
    let verifierCalled = false;
    await expect(
      transitionSourceAuthorityGroup(
        { ...fixture.actor, capabilities: [SOURCE_CAPABILITY] },
        fixture.input,
        {
          async verify() {
            verifierCalled = true;
            return fixture.plan;
          },
        },
      ),
    ).rejects.toMatchObject({
      code: "MIGRATION_CAPABILITY_REQUIRED",
      status: 403,
    });
    expect(verifierCalled).toBe(false);
  });

  it("rejects malformed runtime verifier envelopes before any database mutation", async () => {
    const cases: readonly {
      label: string;
      mutate: (plan: VerifiedAuthorityTransitionPlan) => unknown;
    }[] = [
      { label: "null envelope", mutate: () => null },
      { label: "artifact digest", mutate: (plan) => ({ ...plan, planSha256: new Uint8Array(31) }) },
      { label: "organization UUID", mutate: (plan) => ({ ...plan, organizationId: "bad" }) },
      { label: "notBefore type", mutate: (plan) => ({ ...plan, notBefore: "tomorrow" }) },
      { label: "expiresAt invalid", mutate: (plan) => ({ ...plan, expiresAt: new Date(Number.NaN) }) },
      { label: "members type", mutate: (plan) => ({ ...plan, requiredMembers: {} }) },
      {
        label: "oversized verifier members",
        mutate: (plan) => ({
          ...plan,
          requiredMembers: Array.from({ length: 101 }, (_, index) => ({
            ...plan.requiredMembers[0]!,
            businessUnitId: randomUUID(),
            domainAuthorityId: randomUUID(),
            domainKey: `sales.verifier_${index}`,
            finalBatchId: randomUUID(),
          })),
        }),
      },
      {
        label: "member authority UUID",
        mutate: (plan) => ({
          ...plan,
          requiredMembers: [
            { ...plan.requiredMembers[0]!, domainAuthorityId: "bad" },
            ...plan.requiredMembers.slice(1),
          ],
        }),
      },
      {
        label: "member business-unit UUID",
        mutate: (plan) => ({
          ...plan,
          requiredMembers: [
            { ...plan.requiredMembers[0]!, businessUnitId: "bad" },
            ...plan.requiredMembers.slice(1),
          ],
        }),
      },
      {
        label: "member domain format",
        mutate: (plan) => ({
          ...plan,
          requiredMembers: [
            { ...plan.requiredMembers[0]!, domainKey: "../unsafe" },
            ...plan.requiredMembers.slice(1),
          ],
        }),
      },
      {
        label: "member target state",
        mutate: (plan) => ({
          ...plan,
          requiredMembers: [
            { ...plan.requiredMembers[0]!, toState: "DUAL_WRITABLE" },
            ...plan.requiredMembers.slice(1),
          ],
        }),
      },
      {
        label: "member evidence date",
        mutate: (plan) => ({
          ...plan,
          requiredMembers: [
            { ...plan.requiredMembers[0]!, writeFrozenAt: new Date(Number.NaN) },
            ...plan.requiredMembers.slice(1),
          ],
        }),
      },
      {
        label: "member final-batch runtime type",
        mutate: (plan) => ({
          ...plan,
          requiredMembers: [
            { ...plan.requiredMembers[0]!, finalBatchId: 42 },
            ...plan.requiredMembers.slice(1),
          ],
        }),
      },
      {
        label: "canonical member missing evidence",
        mutate: (plan) => ({
          ...plan,
          requiredMembers: [
            { ...plan.requiredMembers[0]!, writeFrozenAt: null, finalBatchId: null },
            ...plan.requiredMembers.slice(1),
          ],
        }),
      },
    ];
    for (const scenario of cases) {
      const fixture = syntheticGroupContract();
      let verifierCalled = false;
      await expect(
        transitionSourceAuthorityGroup(fixture.actor, fixture.input, {
          async verify() {
            verifierCalled = true;
            return scenario.mutate(fixture.plan) as VerifiedAuthorityTransitionPlan;
          },
        }),
        scenario.label,
      ).rejects.toMatchObject({ status: 422 });
      expect(verifierCalled, scenario.label).toBe(true);
    }
  });

  it("binds target state, freeze timestamp, and final batch to the exact signed member", async () => {
    const mutations = [
      {
        label: "target state",
        mutate: (member: VerifiedAuthorityTransitionPlan["requiredMembers"][number]) => ({
          ...member,
          toState: "SHADOW_READ" as const,
          writeFrozenAt: null,
          finalBatchId: null,
        }),
      },
      {
        label: "write freeze",
        mutate: (member: VerifiedAuthorityTransitionPlan["requiredMembers"][number]) => ({
          ...member,
          writeFrozenAt: new Date(member.writeFrozenAt!.getTime() - 1),
        }),
      },
      {
        label: "final batch",
        mutate: (member: VerifiedAuthorityTransitionPlan["requiredMembers"][number]) => ({
          ...member,
          finalBatchId: randomUUID(),
        }),
      },
    ] as const;
    for (const mutation of mutations) {
      const fixture = await seedCutoverFixture();
      const plan = {
        ...fixture.plan,
        requiredMembers: fixture.plan.requiredMembers.map((member, index) =>
          index === 0 ? mutation.mutate(member) : member,
        ),
      };
      await expect(
        transitionSourceAuthorityGroup(
          fixture.tenant.authorityActor,
          fixture.input,
          verifierFor(plan),
        ),
        mutation.label,
      ).rejects.toMatchObject({ code: "AUTHORITY_PLAN_INVALID", status: 422 });
      const [countRow] = await sql<{ count: number }[]>`
        select count(*)::int as count from source_authority_transition_groups
        where organization_id = ${fixture.tenant.organizationId}
      `;
      expect(countRow?.count, mutation.label).toBe(0);
    }
  });

  it("rejects verifier members duplicated by authority ID or business-unit/domain tuple", async () => {
    for (const duplicateKind of ["authority", "business-unit-domain"] as const) {
      const fixture = await seedCutoverFixture();
      const plan = {
        ...fixture.plan,
        requiredMembers:
          duplicateKind === "authority"
            ? [...fixture.plan.requiredMembers, fixture.plan.requiredMembers[0]!]
            : fixture.plan.requiredMembers.map((member, index) =>
                index === 1
                  ? {
                      ...member,
                      businessUnitId: fixture.plan.requiredMembers[0]!.businessUnitId,
                      domainKey: fixture.plan.requiredMembers[0]!.domainKey,
                    }
                  : member,
              ),
      };
      await expect(
        transitionSourceAuthorityGroup(
          fixture.tenant.authorityActor,
          fixture.input,
          verifierFor(plan),
        ),
        duplicateKind,
      ).rejects.toMatchObject({ code: "AUTHORITY_PLAN_INVALID", status: 422 });
      const [countRow] = await sql<{ count: number }[]>`
        select count(*)::int as count from source_authority_transition_groups
        where organization_id = ${fixture.tenant.organizationId}
      `;
      expect(countRow?.count, duplicateKind).toBe(0);
    }
  });

  it("rejects a signed member whose business-unit or domain identity differs from the locked head", async () => {
    for (const field of ["businessUnitId", "domainKey"] as const) {
      const fixture = await seedCutoverFixture();
      const badPlan = {
        ...fixture.plan,
        requiredMembers: fixture.plan.requiredMembers.map((member, index) =>
          index === 0
            ? {
                ...member,
                [field]: field === "businessUnitId" ? randomUUID() : "sales.wrong_domain",
              }
            : member,
        ),
      };
      await expect(
        transitionSourceAuthorityGroup(
          fixture.tenant.authorityActor,
          fixture.input,
          verifierFor(badPlan),
        ),
        field,
      ).rejects.toMatchObject({ code: "AUTHORITY_PLAN_MEMBER_MISMATCH", status: 409 });
    }
  });

  it("rejects future, expired, and inverted signed execution windows", async () => {
    const future = await seedCutoverFixture();
    const futurePlan = {
      ...future.plan,
      notBefore: new Date(Date.now() + 60_000),
      expiresAt: new Date(Date.now() + 120_000),
    };
    await expect(
      transitionSourceAuthorityGroup(
        future.tenant.authorityActor,
        future.input,
        verifierFor(futurePlan),
      ),
    ).rejects.toMatchObject({ code: "AUTHORITY_WINDOW_CLOSED", status: 409 });

    const expired = await seedCutoverFixture();
    const expiredPlan = {
      ...expired.plan,
      notBefore: new Date(Date.now() - 120_000),
      expiresAt: new Date(Date.now() - 60_000),
    };
    await expect(
      transitionSourceAuthorityGroup(
        expired.tenant.authorityActor,
        expired.input,
        verifierFor(expiredPlan),
      ),
    ).rejects.toMatchObject({ code: "AUTHORITY_WINDOW_CLOSED", status: 409 });

    const inverted = await seedCutoverFixture();
    const invertedPlan = {
      ...inverted.plan,
      notBefore: new Date(Date.now() + 60_000),
      expiresAt: new Date(Date.now() - 60_000),
    };
    await expect(
      transitionSourceAuthorityGroup(
        inverted.tenant.authorityActor,
        inverted.input,
        verifierFor(invertedPlan),
      ),
    ).rejects.toMatchObject({ code: "AUTHORITY_PLAN_INVALID", status: 422 });

    const closedBoundary = await seedCutoverFixture();
    const exactBoundary = new Date(Date.now() - 60_000);
    await expect(
      transitionSourceAuthorityGroup(
        closedBoundary.tenant.authorityActor,
        closedBoundary.input,
        verifierFor({
          ...closedBoundary.plan,
          notBefore: exactBoundary,
          expiresAt: exactBoundary,
        }),
      ),
    ).rejects.toMatchObject({ code: "AUTHORITY_WINDOW_CLOSED", status: 409 });
  });

  it("requires a live database capability and organization-wide approver scope", async () => {
    const noCapability = await seedCutoverFixture();
    await expect(
      transitionSourceAuthorityGroup(
        noCapability.tenant.noCapabilityActor,
        noCapability.input,
        noCapability.verifier,
      ),
    ).rejects.toMatchObject({ code: "MIGRATION_CAPABILITY_REQUIRED", status: 403 });

    const scoped = await seedCutoverFixture();
    const [sourceRole] = await sql<{ role_id: string }[]>`
      select role_id from membership_roles
      where organization_id = ${scoped.tenant.organizationId}
        and membership_id = ${scoped.tenant.businessUnitMembershipIds[0]}
    `;
    await sql`
      insert into role_capabilities (organization_id, role_id, capability_key)
      values (${scoped.tenant.organizationId}, ${sourceRole!.role_id}, ${AUTHORITY_CAPABILITY})
    `;
    await expect(
      transitionSourceAuthorityGroup(
        {
          ...scoped.tenant.sourceActors[0],
          capabilities: [SOURCE_CAPABILITY, AUTHORITY_CAPABILITY],
        },
        scoped.input,
        scoped.verifier,
      ),
    ).rejects.toMatchObject({ code: "MIGRATION_SCOPE_FORBIDDEN", status: 403 });
  });

  it("rechecks authority actor identity, membership window, and joined user status", async () => {
    const wrongIdentity = await seedCutoverFixture();
    await expect(
      transitionSourceAuthorityGroup(
        { ...wrongIdentity.tenant.authorityActor, userId: randomUUID() },
        wrongIdentity.input,
        wrongIdentity.verifier,
      ),
    ).rejects.toMatchObject({ code: "MIGRATION_MEMBERSHIP_INVALID", status: 403 });

    const expired = await seedCutoverFixture();
    await sql`
      update memberships set valid_until = clock_timestamp() - interval '1 second'
      where organization_id = ${expired.tenant.organizationId}
        and id = ${expired.tenant.orgWideMembershipId}
    `;
    await expect(
      transitionSourceAuthorityGroup(
        expired.tenant.authorityActor,
        expired.input,
        expired.verifier,
      ),
    ).rejects.toMatchObject({ code: "MIGRATION_MEMBERSHIP_INVALID", status: 403 });

    const inactive = await seedCutoverFixture();
    await sql`
      update users set status = 'SUSPENDED'
      where id = ${inactive.tenant.orgWideUserId}
    `;
    await expect(
      transitionSourceAuthorityGroup(
        inactive.tenant.authorityActor,
        inactive.input,
        inactive.verifier,
      ),
    ).rejects.toMatchObject({ code: "MIGRATION_MEMBERSHIP_INVALID", status: 403 });
  });

  it("rechecks group authorization and active inventory after the verifier callback", async () => {
    const scenarios = [
      {
        label: "database capability revoked",
        mutate: async (fixture: CutoverFixture) => {
          const [role] = await sql<{ role_id: string }[]>`
            select role_id from membership_roles
            where organization_id = ${fixture.tenant.organizationId}
              and membership_id = ${fixture.tenant.orgWideMembershipId}
          `;
          await sql`
            delete from role_capabilities
            where organization_id = ${fixture.tenant.organizationId}
              and role_id = ${role!.role_id}
              and capability_key = ${AUTHORITY_CAPABILITY}
          `;
        },
        expected: { code: "MIGRATION_CAPABILITY_REQUIRED", status: 403 },
      },
      {
        label: "membership revoked",
        mutate: async (fixture: CutoverFixture) => {
          await sql`
            update memberships set status = 'REVOKED'
            where organization_id = ${fixture.tenant.organizationId}
              and id = ${fixture.tenant.orgWideMembershipId}
          `;
        },
        expected: { code: "MIGRATION_MEMBERSHIP_INVALID", status: 403 },
      },
      {
        label: "membership expired",
        mutate: async (fixture: CutoverFixture) => {
          await sql`
            update memberships set valid_until = clock_timestamp() - interval '1 second'
            where organization_id = ${fixture.tenant.organizationId}
              and id = ${fixture.tenant.orgWideMembershipId}
          `;
        },
        expected: { code: "MIGRATION_MEMBERSHIP_INVALID", status: 403 },
      },
      {
        label: "organization suspended",
        mutate: async (fixture: CutoverFixture) => {
          await sql`
            update organizations set status = 'SUSPENDED'
            where id = ${fixture.tenant.organizationId}
          `;
        },
        expected: { code: "MIGRATION_ORGANIZATION_NOT_FOUND", status: 404 },
      },
      {
        label: "inventory business unit suspended",
        mutate: async (fixture: CutoverFixture) => {
          await sql`
            update business_units set status = 'SUSPENDED'
            where organization_id = ${fixture.tenant.organizationId}
              and id = ${fixture.tenant.businessUnitIds[1]}
          `;
        },
        expected: { code: "MIGRATION_BUSINESS_UNIT_NOT_FOUND", status: 404 },
      },
    ] as const;

    for (const scenario of scenarios) {
      const fixture = await seedCutoverFixture();
      let verifierCompleted = false;
      await expect(
        transitionSourceAuthorityGroup(
          fixture.tenant.authorityActor,
          fixture.input,
          {
            async verify() {
              await scenario.mutate(fixture);
              verifierCompleted = true;
              return fixture.plan;
            },
          },
        ),
        scenario.label,
      ).rejects.toMatchObject(scenario.expected);
      expect(verifierCompleted, scenario.label).toBe(true);
      const [countRow] = await sql<{ count: number }[]>`
        select count(*)::int as count from source_authority_transition_groups
        where organization_id = ${fixture.tenant.organizationId}
      `;
      expect(countRow?.count, scenario.label).toBe(0);
    }
  });

  it("rejects stale expected versions and cross-tenant final-batch references", async () => {
    const stale = await seedCutoverFixture();
    const staleInput = {
      ...stale.input,
      members: stale.input.members.map((member, index) =>
        index === 0 ? { ...member, expectedVersion: 99 } : member,
      ),
    };
    await expect(
      transitionSourceAuthorityGroup(
        stale.tenant.authorityActor,
        staleInput,
        stale.verifier,
      ),
    ).rejects.toMatchObject({ code: "AUTHORITY_VERSION_CONFLICT", status: 409 });

    const crossTenant = await seedCutoverFixture();
    const other = await seedCutoverFixture();
    const victimId = crossTenant.input.members[0]!.domainAuthorityId;
    const foreignBatchId = other.sources[0].finalBatchId;
    const badInput = {
      ...crossTenant.input,
      members: crossTenant.input.members.map((member) =>
        member.domainAuthorityId === victimId
          ? { ...member, finalBatchId: foreignBatchId }
          : member,
      ),
    };
    const badPlan = {
      ...crossTenant.plan,
      requiredMembers: crossTenant.plan.requiredMembers.map((member) =>
        member.domainAuthorityId === victimId
          ? { ...member, finalBatchId: foreignBatchId }
          : member,
      ),
    };
    await expect(
      transitionSourceAuthorityGroup(
        crossTenant.tenant.authorityActor,
        badInput,
        verifierFor(badPlan),
      ),
    ).rejects.toMatchObject({ code: "AUTHORITY_EVIDENCE_INVALID", status: 409 });
  });

  it("requires signed RECONCILED evidence and derives cutoff instead of trusting intent", async () => {
    const unsigned = await seedCutoverFixture({ signedIndex: 1 });
    await expect(
      transitionSourceAuthorityGroup(
        unsigned.tenant.authorityActor,
        unsigned.input,
        unsigned.verifier,
      ),
    ).rejects.toMatchObject({ code: "AUTHORITY_EVIDENCE_INVALID", status: 409 });

    const badFreeze = await seedCutoverFixture();
    const authorityId = badFreeze.sources[0].authorityId;
    const afterCutoff = new Date(badFreeze.sources[0].cutoffAt.getTime() + 1_000);
    const input = {
      ...badFreeze.input,
      members: badFreeze.input.members.map((member) =>
        member.domainAuthorityId === authorityId
          ? { ...member, writeFrozenAt: afterCutoff }
          : member,
      ),
    };
    const plan = {
      ...badFreeze.plan,
      requiredMembers: badFreeze.plan.requiredMembers.map((member) =>
        member.domainAuthorityId === authorityId
          ? { ...member, writeFrozenAt: afterCutoff }
          : member,
      ),
    };
    await expect(
      transitionSourceAuthorityGroup(
        badFreeze.tenant.authorityActor,
        input,
        verifierFor(plan),
      ),
    ).rejects.toMatchObject({ code: "AUTHORITY_EVIDENCE_INVALID", status: 409 });
  });

  it("rejects a selected final-batch cutoff later than the server effective time", async () => {
    const fixture = await seedCutoverFixture({ cutoffAt: new Date(Date.now() + 60_000) });
    await expect(
      transitionSourceAuthorityGroup(
        fixture.tenant.authorityActor,
        fixture.input,
        fixture.verifier,
      ),
    ).rejects.toMatchObject({ code: "AUTHORITY_EVIDENCE_INVALID", status: 409 });
  });

  it("requires a SIGNED reconciliation run for the exact selected final batch", async () => {
    const fixture = await seedCutoverFixture({ signedIndex: 0, unsignedPassedIndex: 0 });
    const source = fixture.sources[0];
    await insertReconciledBatch(
      sql,
      fixture.tenant,
      0,
      source.sourceId,
      source.transformId,
      { cutoffAt: new Date(source.cutoffAt.getTime() - 10_000), signed: true },
    );
    await expect(
      transitionSourceAuthorityGroup(
        fixture.tenant.authorityActor,
        fixture.input,
        fixture.verifier,
      ),
    ).rejects.toMatchObject({ code: "AUTHORITY_EVIDENCE_INVALID", status: 409 });
  });

  it("rejects dry-run and wrong-source final batches even when the signed plan repeats them", async () => {
    const dry = await seedCutoverFixture();
    const source = dry.sources[0];
    const [liveBatch] = await sql<{ validated_dry_run_batch_id: string }[]>`
      select validated_dry_run_batch_id from import_batches
      where organization_id = ${dry.tenant.organizationId} and id = ${source.finalBatchId}
    `;
    const dryBatchId = liveBatch!.validated_dry_run_batch_id;
    const dryInput = {
      ...dry.input,
      members: dry.input.members.map((member) =>
        member.domainAuthorityId === source.authorityId
          ? { ...member, finalBatchId: dryBatchId }
          : member,
      ),
    };
    const dryPlan = {
      ...dry.plan,
      requiredMembers: dry.plan.requiredMembers.map((member) =>
        member.domainAuthorityId === source.authorityId
          ? { ...member, finalBatchId: dryBatchId }
          : member,
      ),
    };
    await expect(
      transitionSourceAuthorityGroup(
        dry.tenant.authorityActor,
        dryInput,
        verifierFor(dryPlan),
      ),
    ).rejects.toMatchObject({ code: "AUTHORITY_EVIDENCE_INVALID", status: 409 });

    const wrongSource = await seedCutoverFixture();
    const victim = wrongSource.sources[0];
    const alternateSourceId = await registerMigrationSource(
      wrongSource.tenant.sourceActors[0],
      validSourceInput(wrongSource.tenant, 0, victim.domainKey),
    );
    const alternateTransformId = await insertApprovedTransform(
      sql,
      wrongSource.tenant,
      0,
      alternateSourceId,
    );
    const alternateBatch = await insertReconciledBatch(
      sql,
      wrongSource.tenant,
      0,
      alternateSourceId,
      alternateTransformId,
      { cutoffAt: new Date(victim.cutoffAt.getTime() - 10_000) },
    );
    const otherBatchId = alternateBatch.finalBatchId;
    const otherInput = {
      ...wrongSource.input,
      members: wrongSource.input.members.map((member) =>
        member.domainAuthorityId === victim.authorityId
          ? { ...member, finalBatchId: otherBatchId }
          : member,
      ),
    };
    const otherPlan = {
      ...wrongSource.plan,
      requiredMembers: wrongSource.plan.requiredMembers.map((member) =>
        member.domainAuthorityId === victim.authorityId
          ? { ...member, finalBatchId: otherBatchId }
          : member,
      ),
    };
    await expect(
      transitionSourceAuthorityGroup(
        wrongSource.tenant.authorityActor,
        otherInput,
        verifierFor(otherPlan),
      ),
    ).rejects.toMatchObject({ code: "AUTHORITY_EVIDENCE_INVALID", status: 409 });

    const wrongBusinessUnit = await seedCutoverFixture();
    const buVictim = wrongBusinessUnit.sources[0];
    const otherBusinessUnitBatchId = wrongBusinessUnit.sources[1].finalBatchId;
    const buInput = {
      ...wrongBusinessUnit.input,
      members: wrongBusinessUnit.input.members.map((member) =>
        member.domainAuthorityId === buVictim.authorityId
          ? { ...member, finalBatchId: otherBusinessUnitBatchId }
          : member,
      ),
    };
    const buPlan = {
      ...wrongBusinessUnit.plan,
      requiredMembers: wrongBusinessUnit.plan.requiredMembers.map((member) =>
        member.domainAuthorityId === buVictim.authorityId
          ? { ...member, finalBatchId: otherBusinessUnitBatchId }
          : member,
      ),
    };
    await expect(
      transitionSourceAuthorityGroup(
        wrongBusinessUnit.tenant.authorityActor,
        buInput,
        verifierFor(buPlan),
      ),
    ).rejects.toMatchObject({ code: "AUTHORITY_EVIDENCE_INVALID", status: 409 });
  });

  it("rejects canonical members without evidence and shadow members carrying cutover evidence", async () => {
    const canonical = syntheticGroupContract();
    const canonicalMember = canonical.input.members[0]!;
    const canonicalInput = {
      ...canonical.input,
      members: [
        { ...canonicalMember, writeFrozenAt: null, finalBatchId: null },
        ...canonical.input.members.slice(1),
      ],
    };
    await expect(
      transitionSourceAuthorityGroup(
        canonical.actor,
        canonicalInput,
        verifierFor(canonical.plan),
      ),
    ).rejects.toMatchObject({ code: "AUTHORITY_EVIDENCE_INVALID", status: 422 });

    const shadow = syntheticGroupContract();
    const shadowInput = {
      ...shadow.input,
      members: shadow.input.members.map((member) => ({
        ...member,
        toState: "SHADOW_READ" as const,
      })),
    };
    const shadowPlan = {
      ...shadow.plan,
      requiredMembers: shadow.plan.requiredMembers.map((member) => ({
        ...member,
        toState: "SHADOW_READ" as const,
      })),
    };
    await expect(
      transitionSourceAuthorityGroup(
        shadow.actor,
        shadowInput,
        verifierFor(shadowPlan),
      ),
    ).rejects.toMatchObject({ code: "AUTHORITY_EVIDENCE_INVALID", status: 422 });
  });

  it("rejects a lifecycle-invalid direct legacy-to-canonical jump", async () => {
    const fixture = await seedCutoverFixture();
    const source = fixture.sources[0];
    await sql`
      update migration_domain_authorities set authority_state = 'LEGACY_WRITABLE'
      where organization_id = ${fixture.tenant.organizationId} and id = ${source.authorityId}
    `;
    const input = {
      ...fixture.input,
      members: fixture.input.members.map((member) =>
        member.domainAuthorityId === source.authorityId
          ? { ...member, expectedVersion: 2 }
          : member,
      ),
    };
    await expect(
      transitionSourceAuthorityGroup(
        fixture.tenant.authorityActor,
        input,
        fixture.verifier,
      ),
    ).rejects.toMatchObject({ code: "AUTHORITY_TRANSITION_INVALID", status: 409 });
  });

  it("rejects a later unresolved source delta through the effective cutover time", async () => {
    const fixture = await seedCutoverFixture();
    await insertLaterUnresolvedBatch(fixture.tenant, fixture.sources[0]);

    await expect(
      transitionSourceAuthorityGroup(
        fixture.tenant.authorityActor,
        fixture.input,
        fixture.verifier,
      ),
    ).rejects.toMatchObject({ code: "AUTHORITY_LATER_DELTA_EXISTS", status: 409 });
  });

  it("rejects every later live mutable batch status through effective cutover time", async () => {
    for (const status of ["STAGED", "VALIDATED", "APPROVED", "APPLYING"] as const) {
      const fixture = await seedCutoverFixture();
      await insertLaterUnresolvedBatch(
        fixture.tenant,
        fixture.sources[0],
        new Date(Date.now() - 5_000),
        sql,
        status,
      );
      await expect(
        transitionSourceAuthorityGroup(
          fixture.tenant.authorityActor,
          fixture.input,
          fixture.verifier,
        ),
        status,
      ).rejects.toMatchObject({ code: "AUTHORITY_LATER_DELTA_EXISTS", status: 409 });
    }
  });

  it("rejects a later dry-run-only snapshot even when its cutoff is in the future", async () => {
    const fixture = await seedCutoverFixture();
    const source = fixture.sources[0];
    const futureCutoff = new Date(Date.now() + 60_000);
    await sql`
      insert into import_batches (
        organization_id, business_unit_id, migration_source_id, transform_version_id,
        protected_artifact_ref, source_sha256, size_bytes, captured_at, cutoff_at,
        schema_version, status, dry_run, total_row_count, valid_row_count,
        validated_by_membership_id, validated_at
      ) values (
        ${fixture.tenant.organizationId}, ${source.businessUnitId}, ${source.sourceId},
        ${source.transformId}, ${protectedRef("future-dry-only")}, ${sha256(randomUUID())},
        1, ${new Date(futureCutoff.getTime() + 1_000)}, ${futureCutoff}, 'sales.v1',
        'DRY_RUN_COMPLETE', true, 1, 1,
        ${fixture.tenant.businessUnitMembershipIds[0]}, clock_timestamp()
      )
    `;

    await expect(
      transitionSourceAuthorityGroup(
        fixture.tenant.authorityActor,
        fixture.input,
        fixture.verifier,
      ),
    ).rejects.toMatchObject({ code: "AUTHORITY_LATER_DELTA_EXISTS", status: 409 });
  });

  it("rejects a later APPLIED delta that has not been signed and reconciled", async () => {
    const fixture = await seedCutoverFixture();
    const source = fixture.sources[0];
    await insertReconciledBatch(
      sql,
      fixture.tenant,
      0,
      source.sourceId,
      source.transformId,
      { cutoffAt: new Date(Date.now() - 5_000), status: "APPLIED" },
    );
    await expect(
      transitionSourceAuthorityGroup(
        fixture.tenant.authorityActor,
        fixture.input,
        fixture.verifier,
      ),
    ).rejects.toMatchObject({ code: "AUTHORITY_LATER_DELTA_EXISTS", status: 409 });
  });

  it("rejects a later fully reconciled and signed source delta", async () => {
    const fixture = await seedCutoverFixture();
    const source = fixture.sources[0];
    await insertReconciledBatch(
      sql,
      fixture.tenant,
      0,
      source.sourceId,
      source.transformId,
      { cutoffAt: new Date(Date.now() - 5_000), signed: true, status: "RECONCILED" },
    );
    await expect(
      transitionSourceAuthorityGroup(
        fixture.tenant.authorityActor,
        fixture.input,
        fixture.verifier,
      ),
    ).rejects.toMatchObject({ code: "AUTHORITY_LATER_DELTA_EXISTS", status: 409 });
  });

  it("requires every head belonging to one source to bind the same final batch and cutoff", async () => {
    const fixture = await seedCutoverFixture();
    const source = fixture.sources[0];
    const extraScopeId = randomUUID();
    const extraAuthorityId = randomUUID();
    const extraDomainKey = `sales.extra_${randomUUID().replaceAll("-", "_")}`;
    await sql`
      insert into migration_source_scopes (
        id, organization_id, business_unit_id, migration_source_id, domain_key,
        canonical_target, transition_mode, source_status
      ) values (
        ${extraScopeId}, ${fixture.tenant.organizationId}, ${source.businessUnitId},
        ${source.sourceId}, ${extraDomainKey}, 'crm.canonical',
        'ONE_TIME_CUTOVER', 'ACTIVE_AUTHORITY'
      )
    `;
    await sql`
      insert into migration_domain_authorities (
        id, organization_id, business_unit_id, domain_key, canonical_target,
        authority_state, authority_source_scope_id
      ) values (
        ${extraAuthorityId}, ${fixture.tenant.organizationId}, ${source.businessUnitId},
        ${extraDomainKey}, 'crm.canonical', 'SHADOW_READ', ${extraScopeId}
      )
    `;
    const otherBatch = await insertReconciledBatch(
      sql,
      fixture.tenant,
      0,
      source.sourceId,
      source.transformId,
      { cutoffAt: new Date(Date.now() - 20_000) },
    );
    const extraInputMember = {
      domainAuthorityId: extraAuthorityId,
      toState: "CANONICAL_WRITABLE" as const,
      writeFrozenAt: new Date(otherBatch.cutoffAt.getTime() - 1_000),
      finalBatchId: otherBatch.finalBatchId,
      expectedVersion: 1,
    };
    const input = { ...fixture.input, members: [...fixture.input.members, extraInputMember] };
    const plan = {
      ...fixture.plan,
      requiredMembers: [
        ...fixture.plan.requiredMembers,
        {
          businessUnitId: source.businessUnitId,
          domainAuthorityId: extraAuthorityId,
          domainKey: extraDomainKey,
          toState: "CANONICAL_WRITABLE" as const,
          writeFrozenAt: extraInputMember.writeFrozenAt,
          finalBatchId: otherBatch.finalBatchId,
        },
      ],
    };
    await expect(
      transitionSourceAuthorityGroup(
        fixture.tenant.authorityActor,
        input,
        verifierFor(plan),
      ),
    ).rejects.toMatchObject({ code: "AUTHORITY_BATCH_BINDING_CONFLICT", status: 409 });
  });

  it("accepts coherent multi-domain members from one source bound to one final batch", async () => {
    const fixture = await seedCutoverFixture();
    const source = fixture.sources[0];
    const extraScopeId = randomUUID();
    const extraAuthorityId = randomUUID();
    const extraDomainKey = `sales.coherent_${randomUUID().replaceAll("-", "_")}`;
    await sql`
      insert into migration_source_scopes (
        id, organization_id, business_unit_id, migration_source_id, domain_key,
        canonical_target, transition_mode, source_status
      ) values (
        ${extraScopeId}, ${fixture.tenant.organizationId}, ${source.businessUnitId},
        ${source.sourceId}, ${extraDomainKey}, 'crm.canonical',
        'ONE_TIME_CUTOVER', 'ACTIVE_AUTHORITY'
      )
    `;
    await sql`
      insert into migration_domain_authorities (
        id, organization_id, business_unit_id, domain_key, canonical_target,
        authority_state, authority_source_scope_id
      ) values (
        ${extraAuthorityId}, ${fixture.tenant.organizationId}, ${source.businessUnitId},
        ${extraDomainKey}, 'crm.canonical', 'SHADOW_READ', ${extraScopeId}
      )
    `;
    const extraInputMember = {
      domainAuthorityId: extraAuthorityId,
      toState: "CANONICAL_WRITABLE" as const,
      writeFrozenAt: new Date(source.cutoffAt.getTime() - 1_000),
      finalBatchId: source.finalBatchId,
      expectedVersion: 1,
    };
    const input = { ...fixture.input, members: [...fixture.input.members, extraInputMember] };
    const plan: VerifiedAuthorityTransitionPlan = {
      ...fixture.plan,
      requiredMembers: [
        ...fixture.plan.requiredMembers,
        {
          businessUnitId: source.businessUnitId,
          domainAuthorityId: extraAuthorityId,
          domainKey: extraDomainKey,
          toState: extraInputMember.toState,
          writeFrozenAt: extraInputMember.writeFrozenAt,
          finalBatchId: extraInputMember.finalBatchId,
        },
      ],
    };
    await expect(
      transitionSourceAuthorityGroup(
        fixture.tenant.authorityActor,
        input,
        verifierFor(plan),
      ),
    ).resolves.toMatchObject({ replayed: false });
    const heads = await sql<{ authority_state: string }[]>`
      select authority_state from migration_domain_authorities
      where organization_id = ${fixture.tenant.organizationId}
    `;
    expect(heads).toHaveLength(4);
    expect(heads.every((head) => head.authority_state === "CANONICAL_WRITABLE")).toBe(true);
  });

  it("archives only authority scopes and keeps a source active while a registered scope remains", async () => {
    const fixture = await seedCutoverFixture();
    const source = fixture.sources[0];
    const registeredScopeId = randomUUID();
    await sql`
      insert into migration_source_scopes (
        id, organization_id, business_unit_id, migration_source_id, domain_key,
        canonical_target, transition_mode, source_status
      ) values (
        ${registeredScopeId}, ${fixture.tenant.organizationId}, ${source.businessUnitId},
        ${source.sourceId}, ${`sales.registered_${randomUUID().replaceAll("-", "_")}`},
        'crm.canonical', 'ONE_TIME_CUTOVER', 'REGISTERED'
      )
    `;
    await transitionSourceAuthorityGroup(
      fixture.tenant.authorityActor,
      fixture.input,
      fixture.verifier,
    );
    const scopes = await sql<{ id: string; source_status: string }[]>`
      select id, source_status from migration_source_scopes
      where organization_id = ${fixture.tenant.organizationId}
        and migration_source_id = ${source.sourceId}
      order by id
    `;
    expect(scopes).toEqual(
      [
        { id: source.scopeId, source_status: "ARCHIVED_READ_ONLY" },
        { id: registeredScopeId, source_status: "REGISTERED" },
      ].sort((left, right) => left.id.localeCompare(right.id)),
    );
    const [storedSource] = await sql<{ status: string }[]>`
      select status from migration_sources
      where organization_id = ${fixture.tenant.organizationId} and id = ${source.sourceId}
    `;
    expect(storedSource?.status).toBe("ACTIVE");
  });

  it("returns an exact lost-response replay without mutating rows or events", async () => {
    const fixture = await seedCutoverFixture();
    const first = await transitionSourceAuthorityGroup(
      fixture.tenant.authorityActor,
      fixture.input,
      fixture.verifier,
    );
    const stateBeforeReplay = await authorityMutationSnapshot(fixture.tenant.organizationId);
    const [before] = await sql<{
      transitions: number;
      audits: number;
      outbox: number;
    }[]>`
      select
        (select count(*)::int from source_authority_transitions
          where organization_id = ${fixture.tenant.organizationId}) as transitions,
        (select count(*)::int from audit_events
          where organization_id = ${fixture.tenant.organizationId}
            and target_id = ${fixture.input.cutoverGroupId}) as audits,
        (select count(*)::int from outbox_events
          where organization_id = ${fixture.tenant.organizationId}
            and aggregate_id = ${fixture.input.cutoverGroupId}) as outbox
    `;

    const replay = await transitionSourceAuthorityGroup(
      fixture.tenant.authorityActor,
      { ...fixture.input, members: [...fixture.input.members].reverse() },
      fixture.verifier,
    );

    expect(replay).toEqual({ ...first, replayed: true });
    const [after] = await sql<{
      transitions: number;
      audits: number;
      outbox: number;
    }[]>`
      select
        (select count(*)::int from source_authority_transitions
          where organization_id = ${fixture.tenant.organizationId}) as transitions,
        (select count(*)::int from audit_events
          where organization_id = ${fixture.tenant.organizationId}
            and target_id = ${fixture.input.cutoverGroupId}) as audits,
        (select count(*)::int from outbox_events
          where organization_id = ${fixture.tenant.organizationId}
            and aggregate_id = ${fixture.input.cutoverGroupId}) as outbox
    `;
    expect(after).toEqual(before);
    expect(await authorityMutationSnapshot(fixture.tenant.organizationId)).toEqual(
      stateBeforeReplay,
    );
  });

  it("normalizes approval-reason whitespace and replays a whitespace-equivalent request", async () => {
    const fixture = await seedCutoverFixture();
    const normalizedReason = fixture.input.approvalReason;
    const first = await transitionSourceAuthorityGroup(
      fixture.tenant.authorityActor,
      { ...fixture.input, approvalReason: `  ${normalizedReason}  ` },
      fixture.verifier,
    );
    const replay = await transitionSourceAuthorityGroup(
      fixture.tenant.authorityActor,
      { ...fixture.input, approvalReason: normalizedReason },
      fixture.verifier,
    );
    expect(replay).toEqual({ ...first, replayed: true });
    const [group] = await sql<{ approval_reason: string }[]>`
      select approval_reason from source_authority_transition_groups
      where organization_id = ${fixture.tenant.organizationId}
        and id = ${fixture.input.cutoverGroupId}
    `;
    expect(group?.approval_reason).toBe(normalizedReason);
  });

  it("requires current database authority before returning an exact replay", async () => {
    const fixture = await seedCutoverFixture();
    await transitionSourceAuthorityGroup(
      fixture.tenant.authorityActor,
      fixture.input,
      fixture.verifier,
    );
    const beforeReplay = await authorityMutationSnapshot(fixture.tenant.organizationId);
    const [role] = await sql<{ role_id: string }[]>`
      select role_id from membership_roles
      where organization_id = ${fixture.tenant.organizationId}
        and membership_id = ${fixture.tenant.orgWideMembershipId}
    `;
    await sql`
      delete from role_capabilities
      where organization_id = ${fixture.tenant.organizationId}
        and role_id = ${role!.role_id}
        and capability_key = ${AUTHORITY_CAPABILITY}
    `;

    await expect(
      transitionSourceAuthorityGroup(
        fixture.tenant.authorityActor,
        fixture.input,
        fixture.verifier,
      ),
    ).rejects.toMatchObject({ code: "MIGRATION_CAPABILITY_REQUIRED", status: 403 });
    expect(await authorityMutationSnapshot(fixture.tenant.organizationId)).toEqual(
      beforeReplay,
    );
  });

  it("rejects seeded stored replay groups with missing, extra, or different children", async () => {
    for (const corruption of [
      "missing",
      "extra",
      "different",
      "from-state",
      "final-cutoff",
    ] as const) {
      const fixture = await seedCutoverFixture();
      await transitionSourceAuthorityGroup(
        fixture.tenant.authorityActor,
        fixture.input,
        fixture.verifier,
      );
      const extraAuthorityId = randomUUID();
      if (corruption === "extra") {
        await sql`
          insert into migration_domain_authorities (
            id, organization_id, business_unit_id, domain_key, canonical_target,
            authority_state, authority_source_scope_id
          ) values (
            ${extraAuthorityId}, ${fixture.tenant.organizationId},
            ${fixture.tenant.businessUnitIds[0]},
            ${`sales.replay_extra_${randomUUID().replaceAll("-", "_")}`},
            'crm.canonical', 'CANONICAL_WRITABLE', null
          )
        `;
      }
      await sql.unsafe(
        "alter table source_authority_transitions disable trigger user",
      );
      try {
        if (corruption === "missing") {
          await sql`
            delete from source_authority_transitions
            where id = (
              select id from source_authority_transitions
              where organization_id = ${fixture.tenant.organizationId}
                and transition_group_id = ${fixture.input.cutoverGroupId}
              order by id limit 1
            )
          `;
        } else if (corruption === "extra") {
          await sql`
            insert into source_authority_transitions (
              id, organization_id, business_unit_id, transition_group_id,
              domain_authority_id, from_source_scope_id, to_source_scope_id,
              from_state, to_state, write_frozen_at, final_batch_id, final_cutoff_at
            )
            select ${randomUUID()}, organization_id, business_unit_id,
                   transition_group_id, ${extraAuthorityId}, from_source_scope_id,
                   to_source_scope_id, from_state, to_state, write_frozen_at,
                   final_batch_id, final_cutoff_at
            from source_authority_transitions
            where organization_id = ${fixture.tenant.organizationId}
              and transition_group_id = ${fixture.input.cutoverGroupId}
              and business_unit_id = ${fixture.tenant.businessUnitIds[0]}
            order by id limit 1
          `;
        } else if (corruption === "different") {
          await sql`
            update source_authority_transitions
            set write_frozen_at = write_frozen_at - interval '1 millisecond'
            where id = (
              select id from source_authority_transitions
              where organization_id = ${fixture.tenant.organizationId}
                and transition_group_id = ${fixture.input.cutoverGroupId}
              order by id limit 1
            )
          `;
        } else if (corruption === "from-state") {
          await sql`
            update source_authority_transitions
            set from_state = 'LEGACY_WRITABLE'
            where id = (
              select id from source_authority_transitions
              where organization_id = ${fixture.tenant.organizationId}
                and transition_group_id = ${fixture.input.cutoverGroupId}
              order by id limit 1
            )
          `;
        } else {
          await sql`
            update source_authority_transitions
            set final_cutoff_at = final_cutoff_at - interval '1 millisecond'
            where id = (
              select id from source_authority_transitions
              where organization_id = ${fixture.tenant.organizationId}
                and transition_group_id = ${fixture.input.cutoverGroupId}
              order by id limit 1
            )
          `;
        }
      } finally {
        await sql.unsafe(
          "alter table source_authority_transitions enable trigger user",
        );
      }
      const corrupted = await authorityMutationSnapshot(fixture.tenant.organizationId);
      await expect(
        transitionSourceAuthorityGroup(
          fixture.tenant.authorityActor,
          fixture.input,
          fixture.verifier,
        ),
        corruption,
      ).rejects.toMatchObject({ code: "AUTHORITY_IDEMPOTENCY_CONFLICT", status: 409 });
      expect(await authorityMutationSnapshot(fixture.tenant.organizationId)).toEqual(
        corrupted,
      );
    }
  });

  it("allows the same idempotency key in different organizations", async () => {
    const left = await seedCutoverFixture();
    const right = await seedCutoverFixture();
    const sharedKey = `cross-org-${randomUUID()}`;
    const [leftResult, rightResult] = await Promise.all([
      transitionSourceAuthorityGroup(
        left.tenant.authorityActor,
        { ...left.input, idempotencyKey: sharedKey },
        left.verifier,
      ),
      transitionSourceAuthorityGroup(
        right.tenant.authorityActor,
        { ...right.input, idempotencyKey: sharedKey },
        right.verifier,
      ),
    ]);
    expect(leftResult.replayed).toBe(false);
    expect(rightResult.replayed).toBe(false);
  });

  it("sanitizes a globally colliding foreign-organization group ID", async () => {
    const owner = await seedCutoverFixture();
    const foreign = await seedCutoverFixture();
    await transitionSourceAuthorityGroup(
      owner.tenant.authorityActor,
      owner.input,
      owner.verifier,
    );
    let failure: unknown;
    try {
      await transitionSourceAuthorityGroup(
        foreign.tenant.authorityActor,
        { ...foreign.input, cutoverGroupId: owner.input.cutoverGroupId },
        foreign.verifier,
      );
    } catch (error: unknown) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: "AUTHORITY_IDEMPOTENCY_CONFLICT",
      status: 409,
    });
    const exposed = `${String(failure)} ${JSON.stringify(failure)}`;
    expect(exposed).not.toContain("transition_groups_pkey");
    expect(exposed).not.toContain(owner.tenant.organizationId);
  });

  it("does not reopen a brand-new source-authority head after canonical cutover", async () => {
    const fixture = await seedCutoverFixture();
    await transitionSourceAuthorityGroup(
      fixture.tenant.authorityActor,
      fixture.input,
      fixture.verifier,
    );
    await expect(
      registerMigrationSource(
        fixture.tenant.sourceActors[0],
        validSourceInput(fixture.tenant, 0),
      ),
    ).rejects.toMatchObject({
      code: "MIGRATION_POST_CUTOVER_DOMAIN_FORBIDDEN",
      status: 409,
    });
    const heads = await sql<{ authority_state: string }[]>`
      select authority_state from migration_domain_authorities
      where organization_id = ${fixture.tenant.organizationId}
    `;
    expect(heads).toHaveLength(3);
    expect(heads.every((head) => head.authority_state === "CANONICAL_WRITABLE")).toBe(true);
  });

  it("allows a matching existing canonical domain to register read-only after cutover", async () => {
    const fixture = await seedCutoverFixture();
    await transitionSourceAuthorityGroup(
      fixture.tenant.authorityActor,
      fixture.input,
      fixture.verifier,
    );
    const sourceId = await registerMigrationSource(
      fixture.tenant.sourceActors[0],
      validSourceInput(fixture.tenant, 0, fixture.sources[0].domainKey),
    );
    const [stored] = await sql<{ source_status: string; status: string }[]>`
      select scope.source_status, source.status
      from migration_source_scopes scope
      join migration_sources source
        on source.organization_id = scope.organization_id
       and source.business_unit_id = scope.business_unit_id
       and source.id = scope.migration_source_id
      where scope.organization_id = ${fixture.tenant.organizationId}
        and scope.migration_source_id = ${sourceId}
    `;
    expect(stored).toEqual({ source_status: "REGISTERED", status: "REGISTERED" });
    const [head] = await sql<{ authority_state: string; authority_source_scope_id: null }[]>`
      select authority_state, authority_source_scope_id
      from migration_domain_authorities
      where organization_id = ${fixture.tenant.organizationId}
        and business_unit_id = ${fixture.tenant.businessUnitIds[0]}
        and domain_key = ${fixture.sources[0].domainKey}
    `;
    expect(head).toEqual({
      authority_state: "CANONICAL_WRITABLE",
      authority_source_scope_id: null,
    });
  });

  it("returns 409 for any conflicting group-ID or idempotency-key reuse", async () => {
    const fixture = await seedCutoverFixture();
    await transitionSourceAuthorityGroup(
      fixture.tenant.authorityActor,
      fixture.input,
      fixture.verifier,
    );

    await expect(
      transitionSourceAuthorityGroup(
        fixture.tenant.authorityActor,
        { ...fixture.input, approvalReason: "Changed request" },
        fixture.verifier,
      ),
    ).rejects.toMatchObject({ code: "AUTHORITY_IDEMPOTENCY_CONFLICT", status: 409 });
    await expect(
      transitionSourceAuthorityGroup(
        fixture.tenant.authorityActor,
        { ...fixture.input, idempotencyKey: `other-${randomUUID()}` },
        fixture.verifier,
      ),
    ).rejects.toMatchObject({ code: "AUTHORITY_IDEMPOTENCY_CONFLICT", status: 409 });
    await expect(
      transitionSourceAuthorityGroup(
        fixture.tenant.authorityActor,
        { ...fixture.input, cutoverGroupId: randomUUID() },
        fixture.verifier,
      ),
    ).rejects.toMatchObject({ code: "AUTHORITY_IDEMPOTENCY_CONFLICT", status: 409 });
    await expect(
      transitionSourceAuthorityGroup(
        fixture.tenant.authorityActor,
        {
          ...fixture.input,
          members: fixture.input.members.map((member, index) =>
            index === 0 ? { ...member, expectedVersion: member.expectedVersion + 1 } : member,
          ),
        },
        fixture.verifier,
      ),
    ).rejects.toMatchObject({ code: "AUTHORITY_IDEMPOTENCY_CONFLICT", status: 409 });

    const changedPlanSha256 = sha256("changed reviewed plan digest");
    await expect(
      transitionSourceAuthorityGroup(
        fixture.tenant.authorityActor,
        { ...fixture.input, expectedPlanSha256: changedPlanSha256 },
        verifierFor({ ...fixture.plan, planSha256: changedPlanSha256 }),
      ),
    ).rejects.toMatchObject({ code: "AUTHORITY_IDEMPOTENCY_CONFLICT", status: 409 });
  });

  it("rejects split-brain lookup when group ID and idempotency key resolve to different groups", async () => {
    const fixture = await seedCutoverFixture();
    await sql`
      update migration_domain_authorities set authority_state = 'LEGACY_WRITABLE'
      where organization_id = ${fixture.tenant.organizationId}
    `;
    const shadowPlanArtifactRef = protectedRef("shadow-stage-plan");
    const shadowPlanSha256 = sha256(`shadow-stage-plan:${shadowPlanArtifactRef}`);
    const shadowInput: AuthorityTransitionGroupInput = {
      ...fixture.input,
      cutoverGroupId: randomUUID(),
      idempotencyKey: `shadow-stage-${randomUUID()}`,
      planArtifactRef: shadowPlanArtifactRef,
      expectedPlanSha256: shadowPlanSha256,
      approvalReason: "Reviewed shadow-stage transition",
      members: fixture.sources.map((source) => ({
        domainAuthorityId: source.authorityId,
        toState: "SHADOW_READ" as const,
        writeFrozenAt: null,
        finalBatchId: null,
        expectedVersion: 2,
      })),
    };
    const shadowPlan: VerifiedAuthorityTransitionPlan = {
      ...fixture.plan,
      artifactRef: shadowPlanArtifactRef,
      planSha256: shadowPlanSha256,
      requiredMembers: fixture.sources.map((source) => ({
        businessUnitId: source.businessUnitId,
        domainAuthorityId: source.authorityId,
        domainKey: source.domainKey,
        toState: "SHADOW_READ" as const,
        writeFrozenAt: null,
        finalBatchId: null,
      })),
    };
    await transitionSourceAuthorityGroup(
      fixture.tenant.authorityActor,
      shadowInput,
      verifierFor(shadowPlan),
    );

    const canonicalInput: AuthorityTransitionGroupInput = {
      ...fixture.input,
      members: fixture.input.members.map((member) => ({ ...member, expectedVersion: 3 })),
    };
    await transitionSourceAuthorityGroup(
      fixture.tenant.authorityActor,
      canonicalInput,
      fixture.verifier,
    );

    await expect(
      transitionSourceAuthorityGroup(
        fixture.tenant.authorityActor,
        {
          ...canonicalInput,
          cutoverGroupId: shadowInput.cutoverGroupId,
          idempotencyKey: canonicalInput.idempotencyKey,
        },
        fixture.verifier,
      ),
    ).rejects.toMatchObject({ code: "AUTHORITY_IDEMPOTENCY_CONFLICT", status: 409 });
  });

  it("serializes concurrent reuse of either unique group key", async () => {
    for (const reusedKey of ["group-id", "idempotency-key"] as const) {
      const fixture = await seedCutoverFixture();
      const competitor = {
        ...fixture.input,
        cutoverGroupId:
          reusedKey === "group-id" ? fixture.input.cutoverGroupId : randomUUID(),
        idempotencyKey:
          reusedKey === "idempotency-key"
            ? fixture.input.idempotencyKey
            : `competitor-${randomUUID()}`,
        approvalReason: "Competing reviewed request",
      };
      const results = await Promise.allSettled([
        transitionSourceAuthorityGroup(
          fixture.tenant.authorityActor,
          fixture.input,
          fixture.verifier,
        ),
        transitionSourceAuthorityGroup(
          fixture.tenant.authorityActor,
          competitor,
          fixture.verifier,
        ),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const [rejected] = results.filter(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      expect(rejected?.reason).toMatchObject({
        code: "AUTHORITY_IDEMPOTENCY_CONFLICT",
        status: 409,
      });
    }
  });

  it(
    "replays concurrent same-group requests with reversed member order",
    async () => {
      const fixture = await seedCutoverFixture();
      const reversed = { ...fixture.input, members: [...fixture.input.members].reverse() };
      const [left, right] = await Promise.all([
        transitionSourceAuthorityGroup(
          fixture.tenant.authorityActor,
          fixture.input,
          fixture.verifier,
        ),
        transitionSourceAuthorityGroup(
          fixture.tenant.authorityActor,
          reversed,
          fixture.verifier,
        ),
      ]);
      expect([left.replayed, right.replayed].sort()).toEqual([false, true]);
      expect(left.cutoverGroupId).toBe(right.cutoverGroupId);
      expect([...left.transitionIds].sort()).toEqual([...right.transitionIds].sort());
      expect(left.effectiveAt.toISOString()).toBe(right.effectiveAt.toISOString());
    },
    15_000,
  );

  it(
    "locks authority heads in global order before touching a later head from opposite caller order",
    async () => {
      const fixture = await seedCutoverFixture();
      const globallySorted = [...fixture.sources].sort((left, right) => {
        const leftKey = `${left.businessUnitId}\0${left.domainKey}\0${left.authorityId}`;
        const rightKey = `${right.businessUnitId}\0${right.domainKey}\0${right.authorityId}`;
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
      });
      const firstHead = globallySorted[0]!;
      const laterHead = globallySorted.at(-1)!;
      const oppositeInput: AuthorityTransitionGroupInput = {
        ...fixture.input,
        members: [...globallySorted].reverse().map((source) =>
          fixture.input.members.find(
            (member) => member.domainAuthorityId === source.authorityId,
          )!,
        ),
      };
      let releaseFirst!: () => void;
      const mayReleaseFirst = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let reportFirst!: (pid: number) => void;
      const firstHeld = new Promise<number>((resolve) => {
        reportFirst = resolve;
      });
      const firstBlocker = sql.begin(async (transaction) => {
        const [backend] = await transaction<{ pid: number }[]>`
          select pg_backend_pid() as pid
        `;
        await transaction`
          select id from migration_domain_authorities
          where organization_id = ${fixture.tenant.organizationId}
            and id = ${firstHead.authorityId}
          for share
        `;
        reportFirst(backend!.pid);
        await mayReleaseFirst;
      });
      let releaseProbe!: () => void;
      const mayReleaseProbe = new Promise<void>((resolve) => {
        releaseProbe = resolve;
      });
      let cutover: ReturnType<typeof transitionSourceAuthorityGroup> | undefined;
      let laterProbe: Promise<unknown> | undefined;
      try {
        const blockerPid = await firstHeld;
        cutover = transitionSourceAuthorityGroup(
          fixture.tenant.authorityActor,
          oppositeInput,
          fixture.verifier,
        );
        const cutoverPid = await waitUntilBlockedBy(blockerPid);

        let reportProbeAcquired!: () => void;
        const probeAcquired = new Promise<void>((resolve) => {
          reportProbeAcquired = resolve;
        });
        let reportProbeBackend!: (pid: number) => void;
        const probeBackend = new Promise<number>((resolve) => {
          reportProbeBackend = resolve;
        });
        laterProbe = sql.begin(async (transaction) => {
          const [backend] = await transaction<{ pid: number }[]>`
            select pg_backend_pid() as pid
          `;
          reportProbeBackend(backend!.pid);
          await transaction`
            select id from migration_domain_authorities
            where organization_id = ${fixture.tenant.organizationId}
              and id = ${laterHead.authorityId}
            for update
          `;
          reportProbeAcquired();
          await mayReleaseProbe;
        });
        await Promise.race([
          probeAcquired,
          new Promise<never>((_, reject) => {
            setTimeout(
              () => reject(new Error("Later head was locked before the global first head.")),
              5_000,
            );
          }),
        ]);
        const laterProbePid = await probeBackend;
        releaseFirst();
        await firstBlocker;
        await waitUntilBackendBlockedBy(cutoverPid, laterProbePid);
        releaseProbe();
        await laterProbe;
        await expect(cutover).resolves.toMatchObject({ replayed: false });
      } finally {
        releaseProbe();
        releaseFirst();
        const pending: Promise<unknown>[] = [firstBlocker];
        if (laterProbe) pending.push(laterProbe);
        if (cutover) pending.push(cutover);
        await Promise.allSettled(pending);
      }
    },
    20_000,
  );

  it(
    "locks referenced scopes and final batches in deterministic phases and global order",
    async () => {
      for (const phase of ["scope", "batch"] as const) {
        const fixture = await seedCutoverFixture();
        const globallySorted = [...fixture.sources].sort((left, right) => {
          const leftKey =
            phase === "scope"
              ? `${left.businessUnitId}\0${left.domainKey}\0${left.authorityId}`
              : `${left.businessUnitId}\0${left.finalBatchId}`;
          const rightKey =
            phase === "scope"
              ? `${right.businessUnitId}\0${right.domainKey}\0${right.authorityId}`
              : `${right.businessUnitId}\0${right.finalBatchId}`;
          return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
        });
        const first = globallySorted[0]!;
        const later = globallySorted.at(-1)!;
        const oppositeInput: AuthorityTransitionGroupInput = {
          ...fixture.input,
          members: [...globallySorted].reverse().map((source) =>
            fixture.input.members.find(
              (member) => member.domainAuthorityId === source.authorityId,
            )!,
          ),
        };
        let releaseFirst!: () => void;
        const mayReleaseFirst = new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        let reportFirst!: (pid: number) => void;
        const firstHeld = new Promise<number>((resolve) => {
          reportFirst = resolve;
        });
        const blocker = sql.begin(async (transaction) => {
          const [backend] = await transaction<{ pid: number }[]>`
            select pg_backend_pid() as pid
          `;
          if (phase === "scope") {
            await transaction`
              select id from migration_source_scopes
              where organization_id = ${fixture.tenant.organizationId}
                and id = ${first.scopeId}
              for share
            `;
          } else {
            await transaction`
              select id from import_batches
              where organization_id = ${fixture.tenant.organizationId}
                and id = ${first.finalBatchId}
              for share
            `;
          }
          reportFirst(backend!.pid);
          await mayReleaseFirst;
        });
        let releaseProbe!: () => void;
        const mayReleaseProbe = new Promise<void>((resolve) => {
          releaseProbe = resolve;
        });
        let cutover: ReturnType<typeof transitionSourceAuthorityGroup> | undefined;
        let probe: Promise<unknown> | undefined;
        const priorPhaseProbes: Promise<unknown>[] = [];
        try {
          const blockerPid = await firstHeld;
          cutover = transitionSourceAuthorityGroup(
            fixture.tenant.authorityActor,
            oppositeInput,
            fixture.verifier,
          );
          const cutoverPid = await waitUntilBlockedBy(blockerPid);
          for (const priorPhase of (
            phase === "scope" ? (["head"] as const) : (["head", "scope"] as const)
          )) {
            let reportBackend!: (pid: number) => void;
            const backendReady = new Promise<number>((resolve) => {
              reportBackend = resolve;
            });
            const priorProbe = sql.begin(async (transaction) => {
              const [backend] = await transaction<{ pid: number }[]>`
                select pg_backend_pid() as pid
              `;
              reportBackend(backend!.pid);
              if (priorPhase === "head") {
                await transaction`
                  select id from migration_domain_authorities
                  where organization_id = ${fixture.tenant.organizationId}
                    and id = ${fixture.sources[0].authorityId}
                  for update
                `;
              } else {
                await transaction`
                  select id from migration_source_scopes
                  where organization_id = ${fixture.tenant.organizationId}
                    and id = ${fixture.sources[0].scopeId}
                  for update
                `;
              }
            });
            priorPhaseProbes.push(priorProbe);
            await waitUntilBackendBlockedBy(await backendReady, cutoverPid);
          }
          let reportProbeAcquired!: () => void;
          const probeAcquired = new Promise<void>((resolve) => {
            reportProbeAcquired = resolve;
          });
          let reportProbeBackend!: (pid: number) => void;
          const probeBackend = new Promise<number>((resolve) => {
            reportProbeBackend = resolve;
          });
          probe = sql.begin(async (transaction) => {
            const [backend] = await transaction<{ pid: number }[]>`
              select pg_backend_pid() as pid
            `;
            reportProbeBackend(backend!.pid);
            if (phase === "scope") {
              await transaction`
                select id from migration_source_scopes
                where organization_id = ${fixture.tenant.organizationId}
                  and id = ${later.scopeId}
                for update
              `;
            } else {
              await transaction`
                select id from import_batches
                where organization_id = ${fixture.tenant.organizationId}
                  and id = ${later.finalBatchId}
                for update
              `;
            }
            reportProbeAcquired();
            await mayReleaseProbe;
          });
          await Promise.race([
            probeAcquired,
            new Promise<never>((_, reject) => {
              setTimeout(
                () => reject(new Error(`${phase} later row was locked out of order.`)),
                5_000,
              );
            }),
          ]);
          const laterProbePid = await probeBackend;
          releaseFirst();
          await blocker;
          await waitUntilBackendBlockedBy(cutoverPid, laterProbePid);
          releaseProbe();
          await probe;
          await expect(cutover, phase).resolves.toMatchObject({ replayed: false });
        } finally {
          releaseProbe();
          releaseFirst();
          const pending: Promise<unknown>[] = [blocker];
          if (probe) pending.push(probe);
          if (cutover) pending.push(cutover);
          pending.push(...priorPhaseProbes);
          await Promise.allSettled(pending);
        }
      }
    },
    40_000,
  );

  it(
    "locks a non-selected source batch before a later selected final batch",
    async () => {
      const fixture = await seedCutoverFixture();
      const firstSource = [...fixture.sources].sort((left, right) =>
        left.businessUnitId < right.businessUnitId
          ? -1
          : left.businessUnitId > right.businessUnitId
            ? 1
            : 0,
      )[0]!;
      const nonSelectedBatchId = "00000000-0000-1000-8000-000000000000";
      const olderCutoff = new Date(firstSource.cutoffAt.getTime() - 10_000);
      await sql`
        insert into import_batches (
          id, organization_id, business_unit_id, migration_source_id,
          transform_version_id, protected_artifact_ref, source_sha256, size_bytes,
          captured_at, cutoff_at, schema_version, status, dry_run,
          total_row_count, valid_row_count, validated_by_membership_id, validated_at
        ) values (
          ${nonSelectedBatchId}, ${fixture.tenant.organizationId},
          ${firstSource.businessUnitId}, ${firstSource.sourceId}, ${firstSource.transformId},
          ${protectedRef("older-non-selected-dry-run")}, ${sha256(randomUUID())}, 1,
          ${new Date(olderCutoff.getTime() + 1_000)}, ${olderCutoff}, 'sales.v1',
          'DRY_RUN_COMPLETE', true, 1, 1,
          ${fixture.tenant.businessUnitMembershipIds[
            fixture.tenant.businessUnitIds.indexOf(firstSource.businessUnitId)
          ]!}, clock_timestamp()
        )
      `;

      let releaseFirst!: () => void;
      const mayReleaseFirst = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let reportFirst!: (pid: number) => void;
      const firstHeld = new Promise<number>((resolve) => {
        reportFirst = resolve;
      });
      const firstBlocker = sql.begin(async (transaction) => {
        const [backend] = await transaction<{ pid: number }[]>`
          select pg_backend_pid() as pid
        `;
        await transaction`
          select id from import_batches
          where organization_id = ${fixture.tenant.organizationId}
            and id = ${nonSelectedBatchId}
          for share
        `;
        reportFirst(backend!.pid);
        await mayReleaseFirst;
      });
      let releaseSelected!: () => void;
      const mayReleaseSelected = new Promise<void>((resolve) => {
        releaseSelected = resolve;
      });
      let cutover: ReturnType<typeof transitionSourceAuthorityGroup> | undefined;
      let selectedProbe: Promise<unknown> | undefined;
      try {
        const blockerPid = await firstHeld;
        cutover = transitionSourceAuthorityGroup(
          fixture.tenant.authorityActor,
          fixture.input,
          fixture.verifier,
        );
        const cutoverPid = await waitUntilBlockedBy(blockerPid);

        let reportSelectedAcquired!: () => void;
        const selectedAcquired = new Promise<void>((resolve) => {
          reportSelectedAcquired = resolve;
        });
        let reportSelectedBackend!: (pid: number) => void;
        const selectedBackend = new Promise<number>((resolve) => {
          reportSelectedBackend = resolve;
        });
        selectedProbe = sql.begin(async (transaction) => {
          const [backend] = await transaction<{ pid: number }[]>`
            select pg_backend_pid() as pid
          `;
          reportSelectedBackend(backend!.pid);
          await transaction`
            select id from import_batches
            where organization_id = ${fixture.tenant.organizationId}
              and id = ${firstSource.finalBatchId}
            for update
          `;
          reportSelectedAcquired();
          await mayReleaseSelected;
        });
        await Promise.race([
          selectedAcquired,
          new Promise<never>((_, reject) => {
            setTimeout(
              () => reject(new Error("Selected final batch was locked before the earlier source batch.")),
              5_000,
            );
          }),
        ]);
        const selectedProbePid = await selectedBackend;
        releaseFirst();
        await firstBlocker;
        await waitUntilBackendBlockedBy(cutoverPid, selectedProbePid);
        releaseSelected();
        await selectedProbe;
        await expect(cutover).resolves.toMatchObject({ replayed: false });
      } finally {
        releaseSelected();
        releaseFirst();
        const pending: Promise<unknown>[] = [firstBlocker];
        if (selectedProbe) pending.push(selectedProbe);
        if (cutover) pending.push(cutover);
        await Promise.allSettled(pending);
      }
    },
    25_000,
  );

  it(
    "rejects a transaction opened before notBefore even when the lock wait ends inside the window",
    async () => {
      const fixture = await seedCutoverFixture();
      const notBefore = new Date(Date.now() + 8_000);
      const plan = {
        ...fixture.plan,
        notBefore,
        expiresAt: new Date(notBefore.getTime() + 30_000),
      };
      let releaseLock!: () => void;
      const mayRelease = new Promise<void>((resolve) => {
        releaseLock = resolve;
      });
      let reportLock!: (pid: number) => void;
      const lockHeld = new Promise<number>((resolve) => {
        reportLock = resolve;
      });
      const blocker = sql.begin(async (transaction) => {
        const [backend] = await transaction<{ pid: number }[]>`
          select pg_backend_pid() as pid
        `;
        await transaction`
          select id from migration_domain_authorities
          where organization_id = ${fixture.tenant.organizationId}
            and id = ${fixture.sources[0].authorityId}
          for update
        `;
        reportLock(backend!.pid);
        await mayRelease;
      });
      const blockerPid = await lockHeld;
      const cutover = transitionSourceAuthorityGroup(
        fixture.tenant.authorityActor,
        fixture.input,
        verifierFor(plan),
      );
      const outcome = cutover.then(
        (value) => ({ kind: "fulfilled" as const, value }),
        (reason: unknown) => ({ kind: "rejected" as const, reason }),
      );
      try {
        const first = await Promise.race([
          outcome,
          waitUntilBlockedBy(blockerPid).then(() => ({ kind: "blocked" as const })),
        ]);
        if (first.kind === "fulfilled") {
          throw new Error("A pre-notBefore authority transition unexpectedly succeeded.");
        }
        if (first.kind === "rejected") {
          expect(first.reason).toMatchObject({
            code: "AUTHORITY_WINDOW_CLOSED",
            status: 409,
          });
          return;
        }
        const remaining = notBefore.getTime() - Date.now() + 150;
        if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
        releaseLock();
        await blocker;
        const afterWait = await outcome;
        expect(afterWait.kind).toBe("rejected");
        if (afterWait.kind === "rejected") {
          expect(afterWait.reason).toMatchObject({
            code: "AUTHORITY_WINDOW_CLOSED",
            status: 409,
          });
        }
      } finally {
        releaseLock();
        await blocker;
      }
    },
    30_000,
  );

  it(
    "rechecks the signed window after a lock wait and rejects execution that expires while blocked",
    async () => {
      const fixture = await seedCutoverFixture();
      const expiresAt = new Date(Date.now() + 8_000);
      const expiringPlan = {
        ...fixture.plan,
        notBefore: new Date(Date.now() - 60_000),
        expiresAt,
      };
      let releaseLock!: () => void;
      const mayRelease = new Promise<void>((resolve) => {
        releaseLock = resolve;
      });
      let reportLock!: (pid: number) => void;
      const lockHeld = new Promise<number>((resolve) => {
        reportLock = resolve;
      });
      const blocker = sql.begin(async (transaction) => {
        const [backend] = await transaction<{ pid: number }[]>`
          select pg_backend_pid() as pid
        `;
        await transaction`
          select id from migration_domain_authorities
          where organization_id = ${fixture.tenant.organizationId}
            and id = ${fixture.sources[0].authorityId}
          for update
        `;
        reportLock(backend!.pid);
        await mayRelease;
      });
      const blockerPid = await lockHeld;
      const cutover = transitionSourceAuthorityGroup(
        fixture.tenant.authorityActor,
        fixture.input,
        verifierFor(expiringPlan),
      );
      try {
        await waitUntilBlockedBy(blockerPid);
        const remaining = expiresAt.getTime() - Date.now() + 150;
        if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
        releaseLock();
        await blocker;

        await expect(cutover).rejects.toMatchObject({
          code: "AUTHORITY_WINDOW_CLOSED",
          status: 409,
        });
      } finally {
        releaseLock();
        await Promise.allSettled([blocker, cutover]);
      }
      const [countRow] = await sql<{ count: number }[]>`
        select count(*)::int as count from source_authority_transition_groups
        where organization_id = ${fixture.tenant.organizationId}
      `;
      expect(countRow?.count).toBe(0);
    },
    30_000,
  );

  it(
    "serializes a final source delta ahead of cutover and rejects it after the lock wait",
    async () => {
      const fixture = await seedCutoverFixture();
      let releaseDelta!: () => void;
      const mayRelease = new Promise<void>((resolve) => {
        releaseDelta = resolve;
      });
      let reportDelta!: (pid: number) => void;
      const deltaHeld = new Promise<number>((resolve) => {
        reportDelta = resolve;
      });
      const deltaWriter = sql.begin(async (transaction) => {
        const [backend] = await transaction<{ pid: number }[]>`
          select pg_backend_pid() as pid
        `;
        await transaction`
          select id from migration_domain_authorities
          where organization_id = ${fixture.tenant.organizationId}
            and id = ${fixture.sources[0].authorityId}
          for share
        `;
        await insertLaterUnresolvedBatch(
          fixture.tenant,
          fixture.sources[0],
          new Date(Date.now() - 5_000),
          transaction,
        );
        reportDelta(backend!.pid);
        await mayRelease;
      });
      const deltaPid = await deltaHeld;
      const cutover = transitionSourceAuthorityGroup(
        fixture.tenant.authorityActor,
        fixture.input,
        fixture.verifier,
      );
      await waitUntilBlockedBy(deltaPid);
      releaseDelta();
      await deltaWriter;

      await expect(cutover).rejects.toMatchObject({
        code: "AUTHORITY_LATER_DELTA_EXISTS",
        status: 409,
      });
    },
    15_000,
  );

  it(
    "freezes new-domain registration behind cutover and refuses to reopen authority afterward",
    async () => {
      const fixture = await seedCutoverFixture();
      let releaseHead!: () => void;
      const mayRelease = new Promise<void>((resolve) => {
        releaseHead = resolve;
      });
      let reportHead!: (pid: number) => void;
      const headHeld = new Promise<number>((resolve) => {
        reportHead = resolve;
      });
      const headBlocker = sql.begin(async (transaction) => {
        const [backend] = await transaction<{ pid: number }[]>`
          select pg_backend_pid() as pid
        `;
        await transaction`
          select id from migration_domain_authorities
          where organization_id = ${fixture.tenant.organizationId}
            and id = ${fixture.sources[0].authorityId}
          for update
        `;
        reportHead(backend!.pid);
        await mayRelease;
      });
      const blockerPid = await headHeld;
      const cutover = transitionSourceAuthorityGroup(
        fixture.tenant.authorityActor,
        fixture.input,
        fixture.verifier,
      );
      const cutoverPid = await waitUntilBlockedBy(blockerPid);
      const registration = registerMigrationSource(
        fixture.tenant.sourceActors[0],
        validSourceInput(fixture.tenant, 0),
      );
      await waitUntilBlockedBy(cutoverPid);
      releaseHead();
      await headBlocker;

      await expect(cutover).resolves.toMatchObject({ replayed: false });
      await expect(registration).rejects.toMatchObject({
        code: "MIGRATION_POST_CUTOVER_DOMAIN_FORBIDDEN",
        status: 409,
      });
    },
    15_000,
  );

  it("leaves every authority aggregate and event unchanged when one member is invalid", async () => {
    const fixture = await seedCutoverFixture();
    const before = await authorityMutationSnapshot(fixture.tenant.organizationId);
    const invalid = {
      ...fixture.input,
      members: fixture.input.members.map((member, index) =>
        index === 1 ? { ...member, expectedVersion: member.expectedVersion + 1 } : member,
      ),
    };
    await expect(
      transitionSourceAuthorityGroup(
        fixture.tenant.authorityActor,
        invalid,
        fixture.verifier,
      ),
    ).rejects.toMatchObject({ code: "AUTHORITY_VERSION_CONFLICT", status: 409 });
    expect(await authorityMutationSnapshot(fixture.tenant.organizationId)).toEqual(before);
  });

  for (const scenario of [
    {
      label: "child",
      install: `
            create function crm_test_fail_authority_child() returns trigger
            language plpgsql as $$ begin raise exception 'synthetic child failure'; end; $$;
            create trigger crm_test_fail_authority_child_trigger
            before insert on source_authority_transitions
            for each row execute function crm_test_fail_authority_child();
          `,
      remove: `
            drop trigger if exists crm_test_fail_authority_child_trigger on source_authority_transitions;
            drop function if exists crm_test_fail_authority_child();
          `,
    },
    {
      label: "head",
      install: `
            create function crm_test_fail_authority_head() returns trigger
            language plpgsql as $$
            begin
              if new.authority_state = 'CANONICAL_WRITABLE' then
                raise exception 'synthetic head failure';
              end if;
              return new;
            end; $$;
            create trigger crm_test_fail_authority_head_trigger
            before update on migration_domain_authorities
            for each row execute function crm_test_fail_authority_head();
          `,
      remove: `
            drop trigger if exists crm_test_fail_authority_head_trigger on migration_domain_authorities;
            drop function if exists crm_test_fail_authority_head();
          `,
    },
    {
      label: "audit",
      install: `
            create function crm_test_fail_authority_audit() returns trigger
            language plpgsql as $$
            begin
              if new.action = 'MIGRATION_AUTHORITY_SWITCHED' then
                raise exception 'synthetic audit failure';
              end if;
              return new;
            end; $$;
            create trigger crm_test_fail_authority_audit_trigger
            before insert on audit_events
            for each row execute function crm_test_fail_authority_audit();
          `,
      remove: `
            drop trigger if exists crm_test_fail_authority_audit_trigger on audit_events;
            drop function if exists crm_test_fail_authority_audit();
          `,
    },
    {
      label: "outbox",
      install: `
            create function crm_test_fail_authority_outbox() returns trigger
            language plpgsql as $$
            begin
              if new.event_type = 'crm.migration.authority_switched' then
                raise exception 'synthetic outbox failure';
              end if;
              return new;
            end; $$;
            create trigger crm_test_fail_authority_outbox_trigger
            before insert on outbox_events
            for each row execute function crm_test_fail_authority_outbox();
          `,
      remove: `
            drop trigger if exists crm_test_fail_authority_outbox_trigger on outbox_events;
            drop function if exists crm_test_fail_authority_outbox();
          `,
    },
  ] as const) {
    it(
      `rolls back every authority mutation and sanitizes a ${scenario.label} failure`,
      async () => {
        const fixture = await seedCutoverFixture();
        const beforeState = await authorityMutationSnapshot(fixture.tenant.organizationId);
        await sql.unsafe(scenario.install);
        let failure: unknown;
        try {
          try {
            await transitionSourceAuthorityGroup(
              fixture.tenant.authorityActor,
              fixture.input,
              fixture.verifier,
            );
          } catch (error: unknown) {
            failure = error;
          }
        } finally {
          await sql.unsafe(scenario.remove);
        }
        expect(failure, scenario.label).toMatchObject({
          code: "AUTHORITY_TRANSITION_FAILED",
          status: 500,
        });
        const exposed = `${String(failure)} ${JSON.stringify(failure)}`;
        for (const forbidden of [
          `synthetic ${scenario.label} failure`,
          `crm_test_fail_authority_${scenario.label}`,
          "source_authority_transitions_group_member_unique",
          "migration_domain_authorities_scope_fk",
          "source_authority_transition_groups_idempotency_unique",
        ]) {
          expect(exposed, `${scenario.label}: ${forbidden}`).not.toContain(forbidden);
        }

        const [counts] = await sql<{
          groups: number;
          transitions: number;
          audits: number;
          outbox: number;
          canonical_heads: number;
          archived_scopes: number;
          non_active_sources: number;
        }[]>`
          select
            (select count(*)::int from source_authority_transition_groups
              where organization_id = ${fixture.tenant.organizationId}) as groups,
            (select count(*)::int from source_authority_transitions
              where organization_id = ${fixture.tenant.organizationId}) as transitions,
            (select count(*)::int from audit_events
              where organization_id = ${fixture.tenant.organizationId}
                and target_id = ${fixture.input.cutoverGroupId}) as audits,
            (select count(*)::int from outbox_events
              where organization_id = ${fixture.tenant.organizationId}
                and aggregate_id = ${fixture.input.cutoverGroupId}) as outbox,
            (select count(*)::int from migration_domain_authorities
              where organization_id = ${fixture.tenant.organizationId}
                and authority_state = 'CANONICAL_WRITABLE') as canonical_heads,
            (select count(*)::int from migration_source_scopes
              where organization_id = ${fixture.tenant.organizationId}
                and source_status = 'ARCHIVED_READ_ONLY') as archived_scopes,
            (select count(*)::int from migration_sources
              where organization_id = ${fixture.tenant.organizationId}
                and status <> 'ACTIVE') as non_active_sources
        `;
        expect(counts, scenario.label).toEqual({
          groups: 0,
          transitions: 0,
          audits: 0,
          outbox: 0,
          canonical_heads: 0,
          archived_scopes: 0,
          non_active_sources: 0,
        });
        expect(
          await authorityMutationSnapshot(fixture.tenant.organizationId),
          scenario.label,
        ).toEqual(beforeState);
      },
      20_000,
    );
  }
});

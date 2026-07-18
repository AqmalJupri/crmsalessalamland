import { createHash, randomUUID } from "node:crypto";
import type { Sql } from "postgres";

interface SeedReconciliationLifecycleInput {
  organizationId: string;
  businessUnitId: string;
  batchId: string;
  signed?: boolean;
  approvalReason?: string;
}

export interface SeededReconciliationLifecycle {
  runId: string;
  signerUserId: string | null;
  signerMembershipId: string | null;
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function protectedRef(label: string): string {
  return `protected://integration-fixtures/${label}/${randomUUID()}`;
}

export async function seedReconciliationLifecycle(
  database: Sql,
  input: SeedReconciliationLifecycleInput,
): Promise<SeededReconciliationLifecycle> {
  const runId = randomUUID();
  const signerUserId = input.signed === false ? null : randomUUID();
  const signerMembershipId = input.signed === false ? null : randomUUID();
  const approvalReason =
    input.approvalReason ?? "Synthetic independent reconciliation review complete";
  const requiredChecks = [
    {
      check_kind: "COUNT",
      check_key: "records.total",
      scope_key: "all",
      measure_unit: null,
      decimal_scale: null,
    },
  ];

  await database.begin(async (transaction) => {
    if (signerUserId !== null && signerMembershipId !== null) {
      await transaction`
        insert into users (id, auth_subject, display_name, user_type, status)
        values (
          ${signerUserId}, ${`reconciliation-fixture:${signerUserId}`},
          'Synthetic Reconciliation Signer', 'HUMAN', 'ACTIVE'
        )
      `;
      await transaction`
        insert into memberships (
          id, organization_id, business_unit_id, user_id, status, valid_from
        ) values (
          ${signerMembershipId}, ${input.organizationId}, ${input.businessUnitId},
          ${signerUserId}, 'ACTIVE', clock_timestamp() - interval '1 day'
        )
      `;
    }

    const requiredChecksJson = transaction.json(requiredChecks);
    await transaction`
      insert into reconciliation_runs (
        id, organization_id, business_unit_id, batch_id, run_no, status,
        plan_artifact_ref, plan_sha256, required_checks, required_checks_sha256,
        required_check_count, passed_check_count, failed_check_count
      ) values (
        ${runId}, ${input.organizationId}, ${input.businessUnitId}, ${input.batchId},
        1, 'PASSED', ${protectedRef("reconciliation-plan")}, ${sha256(`plan:${runId}`)},
        ${requiredChecksJson},
        digest(convert_to(${requiredChecksJson}::jsonb::text, 'UTF8'), 'sha256'),
        1, 1, 0
      )
    `;
    await transaction`
      insert into reconciliation_results (
        organization_id, business_unit_id, run_id, check_kind, check_key,
        scope_key, source_count, target_count, measure_unit, decimal_scale,
        passed, evidence_metadata
      ) values (
        ${input.organizationId}, ${input.businessUnitId}, ${runId}, 'COUNT',
        'records.total', 'all', 1, 1, null, null, true, '{}'::jsonb
      )
    `;

    if (signerUserId === null || signerMembershipId === null) return;

    await transaction`
      update reconciliation_runs
      set status = 'SIGNED', signed_by_membership_id = ${signerMembershipId}
      where organization_id = ${input.organizationId}
        and business_unit_id = ${input.businessUnitId}
        and id = ${runId}
        and status = 'PASSED'
    `;
    await transaction`
      update import_batches set status = 'RECONCILED'
      where organization_id = ${input.organizationId}
        and business_unit_id = ${input.businessUnitId}
        and id = ${input.batchId}
        and status = 'APPLIED'
    `;

    const effect = transaction.json({
      schemaVersion: 1,
      runId,
      batchId: input.batchId,
      previousBatchStatus: "APPLIED",
      batchStatus: "RECONCILED",
      approvalReason,
      signerMembershipId,
    });
    await transaction`
      insert into audit_events (
        organization_id, business_unit_id, actor_type, actor_user_id,
        action, target_type, target_id, outcome, reason, correlation_id,
        change_summary, occurred_at, recorded_at, created_at
      ) values (
        ${input.organizationId}, ${input.businessUnitId},
        (select signed_actor_type from reconciliation_runs where id = ${runId}),
        (select signed_actor_user_id from reconciliation_runs where id = ${runId}),
        'MIGRATION_RECONCILIATION_RUN_SIGNED', 'RECONCILIATION_RUN', ${runId},
        'SUCCESS', ${approvalReason}, ${input.batchId}, ${effect},
        (select signed_at from reconciliation_runs where id = ${runId}),
        (select signed_at from reconciliation_runs where id = ${runId}),
        (select signed_at from reconciliation_runs where id = ${runId})
      )
    `;
    await transaction`
      insert into outbox_events (
        organization_id, business_unit_id, event_type, event_version,
        aggregate_type, aggregate_id, aggregate_version, actor_type, actor_user_id,
        correlation_id, payload, occurred_at, created_at
      ) values (
        ${input.organizationId}, ${input.businessUnitId},
        'crm.migration.reconciliation_run_signed', 1,
        'RECONCILIATION_RUN', ${runId},
        (select version from reconciliation_runs where id = ${runId}),
        (select signed_actor_type from reconciliation_runs where id = ${runId}),
        (select signed_actor_user_id from reconciliation_runs where id = ${runId}),
        ${input.batchId}, ${effect},
        (select signed_at from reconciliation_runs where id = ${runId}),
        (select signed_at from reconciliation_runs where id = ${runId})
      )
    `;
    await transaction.unsafe("set constraints all immediate");
  });

  return { runId, signerUserId, signerMembershipId };
}

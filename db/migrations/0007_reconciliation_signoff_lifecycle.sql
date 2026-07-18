-- Bind reconciliation signing, terminal batch state, and durable effect proof.

CREATE UNIQUE INDEX reconciliation_sign_audit_once
  ON public.audit_events (organization_id, business_unit_id, target_id)
  WHERE action = 'MIGRATION_RECONCILIATION_RUN_SIGNED'
    AND target_type = 'RECONCILIATION_RUN'
    AND outcome = 'SUCCESS'
    AND target_id IS NOT NULL;

CREATE UNIQUE INDEX reconciliation_sign_outbox_once
  ON public.outbox_events (organization_id, business_unit_id, aggregate_id)
  WHERE event_type = 'crm.migration.reconciliation_run_signed'
    AND aggregate_type = 'RECONCILIATION_RUN';

CREATE OR REPLACE FUNCTION public.crm_guard_reconciliation_sign_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  parent_status text;
  parent_approved_by_membership_id uuid;
  parent_applied_by_membership_id uuid;
  approver_user_id uuid;
  applier_user_id uuid;
  signer_user_id uuid;
  signer_business_unit_id uuid;
  signer_membership_status text;
  signer_valid_from timestamptz;
  signer_valid_until timestamptz;
  signer_user_status text;
BEGIN
  SELECT batch.status, batch.approved_by_membership_id, batch.applied_by_membership_id
    INTO parent_status, parent_approved_by_membership_id, parent_applied_by_membership_id
    FROM public.import_batches batch
   WHERE batch.organization_id = NEW.organization_id
     AND batch.business_unit_id = NEW.business_unit_id
     AND batch.id = NEW.batch_id
   FOR NO KEY UPDATE NOWAIT;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'reconciliation run parent batch does not exist in tenant scope'
      USING ERRCODE = '23503';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'SIGNED' THEN
      RAISE EXCEPTION 'reconciliation runs cannot be inserted already signed'
        USING ERRCODE = '55000';
    END IF;
    IF parent_status = 'RECONCILED' THEN
      RAISE EXCEPTION 'a reconciled import batch cannot accept a new reconciliation attempt'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM 'SIGNED' OR OLD.status = 'SIGNED' THEN
    RETURN NEW;
  END IF;

  IF OLD.status <> 'PASSED' THEN
    RAISE EXCEPTION 'reconciliation signing requires a PASSED to SIGNED transition'
      USING ERRCODE = '55000';
  END IF;

  IF
    pg_catalog.to_jsonb(NEW) - ARRAY[
      'status', 'signed_by_membership_id', 'signed_at', 'version', 'updated_at'
    ]
    IS DISTINCT FROM
    pg_catalog.to_jsonb(OLD) - ARRAY[
      'status', 'signed_by_membership_id', 'signed_at', 'version', 'updated_at'
    ]
  THEN
    RAISE EXCEPTION 'reconciliation signing cannot mutate the passed evidence envelope'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.signed_by_membership_id IS NULL OR NEW.signed_at IS NULL THEN
    RAISE EXCEPTION 'reconciliation signing requires signer and timestamp provenance'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.signed_at IS DISTINCT FROM pg_catalog.transaction_timestamp() THEN
    RAISE EXCEPTION 'reconciliation signed timestamp must be the current transaction timestamp'
      USING ERRCODE = '23514';
  END IF;

  IF parent_status <> 'APPLIED' THEN
    RAISE EXCEPTION 'only an APPLIED import batch can enter reconciliation sign-off'
      USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.reconciliation_runs later_run
     WHERE later_run.organization_id = NEW.organization_id
       AND later_run.business_unit_id = NEW.business_unit_id
       AND later_run.batch_id = NEW.batch_id
       AND later_run.run_no > NEW.run_no
  ) THEN
    RAISE EXCEPTION 'only the latest reconciliation attempt can be signed'
      USING ERRCODE = '55000';
  END IF;

  IF
    parent_approved_by_membership_id IS NULL
    OR parent_applied_by_membership_id IS NULL
  THEN
    RAISE EXCEPTION 'reconciliation sign-off requires durable approval and apply provenance'
      USING ERRCODE = '23514';
  END IF;

  PERFORM membership.id
    FROM public.memberships membership
   WHERE membership.organization_id = NEW.organization_id
     AND membership.id = ANY(ARRAY[
       parent_approved_by_membership_id,
       parent_applied_by_membership_id,
       NEW.signed_by_membership_id
     ])
   ORDER BY membership.id
   FOR SHARE;

  SELECT approver.user_id, applier.user_id, signer.user_id,
         signer.business_unit_id, signer.status, signer.valid_from, signer.valid_until,
         signer_user.status
    INTO approver_user_id, applier_user_id, signer_user_id,
         signer_business_unit_id, signer_membership_status,
         signer_valid_from, signer_valid_until, signer_user_status
    FROM public.memberships approver
    JOIN public.memberships applier
      ON applier.organization_id = NEW.organization_id
     AND applier.id = parent_applied_by_membership_id
    JOIN public.memberships signer
      ON signer.organization_id = NEW.organization_id
     AND signer.id = NEW.signed_by_membership_id
    JOIN public.users signer_user
      ON signer_user.id = signer.user_id
   WHERE approver.organization_id = NEW.organization_id
     AND approver.id = parent_approved_by_membership_id
   FOR SHARE OF signer_user;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'reconciliation approval, apply, or signer provenance is missing'
      USING ERRCODE = '23503';
  END IF;

  IF
    signer_business_unit_id IS NOT NULL
    AND signer_business_unit_id IS DISTINCT FROM NEW.business_unit_id
  THEN
    RAISE EXCEPTION 'reconciliation signer membership scope does not match the batch'
      USING ERRCODE = '23514';
  END IF;

  IF
    signer_membership_status <> 'ACTIVE'
    OR signer_user_status <> 'ACTIVE'
    OR signer_valid_from > pg_catalog.transaction_timestamp()
    OR (
      signer_valid_until IS NOT NULL
      AND signer_valid_until <= pg_catalog.transaction_timestamp()
    )
  THEN
    RAISE EXCEPTION 'reconciliation signer membership is not active at sign-off'
      USING ERRCODE = '23514';
  END IF;

  IF signer_user_id = approver_user_id OR signer_user_id = applier_user_id THEN
    RAISE EXCEPTION 'reconciliation signer must be a different person from approver and applier'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.crm_guard_signed_reconciliation_outbox()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.event_type = 'crm.migration.reconciliation_run_signed' THEN
      RAISE EXCEPTION 'signed reconciliation outbox proof is immutable and must be retained'
        USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;

  IF
    OLD.event_type = 'crm.migration.reconciliation_run_signed'
    OR NEW.event_type = 'crm.migration.reconciliation_run_signed'
  THEN
    IF
      NEW.id IS DISTINCT FROM OLD.id
      OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
      OR NEW.business_unit_id IS DISTINCT FROM OLD.business_unit_id
      OR NEW.event_type IS DISTINCT FROM OLD.event_type
      OR NEW.event_version IS DISTINCT FROM OLD.event_version
      OR NEW.aggregate_type IS DISTINCT FROM OLD.aggregate_type
      OR NEW.aggregate_id IS DISTINCT FROM OLD.aggregate_id
      OR NEW.aggregate_version IS DISTINCT FROM OLD.aggregate_version
      OR NEW.actor_type IS DISTINCT FROM OLD.actor_type
      OR NEW.actor_user_id IS DISTINCT FROM OLD.actor_user_id
      OR NEW.correlation_id IS DISTINCT FROM OLD.correlation_id
      OR NEW.causation_event_id IS DISTINCT FROM OLD.causation_event_id
      OR NEW.payload IS DISTINCT FROM OLD.payload
      OR NEW.occurred_at IS DISTINCT FROM OLD.occurred_at
      OR NEW.created_at IS DISTINCT FROM OLD.created_at
    THEN
      RAISE EXCEPTION 'signed reconciliation outbox proof envelope is immutable'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.crm_assert_reconciliation_sign_lifecycle(
  checked_batch_id uuid
)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  batch_organization_id uuid;
  batch_business_unit_id uuid;
  batch_status text;
  batch_approved_by_membership_id uuid;
  batch_applied_by_membership_id uuid;
  latest_run_no integer;
  signed_run_count bigint;
  signed_run_id uuid;
  signed_run_no integer;
  signed_run_version bigint;
  signed_by_membership_id uuid;
  signed_run_is_current_transaction boolean;
  approver_user_id uuid;
  applier_user_id uuid;
  signer_user_id uuid;
  signer_user_type text;
  signer_user_status text;
  signer_business_unit_id uuid;
  signer_membership_status text;
  signer_valid_from timestamptz;
  signer_valid_until timestamptz;
  expected_actor_type text;
  expected_effect jsonb;
  audit_count bigint;
  audit_organization_id uuid;
  audit_business_unit_id uuid;
  audit_actor_type text;
  audit_actor_user_id uuid;
  audit_reason text;
  audit_correlation_id uuid;
  audit_change_summary jsonb;
  outbox_count bigint;
  outbox_organization_id uuid;
  outbox_business_unit_id uuid;
  outbox_event_version integer;
  outbox_aggregate_version bigint;
  outbox_actor_type text;
  outbox_actor_user_id uuid;
  outbox_correlation_id uuid;
  outbox_payload jsonb;
BEGIN
  SELECT batch.organization_id, batch.business_unit_id, batch.status,
         batch.approved_by_membership_id, batch.applied_by_membership_id
    INTO batch_organization_id, batch_business_unit_id, batch_status,
         batch_approved_by_membership_id, batch_applied_by_membership_id
    FROM public.import_batches batch
   WHERE batch.id = checked_batch_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'reconciliation lifecycle parent batch does not exist'
      USING ERRCODE = '23503';
  END IF;

  SELECT pg_catalog.max(run.run_no),
         pg_catalog.count(*) FILTER (WHERE run.status = 'SIGNED')
    INTO latest_run_no, signed_run_count
    FROM public.reconciliation_runs run
   WHERE run.organization_id = batch_organization_id
     AND run.business_unit_id = batch_business_unit_id
     AND run.batch_id = checked_batch_id;

  IF signed_run_count = 1 THEN
    -- Other transactions' in-progress tuples are MVCC-invisible here. An in-progress
    -- visible xmin therefore belongs to this transaction, including a released savepoint.
    SELECT run.id, run.run_no, run.version, run.signed_by_membership_id,
           (
             run.xmin = (pg_catalog.pg_current_xact_id()::text)::pg_catalog.xid
             OR pg_catalog.pg_xact_status(
               (run.xmin::text)::pg_catalog.xid8
             ) = 'in progress'
           )
      INTO signed_run_id, signed_run_no, signed_run_version, signed_by_membership_id,
           signed_run_is_current_transaction
      FROM public.reconciliation_runs run
     WHERE run.organization_id = batch_organization_id
       AND run.business_unit_id = batch_business_unit_id
       AND run.batch_id = checked_batch_id
       AND run.status = 'SIGNED';
  END IF;

  IF batch_status = 'RECONCILED' THEN
    IF
      signed_run_count <> 1
      OR signed_run_no IS DISTINCT FROM latest_run_no
      OR signed_run_id IS NULL
    THEN
      RAISE EXCEPTION 'RECONCILED import batch requires exactly one latest SIGNED run'
        USING ERRCODE = '23514';
    END IF;
  ELSIF signed_run_count <> 0 THEN
    RAISE EXCEPTION 'SIGNED reconciliation run requires a RECONCILED import batch'
      USING ERRCODE = '23514';
  ELSE
    RETURN;
  END IF;

  SELECT approver.user_id, applier.user_id, signer.user_id,
         signer_user.user_type, signer_user.status, signer.business_unit_id,
         signer.status, signer.valid_from, signer.valid_until
    INTO approver_user_id, applier_user_id, signer_user_id,
         signer_user_type, signer_user_status, signer_business_unit_id,
         signer_membership_status, signer_valid_from, signer_valid_until
    FROM public.memberships approver
    JOIN public.memberships applier
      ON applier.organization_id = batch_organization_id
     AND applier.id = batch_applied_by_membership_id
    JOIN public.memberships signer
      ON signer.organization_id = batch_organization_id
     AND signer.id = signed_by_membership_id
    JOIN public.users signer_user
      ON signer_user.id = signer.user_id
   WHERE approver.organization_id = batch_organization_id
     AND approver.id = batch_approved_by_membership_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'signed reconciliation provenance is incomplete'
      USING ERRCODE = '23514';
  END IF;

  IF
    signer_business_unit_id IS NOT NULL
    AND signer_business_unit_id IS DISTINCT FROM batch_business_unit_id
  THEN
    RAISE EXCEPTION 'signed reconciliation signer scope is invalid'
      USING ERRCODE = '23514';
  END IF;

  IF signer_user_id = approver_user_id OR signer_user_id = applier_user_id THEN
    RAISE EXCEPTION 'signed reconciliation violates maker-checker user separation'
      USING ERRCODE = '23514';
  END IF;

  IF signed_run_is_current_transaction THEN
    IF
      signer_membership_status <> 'ACTIVE'
      OR signer_user_status <> 'ACTIVE'
      OR signer_valid_from > pg_catalog.transaction_timestamp()
      OR (
        signer_valid_until IS NOT NULL
        AND signer_valid_until <= pg_catalog.transaction_timestamp()
      )
    THEN
      RAISE EXCEPTION 'reconciliation signer is not active at transaction sign-off'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  expected_actor_type := CASE signer_user_type
    WHEN 'SERVICE' THEN 'SERVICE'
    ELSE 'USER'
  END;

  SELECT pg_catalog.count(*)
    INTO audit_count
    FROM public.audit_events audit
   WHERE audit.action = 'MIGRATION_RECONCILIATION_RUN_SIGNED'
     AND audit.target_type = 'RECONCILIATION_RUN'
     AND audit.target_id = signed_run_id
     AND audit.outcome = 'SUCCESS';

  IF audit_count <> 1 THEN
    RAISE EXCEPTION 'signed reconciliation requires exactly one successful audit proof'
      USING ERRCODE = '23514';
  END IF;

  SELECT audit.organization_id, audit.business_unit_id, audit.actor_type,
         audit.actor_user_id, audit.reason, audit.correlation_id, audit.change_summary
    INTO audit_organization_id, audit_business_unit_id, audit_actor_type,
         audit_actor_user_id, audit_reason, audit_correlation_id, audit_change_summary
    FROM public.audit_events audit
   WHERE audit.action = 'MIGRATION_RECONCILIATION_RUN_SIGNED'
     AND audit.target_type = 'RECONCILIATION_RUN'
     AND audit.target_id = signed_run_id
     AND audit.outcome = 'SUCCESS';

  IF
    audit_reason IS NULL
    OR pg_catalog.char_length(audit_reason) NOT BETWEEN 1 AND 2000
    OR audit_reason IS DISTINCT FROM pg_catalog.btrim(audit_reason)
  THEN
    RAISE EXCEPTION 'signed reconciliation audit reason is invalid'
      USING ERRCODE = '23514';
  END IF;

  expected_effect := pg_catalog.jsonb_build_object(
    'schemaVersion', 1,
    'runId', signed_run_id,
    'batchId', checked_batch_id,
    'previousBatchStatus', 'APPLIED',
    'batchStatus', 'RECONCILED',
    'approvalReason', audit_reason,
    'signerMembershipId', signed_by_membership_id
  );

  IF
    audit_organization_id IS DISTINCT FROM batch_organization_id
    OR audit_business_unit_id IS DISTINCT FROM batch_business_unit_id
    OR audit_actor_type NOT IN ('USER', 'SERVICE')
    OR (
      signed_run_is_current_transaction
      AND audit_actor_type IS DISTINCT FROM expected_actor_type
    )
    OR audit_actor_user_id IS DISTINCT FROM signer_user_id
    OR audit_correlation_id IS DISTINCT FROM checked_batch_id
    OR audit_change_summary IS DISTINCT FROM expected_effect
  THEN
    RAISE EXCEPTION 'signed reconciliation audit proof is divergent'
      USING ERRCODE = '23514';
  END IF;

  SELECT pg_catalog.count(*)
    INTO outbox_count
    FROM public.outbox_events event
   WHERE event.event_type = 'crm.migration.reconciliation_run_signed'
     AND event.aggregate_type = 'RECONCILIATION_RUN'
     AND event.aggregate_id = signed_run_id;

  IF outbox_count <> 1 THEN
    RAISE EXCEPTION 'signed reconciliation requires exactly one outbox proof'
      USING ERRCODE = '23514';
  END IF;

  SELECT event.organization_id, event.business_unit_id, event.event_version,
         event.aggregate_version, event.actor_type, event.actor_user_id,
         event.correlation_id, event.payload
    INTO outbox_organization_id, outbox_business_unit_id, outbox_event_version,
         outbox_aggregate_version, outbox_actor_type, outbox_actor_user_id,
         outbox_correlation_id, outbox_payload
    FROM public.outbox_events event
   WHERE event.event_type = 'crm.migration.reconciliation_run_signed'
     AND event.aggregate_type = 'RECONCILIATION_RUN'
     AND event.aggregate_id = signed_run_id;

  IF
    outbox_organization_id IS DISTINCT FROM batch_organization_id
    OR outbox_business_unit_id IS DISTINCT FROM batch_business_unit_id
    OR outbox_event_version IS DISTINCT FROM 1
    OR outbox_aggregate_version IS DISTINCT FROM signed_run_version
    OR outbox_actor_type IS DISTINCT FROM audit_actor_type
    OR outbox_actor_user_id IS DISTINCT FROM signer_user_id
    OR outbox_correlation_id IS DISTINCT FROM checked_batch_id
    OR outbox_payload IS DISTINCT FROM expected_effect
  THEN
    RAISE EXCEPTION 'signed reconciliation outbox proof is divergent'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.crm_validate_reconciliation_sign_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  old_data jsonb;
  new_data jsonb;
  affected_batch_ids uuid[] := ARRAY[]::uuid[];
  affected_membership_ids uuid[] := ARRAY[]::uuid[];
  affected_user_ids uuid[] := ARRAY[]::uuid[];
  proof_run_id uuid;
  proof_run_status text;
  affected_batch_id uuid;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    old_data := pg_catalog.to_jsonb(OLD);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    new_data := pg_catalog.to_jsonb(NEW);
  END IF;

  IF TG_TABLE_NAME = 'reconciliation_runs' THEN
    IF old_data IS NOT NULL THEN
      affected_batch_ids := pg_catalog.array_append(
        affected_batch_ids, (old_data ->> 'batch_id')::uuid
      );
    END IF;
    IF new_data IS NOT NULL THEN
      affected_batch_ids := pg_catalog.array_append(
        affected_batch_ids, (new_data ->> 'batch_id')::uuid
      );
    END IF;
  ELSIF TG_TABLE_NAME = 'import_batches' THEN
    IF old_data IS NOT NULL THEN
      affected_batch_ids := pg_catalog.array_append(
        affected_batch_ids, (old_data ->> 'id')::uuid
      );
    END IF;
    IF new_data IS NOT NULL THEN
      affected_batch_ids := pg_catalog.array_append(
        affected_batch_ids, (new_data ->> 'id')::uuid
      );
    END IF;
  ELSIF TG_TABLE_NAME = 'audit_events' THEN
    IF
      new_data ->> 'action' <> 'MIGRATION_RECONCILIATION_RUN_SIGNED'
      OR new_data ->> 'outcome' <> 'SUCCESS'
    THEN
      RETURN NULL;
    END IF;
    IF
      new_data ->> 'target_type' <> 'RECONCILIATION_RUN'
      OR new_data ->> 'target_id' IS NULL
    THEN
      RAISE EXCEPTION 'orphan successful reconciliation sign audit proof'
        USING ERRCODE = '23514';
    END IF;
    proof_run_id := (new_data ->> 'target_id')::uuid;
    SELECT run.batch_id, run.status
      INTO affected_batch_id, proof_run_status
      FROM public.reconciliation_runs run
     WHERE run.id = proof_run_id;
    IF NOT FOUND OR proof_run_status <> 'SIGNED' THEN
      RAISE EXCEPTION 'orphan successful reconciliation sign audit proof'
        USING ERRCODE = '23514';
    END IF;
    affected_batch_ids := pg_catalog.array_append(affected_batch_ids, affected_batch_id);
  ELSIF TG_TABLE_NAME = 'outbox_events' THEN
    IF
      (old_data IS NULL OR old_data ->> 'event_type' <> 'crm.migration.reconciliation_run_signed')
      AND (new_data IS NULL OR new_data ->> 'event_type' <> 'crm.migration.reconciliation_run_signed')
    THEN
      RETURN NULL;
    END IF;
    IF
      COALESCE(new_data, old_data) ->> 'aggregate_type' <> 'RECONCILIATION_RUN'
    THEN
      RAISE EXCEPTION 'orphan reconciliation sign outbox proof'
        USING ERRCODE = '23514';
    END IF;
    proof_run_id := (COALESCE(new_data, old_data) ->> 'aggregate_id')::uuid;
    SELECT run.batch_id, run.status
      INTO affected_batch_id, proof_run_status
      FROM public.reconciliation_runs run
     WHERE run.id = proof_run_id;
    IF NOT FOUND OR proof_run_status <> 'SIGNED' THEN
      RAISE EXCEPTION 'orphan reconciliation sign outbox proof'
        USING ERRCODE = '23514';
    END IF;
    affected_batch_ids := pg_catalog.array_append(affected_batch_ids, affected_batch_id);
  ELSIF TG_TABLE_NAME = 'memberships' THEN
    IF old_data IS NOT NULL THEN
      affected_membership_ids := pg_catalog.array_append(
        affected_membership_ids, (old_data ->> 'id')::uuid
      );
    END IF;
    IF new_data IS NOT NULL THEN
      affected_membership_ids := pg_catalog.array_append(
        affected_membership_ids, (new_data ->> 'id')::uuid
      );
    END IF;
    SELECT COALESCE(
             pg_catalog.array_agg(DISTINCT run.batch_id), ARRAY[]::uuid[]
           )
      INTO affected_batch_ids
      FROM public.reconciliation_runs run
     WHERE run.status = 'SIGNED'
       AND (
         run.xmin = (pg_catalog.pg_current_xact_id()::text)::pg_catalog.xid
         OR pg_catalog.pg_xact_status(
           (run.xmin::text)::pg_catalog.xid8
         ) = 'in progress'
       )
       AND run.signed_by_membership_id = ANY(affected_membership_ids);
  ELSIF TG_TABLE_NAME = 'users' THEN
    IF old_data IS NOT NULL THEN
      affected_user_ids := pg_catalog.array_append(
        affected_user_ids, (old_data ->> 'id')::uuid
      );
    END IF;
    IF new_data IS NOT NULL THEN
      affected_user_ids := pg_catalog.array_append(
        affected_user_ids, (new_data ->> 'id')::uuid
      );
    END IF;
    SELECT COALESCE(
             pg_catalog.array_agg(DISTINCT run.batch_id), ARRAY[]::uuid[]
           )
      INTO affected_batch_ids
      FROM public.reconciliation_runs run
      JOIN public.memberships signer
        ON signer.organization_id = run.organization_id
       AND signer.id = run.signed_by_membership_id
     WHERE run.status = 'SIGNED'
       AND (
         run.xmin = (pg_catalog.pg_current_xact_id()::text)::pg_catalog.xid
         OR pg_catalog.pg_xact_status(
           (run.xmin::text)::pg_catalog.xid8
         ) = 'in progress'
       )
       AND signer.user_id = ANY(affected_user_ids);
  END IF;

  FOR affected_batch_id IN
    SELECT DISTINCT candidate
      FROM pg_catalog.unnest(affected_batch_ids) AS candidate
     WHERE candidate IS NOT NULL
     ORDER BY candidate
  LOOP
    PERFORM public.crm_assert_reconciliation_sign_lifecycle(affected_batch_id);
  END LOOP;

  RETURN NULL;
END;
$$;

CREATE TRIGGER reconciliation_runs_sign_lifecycle_guard
BEFORE INSERT OR UPDATE ON public.reconciliation_runs
FOR EACH ROW EXECUTE FUNCTION public.crm_guard_reconciliation_sign_lifecycle();

CREATE TRIGGER reconciliation_signed_outbox_guard
BEFORE UPDATE OR DELETE ON public.outbox_events
FOR EACH ROW EXECUTE FUNCTION public.crm_guard_signed_reconciliation_outbox();

CREATE TRIGGER reconciliation_signed_outbox_no_truncate
BEFORE TRUNCATE ON public.outbox_events
FOR EACH STATEMENT EXECUTE FUNCTION public.crm_block_mutation();

CREATE CONSTRAINT TRIGGER migration_reconciliation_lifecycle_from_run_guard
AFTER INSERT OR UPDATE OR DELETE ON public.reconciliation_runs
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.crm_validate_reconciliation_sign_lifecycle();

CREATE CONSTRAINT TRIGGER migration_reconciliation_lifecycle_from_batch_guard
AFTER INSERT OR UPDATE OR DELETE ON public.import_batches
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.crm_validate_reconciliation_sign_lifecycle();

CREATE CONSTRAINT TRIGGER migration_reconciliation_lifecycle_from_audit_guard
AFTER INSERT ON public.audit_events
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.crm_validate_reconciliation_sign_lifecycle();

CREATE CONSTRAINT TRIGGER migration_reconciliation_lifecycle_from_outbox_guard
AFTER INSERT OR UPDATE OR DELETE ON public.outbox_events
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.crm_validate_reconciliation_sign_lifecycle();

CREATE CONSTRAINT TRIGGER migration_reconciliation_lifecycle_from_membership_guard
AFTER UPDATE OR DELETE ON public.memberships
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.crm_validate_reconciliation_sign_lifecycle();

CREATE CONSTRAINT TRIGGER migration_reconciliation_lifecycle_from_user_guard
AFTER UPDATE OR DELETE ON public.users
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.crm_validate_reconciliation_sign_lifecycle();

DO $$
DECLARE
  invalid_proof_id uuid;
  existing_batch_id uuid;
BEGIN
  SELECT audit.id
    INTO invalid_proof_id
    FROM public.audit_events audit
    LEFT JOIN public.reconciliation_runs run
      ON run.id = audit.target_id
   WHERE audit.action = 'MIGRATION_RECONCILIATION_RUN_SIGNED'
     AND audit.outcome = 'SUCCESS'
     AND (
       audit.target_type <> 'RECONCILIATION_RUN'
       OR audit.target_id IS NULL
       OR run.id IS NULL
       OR run.status <> 'SIGNED'
     )
   LIMIT 1;
  IF invalid_proof_id IS NOT NULL THEN
    RAISE EXCEPTION 'orphan successful reconciliation sign audit proof %', invalid_proof_id
      USING ERRCODE = '23514';
  END IF;

  SELECT event.id
    INTO invalid_proof_id
    FROM public.outbox_events event
    LEFT JOIN public.reconciliation_runs run
      ON run.id = event.aggregate_id
   WHERE event.event_type = 'crm.migration.reconciliation_run_signed'
     AND (
       event.aggregate_type <> 'RECONCILIATION_RUN'
       OR run.id IS NULL
       OR run.status <> 'SIGNED'
     )
   LIMIT 1;
  IF invalid_proof_id IS NOT NULL THEN
    RAISE EXCEPTION 'orphan reconciliation sign outbox proof %', invalid_proof_id
      USING ERRCODE = '23514';
  END IF;

  FOR existing_batch_id IN
    SELECT batch.id
      FROM public.import_batches batch
     WHERE batch.status = 'RECONCILED'
        OR EXISTS (
          SELECT 1
            FROM public.reconciliation_runs run
           WHERE run.batch_id = batch.id
             AND run.status = 'SIGNED'
        )
     ORDER BY batch.id
  LOOP
    PERFORM public.crm_assert_reconciliation_sign_lifecycle(existing_batch_id);
  END LOOP;
END;
$$;

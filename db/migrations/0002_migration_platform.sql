-- Migration control plane for governed, replay-safe legacy data onboarding.

CREATE TABLE migration_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_unit_id uuid NOT NULL,
  source_key text NOT NULL,
  source_kind text NOT NULL,
  source_mode text NOT NULL,
  owner_membership_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'REGISTERED',
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT migration_sources_business_unit_fk
    FOREIGN KEY (organization_id, business_unit_id)
    REFERENCES business_units (organization_id, id),
  CONSTRAINT migration_sources_owner_fk
    FOREIGN KEY (organization_id, owner_membership_id)
    REFERENCES memberships (organization_id, id),
  CONSTRAINT migration_sources_source_key_format CHECK (
    char_length(source_key) BETWEEN 1 AND 127
    AND source_key ~ '^[a-z][a-z0-9_-]*$'
  ),
  CONSTRAINT migration_sources_kind_valid CHECK (
    source_kind IN ('SALAM_CRM_JSON', 'TASHA_SQLITE', 'NIAGAWAN_CSV', 'BARAKAH_SHEET')
  ),
  CONSTRAINT migration_sources_mode_valid CHECK (
    source_mode IN ('ONE_TIME_MIGRATION', 'RECURRING_READ_ONLY_SNAPSHOT')
  ),
  CONSTRAINT migration_sources_status_valid CHECK (
    status IN ('REGISTERED', 'ACTIVE', 'ARCHIVED_READ_ONLY')
  ),
  CONSTRAINT migration_sources_version_positive CHECK (version >= 1),
  CONSTRAINT migration_sources_source_unique
    UNIQUE (organization_id, business_unit_id, source_key),
  CONSTRAINT migration_sources_tenant_bu_key
    UNIQUE (organization_id, business_unit_id, id)
);

CREATE TABLE migration_source_scopes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_unit_id uuid NOT NULL,
  migration_source_id uuid NOT NULL,
  domain_key text NOT NULL,
  canonical_target text NOT NULL,
  transition_mode text NOT NULL,
  source_status text NOT NULL DEFAULT 'REGISTERED',
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT migration_source_scopes_source_fk
    FOREIGN KEY (organization_id, business_unit_id, migration_source_id)
    REFERENCES migration_sources (organization_id, business_unit_id, id),
  CONSTRAINT migration_source_scopes_domain_format CHECK (
    char_length(domain_key) BETWEEN 1 AND 127
    AND domain_key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'
  ),
  CONSTRAINT migration_source_scopes_target_format CHECK (
    char_length(canonical_target) BETWEEN 1 AND 127
    AND canonical_target ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'
  ),
  CONSTRAINT migration_source_scopes_mode_valid CHECK (
    transition_mode IN ('ONE_TIME_CUTOVER', 'RECURRING_EXTERNAL_SNAPSHOT')
  ),
  CONSTRAINT migration_source_scopes_status_valid CHECK (
    source_status IN ('REGISTERED', 'ACTIVE_AUTHORITY', 'ARCHIVED_READ_ONLY')
  ),
  CONSTRAINT migration_source_scopes_version_positive CHECK (version >= 1),
  CONSTRAINT migration_source_scopes_domain_unique
    UNIQUE (organization_id, business_unit_id, migration_source_id, domain_key),
  CONSTRAINT migration_source_scopes_tenant_bu_key
    UNIQUE (organization_id, business_unit_id, id)
);

CREATE TABLE migration_domain_authorities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_unit_id uuid NOT NULL,
  domain_key text NOT NULL,
  canonical_target text NOT NULL,
  authority_state text NOT NULL,
  authority_source_scope_id uuid,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT migration_domain_authorities_business_unit_fk
    FOREIGN KEY (organization_id, business_unit_id)
    REFERENCES business_units (organization_id, id),
  CONSTRAINT migration_domain_authorities_scope_fk
    FOREIGN KEY (organization_id, business_unit_id, authority_source_scope_id)
    REFERENCES migration_source_scopes (organization_id, business_unit_id, id),
  CONSTRAINT migration_domain_authorities_domain_format CHECK (
    char_length(domain_key) BETWEEN 1 AND 127
    AND domain_key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'
  ),
  CONSTRAINT migration_domain_authorities_target_format CHECK (
    char_length(canonical_target) BETWEEN 1 AND 127
    AND canonical_target ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'
  ),
  CONSTRAINT migration_domain_authorities_state_valid CHECK (
    authority_state IN (
      'LEGACY_WRITABLE',
      'EXTERNAL_SYSTEM_AUTHORITY',
      'SHADOW_READ',
      'CANONICAL_WRITABLE'
    )
  ),
  CONSTRAINT migration_domain_authorities_scope_state CHECK (
    (authority_state = 'CANONICAL_WRITABLE' AND authority_source_scope_id IS NULL)
    OR
    (authority_state <> 'CANONICAL_WRITABLE' AND authority_source_scope_id IS NOT NULL)
  ),
  CONSTRAINT migration_domain_authorities_version_positive CHECK (version >= 1),
  CONSTRAINT migration_domain_authorities_domain_unique
    UNIQUE (organization_id, business_unit_id, domain_key),
  CONSTRAINT migration_domain_authorities_tenant_bu_key
    UNIQUE (organization_id, business_unit_id, id)
);

CREATE TABLE source_authority_transition_groups (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  group_size integer NOT NULL,
  group_sha256 bytea NOT NULL,
  plan_artifact_ref text NOT NULL,
  plan_sha256 bytea NOT NULL,
  effective_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  approved_by_membership_id uuid NOT NULL,
  approval_reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT transition_groups_organization_fk
    FOREIGN KEY (organization_id) REFERENCES organizations (id),
  CONSTRAINT transition_groups_approver_fk
    FOREIGN KEY (organization_id, approved_by_membership_id)
    REFERENCES memberships (organization_id, id),
  CONSTRAINT transition_groups_idempotency_nonempty CHECK (
    char_length(btrim(idempotency_key)) BETWEEN 1 AND 255
  ),
  CONSTRAINT transition_groups_size_positive CHECK (group_size > 0),
  CONSTRAINT transition_groups_group_sha256_valid CHECK (octet_length(group_sha256) = 32),
  CONSTRAINT transition_groups_plan_ref_nonempty CHECK (
    char_length(btrim(plan_artifact_ref)) BETWEEN 1 AND 2048
  ),
  CONSTRAINT transition_groups_plan_sha256_valid CHECK (octet_length(plan_sha256) = 32),
  CONSTRAINT transition_groups_reason_nonempty CHECK (
    char_length(btrim(approval_reason)) BETWEEN 1 AND 2000
  ),
  CONSTRAINT transition_groups_tenant_id_unique UNIQUE (organization_id, id),
  CONSTRAINT source_authority_transition_groups_idempotency_unique
    UNIQUE (organization_id, idempotency_key)
);

CREATE TABLE transform_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_unit_id uuid NOT NULL,
  migration_source_id uuid NOT NULL,
  version_no integer NOT NULL,
  source_schema_version text NOT NULL,
  mapping_artifact_ref text NOT NULL,
  mapping_sha256 bytea NOT NULL,
  release_manifest_ref text NOT NULL,
  release_manifest_sha256 bytea NOT NULL,
  transform_release_sha256 bytea NOT NULL,
  rationale text NOT NULL,
  repair_of_transform_id uuid,
  approved_by_membership_id uuid,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT transform_versions_source_fk
    FOREIGN KEY (organization_id, business_unit_id, migration_source_id)
    REFERENCES migration_sources (organization_id, business_unit_id, id),
  CONSTRAINT transform_versions_approver_fk
    FOREIGN KEY (organization_id, approved_by_membership_id)
    REFERENCES memberships (organization_id, id),
  CONSTRAINT transform_versions_schema_format CHECK (
    char_length(source_schema_version) BETWEEN 1 AND 128
    AND source_schema_version ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
  ),
  CONSTRAINT transform_versions_version_positive CHECK (version_no > 0),
  CONSTRAINT transform_versions_mapping_ref_nonempty CHECK (
    char_length(btrim(mapping_artifact_ref)) BETWEEN 1 AND 2048
  ),
  CONSTRAINT transform_versions_mapping_sha256_valid CHECK (octet_length(mapping_sha256) = 32),
  CONSTRAINT transform_versions_release_ref_nonempty CHECK (
    char_length(btrim(release_manifest_ref)) BETWEEN 1 AND 2048
  ),
  CONSTRAINT transform_versions_manifest_sha256_valid CHECK (
    octet_length(release_manifest_sha256) = 32
  ),
  CONSTRAINT transform_versions_release_sha256_valid CHECK (
    octet_length(transform_release_sha256) = 32
  ),
  CONSTRAINT transform_versions_rationale_nonempty CHECK (
    char_length(btrim(rationale)) BETWEEN 1 AND 4000
  ),
  CONSTRAINT transform_versions_approval_consistent CHECK (
    (approved_by_membership_id IS NULL AND approved_at IS NULL)
    OR
    (approved_by_membership_id IS NOT NULL AND approved_at IS NOT NULL)
  ),
  CONSTRAINT transform_versions_not_self_repair CHECK (repair_of_transform_id IS DISTINCT FROM id),
  CONSTRAINT transform_versions_version_unique
    UNIQUE (organization_id, business_unit_id, migration_source_id, version_no),
  CONSTRAINT transform_versions_tenant_source_key
    UNIQUE (organization_id, business_unit_id, migration_source_id, id),
  CONSTRAINT transform_versions_tenant_bu_key
    UNIQUE (organization_id, business_unit_id, id),
  CONSTRAINT transform_versions_repair_fk
    FOREIGN KEY (organization_id, business_unit_id, migration_source_id, repair_of_transform_id)
    REFERENCES transform_versions (organization_id, business_unit_id, migration_source_id, id)
);

CREATE TABLE import_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_unit_id uuid NOT NULL,
  migration_source_id uuid NOT NULL,
  transform_version_id uuid NOT NULL,
  validated_dry_run_batch_id uuid,
  repair_of_batch_id uuid,
  protected_artifact_ref text NOT NULL,
  source_sha256 bytea NOT NULL,
  size_bytes bigint NOT NULL,
  captured_at timestamptz NOT NULL,
  cutoff_at timestamptz NOT NULL,
  schema_version text NOT NULL,
  status text NOT NULL DEFAULT 'REGISTERED',
  dry_run boolean NOT NULL,
  total_row_count bigint NOT NULL DEFAULT 0,
  staged_row_count bigint NOT NULL DEFAULT 0,
  valid_row_count bigint NOT NULL DEFAULT 0,
  rejected_row_count bigint NOT NULL DEFAULT 0,
  quarantined_row_count bigint NOT NULL DEFAULT 0,
  hidden_row_count bigint NOT NULL DEFAULT 0,
  approved_row_count bigint NOT NULL DEFAULT 0,
  imported_row_count bigint NOT NULL DEFAULT 0,
  no_op_row_count bigint NOT NULL DEFAULT 0,
  validated_by_membership_id uuid,
  validated_at timestamptz,
  approved_by_membership_id uuid,
  approved_at timestamptz,
  approval_mode text,
  approval_reason text,
  applied_by_membership_id uuid,
  apply_run_id uuid,
  apply_lease_expires_at timestamptz,
  apply_started_at timestamptz,
  applied_at timestamptz,
  operator_reason text,
  failure_code text,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT import_batches_source_fk
    FOREIGN KEY (organization_id, business_unit_id, migration_source_id)
    REFERENCES migration_sources (organization_id, business_unit_id, id),
  CONSTRAINT import_batches_transform_fk
    FOREIGN KEY (
      organization_id, business_unit_id, migration_source_id, transform_version_id
    ) REFERENCES transform_versions (
      organization_id, business_unit_id, migration_source_id, id
    ),
  CONSTRAINT import_batches_validator_fk
    FOREIGN KEY (organization_id, validated_by_membership_id)
    REFERENCES memberships (organization_id, id),
  CONSTRAINT import_batches_approver_fk
    FOREIGN KEY (organization_id, approved_by_membership_id)
    REFERENCES memberships (organization_id, id),
  CONSTRAINT import_batches_applier_fk
    FOREIGN KEY (organization_id, applied_by_membership_id)
    REFERENCES memberships (organization_id, id),
  CONSTRAINT import_batches_status_valid CHECK (
    status IN (
      'REGISTERED', 'STAGED', 'VALIDATED', 'DRY_RUN_COMPLETE', 'APPROVED',
      'APPLYING', 'APPLIED', 'RECONCILED', 'REJECTED', 'FAILED'
    )
  ),
  CONSTRAINT import_batches_artifact_ref_nonempty CHECK (
    char_length(btrim(protected_artifact_ref)) BETWEEN 1 AND 2048
  ),
  CONSTRAINT import_batches_source_sha256_valid CHECK (octet_length(source_sha256) = 32),
  CONSTRAINT import_batches_size_nonnegative CHECK (size_bytes >= 0),
  CONSTRAINT import_batches_time_order CHECK (cutoff_at <= captured_at),
  CONSTRAINT import_batches_schema_format CHECK (
    char_length(schema_version) BETWEEN 1 AND 128
    AND schema_version ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
  ),
  CONSTRAINT import_batches_counters_nonnegative CHECK (
    total_row_count >= 0
    AND staged_row_count >= 0
    AND valid_row_count >= 0
    AND rejected_row_count >= 0
    AND quarantined_row_count >= 0
    AND hidden_row_count >= 0
    AND approved_row_count >= 0
    AND imported_row_count >= 0
    AND no_op_row_count >= 0
  ),
  CONSTRAINT import_batches_counters_consistent CHECK (
    total_row_count = staged_row_count + valid_row_count + rejected_row_count
      + quarantined_row_count + hidden_row_count + imported_row_count + no_op_row_count
  ),
  CONSTRAINT import_batches_validation_consistent CHECK (
    (validated_by_membership_id IS NULL) = (validated_at IS NULL)
    AND (
      status NOT IN ('VALIDATED', 'DRY_RUN_COMPLETE', 'APPROVED', 'APPLYING', 'APPLIED', 'RECONCILED')
      OR validated_by_membership_id IS NOT NULL
    )
  ),
  CONSTRAINT import_batches_approval_mode_valid CHECK (
    approval_mode IS NULL OR approval_mode IN ('FULL', 'PARTIAL')
  ),
  CONSTRAINT import_batches_approval_consistent CHECK (
    (
      approval_mode IS NULL
      AND approved_by_membership_id IS NULL
      AND approved_at IS NULL
      AND approval_reason IS NULL
      AND approved_row_count = 0
    )
    OR
    (
      approval_mode IS NOT NULL
      AND approved_by_membership_id IS NOT NULL
      AND approved_at IS NOT NULL
      AND approval_reason IS NOT NULL
      AND char_length(btrim(approval_reason)) BETWEEN 1 AND 2000
      AND approved_row_count > 0
      AND validated_by_membership_id IS NOT NULL
      AND validated_at IS NOT NULL
      AND validated_at <= approved_at
      AND status IN ('APPROVED', 'APPLYING', 'APPLIED', 'RECONCILED', 'FAILED')
      AND (
        (
          approval_mode = 'FULL'
          AND rejected_row_count = 0
          AND quarantined_row_count = 0
          AND hidden_row_count = 0
          AND approved_row_count = valid_row_count + imported_row_count + no_op_row_count
        )
        OR
        (
          approval_mode = 'PARTIAL'
          AND rejected_row_count > 0
          AND quarantined_row_count = 0
          AND hidden_row_count = 0
          AND approved_row_count = valid_row_count + imported_row_count + no_op_row_count
        )
      )
    )
  ),
  CONSTRAINT import_batches_claim_tuple_consistent CHECK (
    (
      applied_by_membership_id IS NULL
      AND apply_run_id IS NULL
      AND apply_lease_expires_at IS NULL
      AND apply_started_at IS NULL
    )
    OR
    (
      applied_by_membership_id IS NOT NULL
      AND apply_run_id IS NOT NULL
      AND apply_lease_expires_at IS NOT NULL
      AND apply_started_at IS NOT NULL
    )
  ),
  CONSTRAINT import_batches_lifecycle_consistent CHECK (
    (
      status NOT IN ('VALIDATED', 'DRY_RUN_COMPLETE', 'APPROVED', 'APPLYING', 'APPLIED', 'RECONCILED')
      OR staged_row_count = 0
    )
    AND (
      dry_run
      AND validated_dry_run_batch_id IS NULL
      AND status IN ('REGISTERED', 'STAGED', 'VALIDATED', 'DRY_RUN_COMPLETE', 'REJECTED', 'FAILED')
      AND (
        status <> 'DRY_RUN_COMPLETE'
        OR (
          staged_row_count = 0
          AND quarantined_row_count = 0
          AND hidden_row_count = 0
        )
      )
      AND approval_mode IS NULL
      AND applied_by_membership_id IS NULL
      AND applied_at IS NULL
      OR
      NOT dry_run
      AND validated_dry_run_batch_id IS NOT NULL
      AND status <> 'DRY_RUN_COMPLETE'
    )
    AND (
      status NOT IN ('APPROVED', 'APPLYING', 'APPLIED', 'RECONCILED')
      OR approval_mode IS NOT NULL
    )
    AND (
      status NOT IN ('APPROVED', 'APPLYING', 'APPLIED', 'RECONCILED')
      OR approved_row_count = valid_row_count + imported_row_count + no_op_row_count
    )
    AND (
      status NOT IN ('APPLIED', 'RECONCILED')
      OR (
        valid_row_count = 0
        AND imported_row_count + no_op_row_count = approved_row_count
      )
    )
    AND (
      (status = 'APPLYING' AND applied_by_membership_id IS NOT NULL AND applied_at IS NULL)
      OR
      (status IN ('APPLIED', 'RECONCILED') AND applied_by_membership_id IS NOT NULL AND applied_at IS NOT NULL)
      OR
      (status = 'FAILED' AND applied_at IS NULL)
      OR
      (status NOT IN ('APPLYING', 'APPLIED', 'RECONCILED', 'FAILED')
        AND applied_by_membership_id IS NULL AND applied_at IS NULL)
    )
  ),
  CONSTRAINT import_batches_repair_reason CHECK (
    repair_of_batch_id IS NULL
    OR (
      operator_reason IS NOT NULL
      AND char_length(btrim(operator_reason)) BETWEEN 1 AND 2000
    )
  ),
  CONSTRAINT import_batches_failure_consistent CHECK (
    (status = 'FAILED' AND failure_code IS NOT NULL AND char_length(btrim(failure_code)) BETWEEN 1 AND 127)
    OR (status <> 'FAILED' AND failure_code IS NULL)
  ),
  CONSTRAINT import_batches_version_positive CHECK (version >= 1),
  CONSTRAINT import_batches_source_snapshot_unique UNIQUE (
    organization_id, business_unit_id, migration_source_id,
    source_sha256, transform_version_id, dry_run
  ),
  CONSTRAINT import_batches_tenant_bu_key
    UNIQUE (organization_id, business_unit_id, id),
  CONSTRAINT import_batches_lineage_target_key UNIQUE (
    organization_id, business_unit_id, migration_source_id,
    source_sha256, transform_version_id, id
  ),
  CONSTRAINT import_batches_dry_run_fk FOREIGN KEY (
    organization_id, business_unit_id, migration_source_id,
    source_sha256, transform_version_id, validated_dry_run_batch_id
  ) REFERENCES import_batches (
    organization_id, business_unit_id, migration_source_id,
    source_sha256, transform_version_id, id
  ),
  CONSTRAINT import_batches_repair_fk
    FOREIGN KEY (organization_id, business_unit_id, repair_of_batch_id)
    REFERENCES import_batches (organization_id, business_unit_id, id)
);

CREATE TABLE source_authority_transitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_unit_id uuid NOT NULL,
  transition_group_id uuid NOT NULL,
  domain_authority_id uuid NOT NULL,
  from_source_scope_id uuid,
  to_source_scope_id uuid,
  from_state text NOT NULL,
  to_state text NOT NULL,
  write_frozen_at timestamptz,
  final_batch_id uuid,
  final_cutoff_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT authority_transitions_group_fk
    FOREIGN KEY (organization_id, transition_group_id)
    REFERENCES source_authority_transition_groups (organization_id, id),
  CONSTRAINT authority_transitions_authority_fk
    FOREIGN KEY (organization_id, business_unit_id, domain_authority_id)
    REFERENCES migration_domain_authorities (organization_id, business_unit_id, id),
  CONSTRAINT authority_transitions_from_scope_fk
    FOREIGN KEY (organization_id, business_unit_id, from_source_scope_id)
    REFERENCES migration_source_scopes (organization_id, business_unit_id, id),
  CONSTRAINT authority_transitions_to_scope_fk
    FOREIGN KEY (organization_id, business_unit_id, to_source_scope_id)
    REFERENCES migration_source_scopes (organization_id, business_unit_id, id),
  CONSTRAINT authority_transitions_final_batch_fk
    FOREIGN KEY (organization_id, business_unit_id, final_batch_id)
    REFERENCES import_batches (organization_id, business_unit_id, id),
  CONSTRAINT authority_transitions_from_state_valid CHECK (
    from_state IN ('LEGACY_WRITABLE', 'EXTERNAL_SYSTEM_AUTHORITY', 'SHADOW_READ', 'CANONICAL_WRITABLE')
  ),
  CONSTRAINT authority_transitions_to_state_valid CHECK (
    to_state IN ('LEGACY_WRITABLE', 'EXTERNAL_SYSTEM_AUTHORITY', 'SHADOW_READ', 'CANONICAL_WRITABLE')
  ),
  CONSTRAINT authority_transitions_from_scope_state CHECK (
    (from_state = 'CANONICAL_WRITABLE' AND from_source_scope_id IS NULL)
    OR (from_state <> 'CANONICAL_WRITABLE' AND from_source_scope_id IS NOT NULL)
  ),
  CONSTRAINT authority_transitions_to_scope_state CHECK (
    (to_state = 'CANONICAL_WRITABLE' AND to_source_scope_id IS NULL)
    OR (to_state <> 'CANONICAL_WRITABLE' AND to_source_scope_id IS NOT NULL)
  ),
  CONSTRAINT authority_transitions_canonical_evidence CHECK (
    to_state <> 'CANONICAL_WRITABLE'
    OR (
      write_frozen_at IS NOT NULL
      AND final_batch_id IS NOT NULL
      AND final_cutoff_at IS NOT NULL
    )
  ),
  CONSTRAINT source_authority_transitions_member_unique
    UNIQUE (organization_id, transition_group_id, domain_authority_id),
  CONSTRAINT authority_transitions_tenant_bu_key
    UNIQUE (organization_id, business_unit_id, id)
);

CREATE TABLE import_rows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_unit_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  source_row_key text NOT NULL,
  row_number bigint,
  source_object_type text NOT NULL,
  source_record_id text,
  source_locator text NOT NULL,
  row_sha256 bytea NOT NULL,
  raw_evidence_ref text NOT NULL,
  normalized_evidence_ref text,
  normalized_sha256 bytea,
  outcome text NOT NULL DEFAULT 'STAGED',
  error_code text,
  error_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  resolved_link_id uuid,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT import_rows_batch_fk
    FOREIGN KEY (organization_id, business_unit_id, batch_id)
    REFERENCES import_batches (organization_id, business_unit_id, id),
  CONSTRAINT import_rows_source_key_format CHECK (
    char_length(source_row_key) BETWEEN 1 AND 512
    AND source_row_key ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]*$'
  ),
  CONSTRAINT import_rows_row_number_positive CHECK (row_number IS NULL OR row_number > 0),
  CONSTRAINT import_rows_object_type_format CHECK (
    char_length(source_object_type) BETWEEN 1 AND 127
    AND source_object_type ~ '^[a-z][a-z0-9_.:-]*$'
  ),
  CONSTRAINT import_rows_source_record_nonempty CHECK (
    source_record_id IS NULL OR char_length(btrim(source_record_id)) BETWEEN 1 AND 512
  ),
  CONSTRAINT import_rows_locator_nonempty CHECK (
    char_length(btrim(source_locator)) BETWEEN 1 AND 2048
  ),
  CONSTRAINT import_rows_row_sha256_valid CHECK (octet_length(row_sha256) = 32),
  CONSTRAINT import_rows_raw_ref_nonempty CHECK (
    char_length(btrim(raw_evidence_ref)) BETWEEN 1 AND 2048
  ),
  CONSTRAINT import_rows_normalized_evidence_consistent CHECK (
    (normalized_evidence_ref IS NULL AND normalized_sha256 IS NULL)
    OR (
      normalized_evidence_ref IS NOT NULL
      AND normalized_sha256 IS NOT NULL
      AND char_length(btrim(normalized_evidence_ref)) BETWEEN 1 AND 2048
      AND octet_length(normalized_sha256) = 32
    )
  ),
  CONSTRAINT import_rows_outcome_valid CHECK (
    outcome IN ('STAGED', 'VALID', 'IMPORTED', 'NO_OP_REPLAY', 'REJECTED', 'QUARANTINED', 'HIDDEN')
  ),
  CONSTRAINT import_rows_error_consistent CHECK (
    (outcome IN ('REJECTED', 'QUARANTINED', 'HIDDEN')
      AND error_code IS NOT NULL
      AND char_length(btrim(error_code)) BETWEEN 1 AND 127)
    OR
    (outcome NOT IN ('REJECTED', 'QUARANTINED', 'HIDDEN') AND error_code IS NULL)
  ),
  CONSTRAINT import_rows_error_metadata_object CHECK (jsonb_typeof(error_metadata) = 'object'),
  CONSTRAINT import_rows_resolution_link_consistent CHECK (
    (outcome IN ('IMPORTED', 'NO_OP_REPLAY')) = (resolved_link_id IS NOT NULL)
  ),
  CONSTRAINT import_rows_version_positive CHECK (version >= 1),
  CONSTRAINT import_rows_source_key_unique UNIQUE (organization_id, batch_id, source_row_key),
  CONSTRAINT import_rows_tenant_bu_key UNIQUE (organization_id, business_unit_id, id)
);

CREATE TABLE legacy_object_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_unit_id uuid NOT NULL,
  migration_source_id uuid NOT NULL,
  import_row_id uuid NOT NULL,
  source_object_type text NOT NULL,
  source_row_key text NOT NULL,
  link_version integer NOT NULL,
  supersedes_link_id uuid,
  destination_entity_type text NOT NULL,
  destination_entity_id uuid NOT NULL,
  correction_reason text,
  created_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT legacy_object_links_source_fk
    FOREIGN KEY (organization_id, business_unit_id, migration_source_id)
    REFERENCES migration_sources (organization_id, business_unit_id, id),
  CONSTRAINT legacy_object_links_import_row_fk
    FOREIGN KEY (organization_id, business_unit_id, import_row_id)
    REFERENCES import_rows (organization_id, business_unit_id, id),
  CONSTRAINT legacy_object_links_actor_fk
    FOREIGN KEY (organization_id, created_by_membership_id)
    REFERENCES memberships (organization_id, id),
  CONSTRAINT legacy_object_links_object_type_format CHECK (
    char_length(source_object_type) BETWEEN 1 AND 127
    AND source_object_type ~ '^[a-z][a-z0-9_.:-]*$'
  ),
  CONSTRAINT legacy_object_links_source_key_format CHECK (
    char_length(source_row_key) BETWEEN 1 AND 512
    AND source_row_key ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]*$'
  ),
  CONSTRAINT legacy_object_links_destination_type_format CHECK (
    char_length(destination_entity_type) BETWEEN 1 AND 127
    AND destination_entity_type ~ '^[a-z][a-z0-9_.:-]*$'
  ),
  CONSTRAINT legacy_object_links_version_positive CHECK (link_version > 0),
  CONSTRAINT legacy_object_links_lineage_shape CHECK (
    (
      link_version = 1
      AND supersedes_link_id IS NULL
      AND correction_reason IS NULL
    )
    OR
    (
      link_version > 1
      AND supersedes_link_id IS NOT NULL
      AND correction_reason IS NOT NULL
      AND char_length(btrim(correction_reason)) BETWEEN 1 AND 2000
    )
  ),
  CONSTRAINT legacy_object_links_not_self CHECK (supersedes_link_id IS DISTINCT FROM id),
  CONSTRAINT legacy_object_links_version_unique UNIQUE (
    organization_id, business_unit_id, migration_source_id,
    source_object_type, source_row_key, link_version
  ),
  CONSTRAINT legacy_object_links_tenant_source_key UNIQUE (
    organization_id, business_unit_id, migration_source_id, id
  ),
  CONSTRAINT legacy_object_links_tenant_bu_key UNIQUE (organization_id, business_unit_id, id),
  CONSTRAINT legacy_object_links_row_link_key UNIQUE (
    organization_id, business_unit_id, import_row_id, id
  ),
  CONSTRAINT legacy_object_links_supersedes_unique UNIQUE (supersedes_link_id),
  CONSTRAINT legacy_object_links_supersedes_fk
    FOREIGN KEY (organization_id, business_unit_id, migration_source_id, supersedes_link_id)
    REFERENCES legacy_object_links (organization_id, business_unit_id, migration_source_id, id)
);

ALTER TABLE import_rows
  ADD CONSTRAINT import_rows_resolved_link_fk
  FOREIGN KEY (organization_id, business_unit_id, resolved_link_id)
  REFERENCES legacy_object_links (organization_id, business_unit_id, id);

CREATE TABLE quarantine_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_unit_id uuid NOT NULL,
  import_row_id uuid NOT NULL,
  reason_code text NOT NULL,
  reason_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'OPEN',
  resolution text,
  resolved_by_membership_id uuid,
  resolved_at timestamptz,
  resolution_reason text,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT quarantine_items_import_row_fk
    FOREIGN KEY (organization_id, business_unit_id, import_row_id)
    REFERENCES import_rows (organization_id, business_unit_id, id),
  CONSTRAINT quarantine_items_resolver_fk
    FOREIGN KEY (organization_id, resolved_by_membership_id)
    REFERENCES memberships (organization_id, id),
  CONSTRAINT quarantine_items_reason_code_format CHECK (
    char_length(reason_code) BETWEEN 1 AND 127
    AND reason_code ~ '^[A-Z][A-Z0-9_]*$'
  ),
  CONSTRAINT quarantine_items_metadata_object CHECK (jsonb_typeof(reason_metadata) = 'object'),
  CONSTRAINT quarantine_items_status_valid CHECK (status IN ('OPEN', 'RESOLVED')),
  CONSTRAINT quarantine_items_resolution_valid CHECK (
    resolution IS NULL OR resolution IN ('APPROVE_ROW', 'REJECT_ROW')
  ),
  CONSTRAINT quarantine_items_resolution_consistent CHECK (
    (
      status = 'OPEN'
      AND resolution IS NULL
      AND resolved_by_membership_id IS NULL
      AND resolved_at IS NULL
      AND resolution_reason IS NULL
    )
    OR
    (
      status = 'RESOLVED'
      AND resolution IS NOT NULL
      AND resolved_by_membership_id IS NOT NULL
      AND resolved_at IS NOT NULL
      AND resolution_reason IS NOT NULL
      AND char_length(btrim(resolution_reason)) BETWEEN 1 AND 2000
    )
  ),
  CONSTRAINT quarantine_items_version_positive CHECK (version >= 1),
  CONSTRAINT quarantine_items_tenant_bu_key UNIQUE (organization_id, business_unit_id, id)
);

CREATE TABLE reconciliation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_unit_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  run_no integer NOT NULL,
  status text NOT NULL DEFAULT 'PENDING',
  plan_artifact_ref text NOT NULL,
  plan_sha256 bytea NOT NULL,
  required_checks jsonb NOT NULL,
  required_checks_sha256 bytea NOT NULL,
  required_check_count integer NOT NULL,
  passed_check_count integer NOT NULL DEFAULT 0,
  failed_check_count integer NOT NULL DEFAULT 0,
  signed_by_membership_id uuid,
  signed_at timestamptz,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT reconciliation_runs_batch_fk
    FOREIGN KEY (organization_id, business_unit_id, batch_id)
    REFERENCES import_batches (organization_id, business_unit_id, id),
  CONSTRAINT reconciliation_runs_signer_fk
    FOREIGN KEY (organization_id, signed_by_membership_id)
    REFERENCES memberships (organization_id, id),
  CONSTRAINT reconciliation_runs_number_positive CHECK (run_no > 0),
  CONSTRAINT reconciliation_runs_status_valid CHECK (
    status IN ('PENDING', 'PASSED', 'FAILED', 'SIGNED')
  ),
  CONSTRAINT reconciliation_runs_plan_ref_nonempty CHECK (
    char_length(btrim(plan_artifact_ref)) BETWEEN 1 AND 2048
  ),
  CONSTRAINT reconciliation_runs_plan_sha256_valid CHECK (octet_length(plan_sha256) = 32),
  CONSTRAINT reconciliation_runs_required_array CHECK (jsonb_typeof(required_checks) = 'array'),
  CONSTRAINT reconciliation_runs_required_sha256_valid CHECK (
    octet_length(required_checks_sha256) = 32
  ),
  CONSTRAINT reconciliation_runs_counts_valid CHECK (
    required_check_count > 0
    AND passed_check_count >= 0
    AND failed_check_count >= 0
    AND passed_check_count + failed_check_count <= required_check_count
  ),
  CONSTRAINT reconciliation_runs_signature_consistent CHECK (
    (
      status = 'SIGNED'
      AND signed_by_membership_id IS NOT NULL
      AND signed_at IS NOT NULL
      AND passed_check_count = required_check_count
      AND failed_check_count = 0
    )
    OR
    (
      status <> 'SIGNED'
      AND signed_by_membership_id IS NULL
      AND signed_at IS NULL
    )
  ),
  CONSTRAINT reconciliation_runs_version_positive CHECK (version >= 1),
  CONSTRAINT reconciliation_runs_run_unique UNIQUE (organization_id, batch_id, run_no),
  CONSTRAINT reconciliation_runs_tenant_bu_key UNIQUE (organization_id, business_unit_id, id)
);

CREATE TABLE reconciliation_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_unit_id uuid NOT NULL,
  run_id uuid NOT NULL,
  check_kind text NOT NULL,
  check_key text NOT NULL,
  scope_key text NOT NULL,
  source_count bigint,
  target_count bigint,
  source_amount numeric(38,12),
  target_amount numeric(38,12),
  measure_unit text,
  decimal_scale smallint,
  source_checksum bytea,
  target_checksum bytea,
  passed boolean NOT NULL,
  evidence_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT reconciliation_results_run_fk
    FOREIGN KEY (organization_id, business_unit_id, run_id)
    REFERENCES reconciliation_runs (organization_id, business_unit_id, id),
  CONSTRAINT reconciliation_results_kind_valid CHECK (
    check_kind IN (
      'COUNT', 'AMOUNT', 'CHECKSUM', 'UNIQUENESS', 'REFERENCE', 'TIMELINE',
      'LOT_ALLOCATION', 'FINANCE_BALANCE', 'FILE', 'SAMPLE'
    )
  ),
  CONSTRAINT reconciliation_results_check_key_format CHECK (
    char_length(check_key) BETWEEN 1 AND 127
    AND check_key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'
  ),
  CONSTRAINT reconciliation_results_scope_key_format CHECK (
    char_length(scope_key) BETWEEN 1 AND 255
    AND scope_key ~ '^[a-z][a-z0-9_.:-]*$'
  ),
  CONSTRAINT reconciliation_results_count_pairs CHECK (
    (source_count IS NULL) = (target_count IS NULL)
    AND (source_count IS NULL OR (source_count >= 0 AND target_count >= 0))
  ),
  CONSTRAINT reconciliation_results_amount_pairs CHECK (
    (source_amount IS NULL) = (target_amount IS NULL)
  ),
  CONSTRAINT reconciliation_results_checksum_pairs CHECK (
    (source_checksum IS NULL) = (target_checksum IS NULL)
    AND (source_checksum IS NULL OR (
      octet_length(source_checksum) = 32 AND octet_length(target_checksum) = 32
    ))
  ),
  CONSTRAINT reconciliation_results_scale_valid CHECK (
    decimal_scale IS NULL OR decimal_scale BETWEEN 0 AND 12
  ),
  CONSTRAINT reconciliation_results_metadata_object CHECK (jsonb_typeof(evidence_metadata) = 'object'),
  CONSTRAINT reconciliation_results_kind_values_consistent CHECK (
    (
      check_kind = 'COUNT'
      AND source_count IS NOT NULL
      AND source_amount IS NULL
      AND source_checksum IS NULL
      AND measure_unit IS NULL
      AND decimal_scale IS NULL
    )
    OR
    (
      check_kind IN ('AMOUNT', 'FINANCE_BALANCE')
      AND source_count IS NULL
      AND source_amount IS NOT NULL
      AND source_checksum IS NULL
      AND measure_unit IS NOT NULL
      AND char_length(btrim(measure_unit)) BETWEEN 1 AND 32
      AND decimal_scale IS NOT NULL
    )
    OR
    (
      check_kind = 'CHECKSUM'
      AND source_count IS NULL
      AND source_amount IS NULL
      AND source_checksum IS NOT NULL
      AND measure_unit IS NULL
      AND decimal_scale IS NULL
    )
    OR
    (
      check_kind IN ('UNIQUENESS', 'REFERENCE', 'TIMELINE', 'LOT_ALLOCATION', 'FILE', 'SAMPLE')
      AND source_count IS NULL
      AND source_amount IS NULL
      AND source_checksum IS NULL
      AND measure_unit IS NULL
      AND decimal_scale IS NULL
      AND evidence_metadata <> '{}'::jsonb
    )
  ),
  CONSTRAINT reconciliation_results_identity_unique UNIQUE NULLS NOT DISTINCT (
    organization_id, run_id, check_kind, check_key, scope_key, measure_unit, decimal_scale
  ),
  CONSTRAINT reconciliation_results_tenant_bu_key UNIQUE (organization_id, business_unit_id, id)
);

CREATE UNIQUE INDEX import_rows_row_number_unique
  ON import_rows (organization_id, batch_id, row_number)
  WHERE row_number IS NOT NULL;

CREATE UNIQUE INDEX quarantine_items_open_unique
  ON quarantine_items (organization_id, import_row_id, reason_code)
  WHERE status = 'OPEN';

CREATE INDEX import_batches_pending_idx
  ON import_batches (organization_id, business_unit_id, status, created_at)
  WHERE status IN ('REGISTERED', 'STAGED', 'VALIDATED', 'APPROVED', 'APPLYING', 'APPLIED');

CREATE INDEX import_rows_pending_idx
  ON import_rows (organization_id, business_unit_id, batch_id, outcome, created_at)
  WHERE outcome IN ('STAGED', 'VALID', 'QUARANTINED');

CREATE INDEX quarantine_items_open_idx
  ON quarantine_items (organization_id, business_unit_id, created_at)
  WHERE status = 'OPEN';

CREATE INDEX reconciliation_runs_pending_idx
  ON reconciliation_runs (organization_id, business_unit_id, status, created_at)
  WHERE status IN ('PENDING', 'PASSED', 'FAILED');

-- Reverse relationship lookups used by deferred control-plane validators.
CREATE INDEX migration_domain_authorities_scope_lookup_idx
  ON migration_domain_authorities (authority_source_scope_id)
  WHERE authority_source_scope_id IS NOT NULL;

CREATE INDEX source_authority_transitions_authority_lookup_idx
  ON source_authority_transitions (domain_authority_id);

CREATE INDEX source_authority_transitions_from_scope_lookup_idx
  ON source_authority_transitions (from_source_scope_id)
  WHERE from_source_scope_id IS NOT NULL;

CREATE INDEX source_authority_transitions_to_scope_lookup_idx
  ON source_authority_transitions (to_source_scope_id)
  WHERE to_source_scope_id IS NOT NULL;

CREATE INDEX source_authority_transitions_final_batch_lookup_idx
  ON source_authority_transitions (final_batch_id)
  WHERE final_batch_id IS NOT NULL;

CREATE INDEX import_batches_dry_run_lookup_idx
  ON import_batches (validated_dry_run_batch_id)
  WHERE validated_dry_run_batch_id IS NOT NULL;

CREATE INDEX migration_sources_owner_lookup_idx
  ON migration_sources (owner_membership_id);

CREATE INDEX transition_groups_approver_lookup_idx
  ON source_authority_transition_groups (approved_by_membership_id);

CREATE INDEX transform_versions_approver_lookup_idx
  ON transform_versions (approved_by_membership_id)
  WHERE approved_by_membership_id IS NOT NULL;

CREATE INDEX import_batches_validator_lookup_idx
  ON import_batches (validated_by_membership_id)
  WHERE validated_by_membership_id IS NOT NULL;

CREATE INDEX import_batches_approver_lookup_idx
  ON import_batches (approved_by_membership_id)
  WHERE approved_by_membership_id IS NOT NULL;

CREATE INDEX import_batches_applier_lookup_idx
  ON import_batches (applied_by_membership_id)
  WHERE applied_by_membership_id IS NOT NULL;

CREATE INDEX legacy_object_links_creator_lookup_idx
  ON legacy_object_links (created_by_membership_id);

CREATE INDEX quarantine_items_resolver_lookup_idx
  ON quarantine_items (resolved_by_membership_id)
  WHERE resolved_by_membership_id IS NOT NULL;

CREATE INDEX reconciliation_runs_signer_lookup_idx
  ON reconciliation_runs (signed_by_membership_id)
  WHERE signed_by_membership_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Cross-row control-plane invariants
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION crm_set_transition_group_effective_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.effective_at := transaction_timestamp();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION crm_validate_migration_authority_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  old_data jsonb;
  new_data jsonb;
  affected_authority_ids uuid[] := ARRAY[]::uuid[];
  affected_scope_ids uuid[] := ARRAY[]::uuid[];
  invalid_authority_id uuid;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    old_data := to_jsonb(OLD);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    new_data := to_jsonb(NEW);
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF
      TG_TABLE_NAME = 'migration_domain_authorities'
      AND (old_data -> 'id') IS NOT DISTINCT FROM (new_data -> 'id')
      AND (old_data -> 'organization_id') IS NOT DISTINCT FROM (new_data -> 'organization_id')
      AND (old_data -> 'business_unit_id') IS NOT DISTINCT FROM (new_data -> 'business_unit_id')
      AND (old_data -> 'domain_key') IS NOT DISTINCT FROM (new_data -> 'domain_key')
      AND (old_data -> 'canonical_target') IS NOT DISTINCT FROM (new_data -> 'canonical_target')
      AND (old_data -> 'authority_state') IS NOT DISTINCT FROM (new_data -> 'authority_state')
      AND (old_data -> 'authority_source_scope_id')
        IS NOT DISTINCT FROM (new_data -> 'authority_source_scope_id')
    THEN
      RETURN NULL;
    ELSIF
      TG_TABLE_NAME = 'migration_source_scopes'
      AND (old_data -> 'id') IS NOT DISTINCT FROM (new_data -> 'id')
      AND (old_data -> 'organization_id') IS NOT DISTINCT FROM (new_data -> 'organization_id')
      AND (old_data -> 'business_unit_id') IS NOT DISTINCT FROM (new_data -> 'business_unit_id')
      AND (old_data -> 'domain_key') IS NOT DISTINCT FROM (new_data -> 'domain_key')
      AND (old_data -> 'canonical_target') IS NOT DISTINCT FROM (new_data -> 'canonical_target')
      AND (old_data -> 'source_status') IS NOT DISTINCT FROM (new_data -> 'source_status')
    THEN
      RETURN NULL;
    END IF;
  END IF;

  IF TG_TABLE_NAME = 'migration_domain_authorities' THEN
    IF old_data IS NOT NULL THEN
      affected_authority_ids := array_append(affected_authority_ids, (old_data ->> 'id')::uuid);
      IF old_data ->> 'authority_source_scope_id' IS NOT NULL THEN
        affected_scope_ids := array_append(
          affected_scope_ids,
          (old_data ->> 'authority_source_scope_id')::uuid
        );
      END IF;
    END IF;
    IF new_data IS NOT NULL THEN
      affected_authority_ids := array_append(affected_authority_ids, (new_data ->> 'id')::uuid);
      IF new_data ->> 'authority_source_scope_id' IS NOT NULL THEN
        affected_scope_ids := array_append(
          affected_scope_ids,
          (new_data ->> 'authority_source_scope_id')::uuid
        );
      END IF;
    END IF;
  ELSE
    IF old_data IS NOT NULL THEN
      affected_scope_ids := array_append(affected_scope_ids, (old_data ->> 'id')::uuid);
    END IF;
    IF new_data IS NOT NULL THEN
      affected_scope_ids := array_append(affected_scope_ids, (new_data ->> 'id')::uuid);
    END IF;
  END IF;

  IF TG_TABLE_NAME = 'migration_domain_authorities' THEN
    PERFORM scope.id
      FROM migration_source_scopes scope
     WHERE scope.id = ANY(affected_scope_ids)
        OR EXISTS (
          SELECT 1
            FROM migration_domain_authorities authority
           WHERE authority.id = ANY(affected_authority_ids)
             AND authority.authority_source_scope_id = scope.id
        )
     ORDER BY scope.organization_id, scope.business_unit_id, scope.id
     FOR SHARE;
  END IF;

  SELECT authority.id
    INTO invalid_authority_id
    FROM migration_domain_authorities authority
    LEFT JOIN migration_source_scopes scope
      ON scope.organization_id = authority.organization_id
     AND scope.business_unit_id = authority.business_unit_id
     AND scope.id = authority.authority_source_scope_id
   WHERE (
       (TG_TABLE_NAME = 'migration_domain_authorities'
         AND authority.id = ANY(affected_authority_ids))
       OR
       (TG_TABLE_NAME = 'migration_source_scopes'
         AND authority.authority_source_scope_id = ANY(affected_scope_ids))
     )
     AND authority.authority_state <> 'CANONICAL_WRITABLE'
     AND (
       scope.id IS NULL
       OR scope.domain_key <> authority.domain_key
       OR scope.canonical_target <> authority.canonical_target
       OR scope.source_status <> 'ACTIVE_AUTHORITY'
     )
   LIMIT 1;

  IF invalid_authority_id IS NOT NULL THEN
    RAISE EXCEPTION 'authority scope coherence violation for authority %', invalid_authority_id
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION crm_guard_terminal_migration_authority()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'migration authority heads are durable and cannot be deleted'
      USING ERRCODE = '55000';
  END IF;

  IF
    NEW.id IS DISTINCT FROM OLD.id
    OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.business_unit_id IS DISTINCT FROM OLD.business_unit_id
    OR NEW.domain_key IS DISTINCT FROM OLD.domain_key
    OR NEW.canonical_target IS DISTINCT FROM OLD.canonical_target
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'migration authority durable identity is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.authority_state = 'CANONICAL_WRITABLE' THEN
    IF
      NEW.authority_state IS DISTINCT FROM OLD.authority_state
      OR NEW.authority_source_scope_id IS DISTINCT FROM OLD.authority_source_scope_id
    THEN
      RAISE EXCEPTION 'CANONICAL_WRITABLE authority is terminal and cannot regress'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION crm_validate_transition_group_completeness()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  old_data jsonb;
  new_data jsonb;
  affected_group_ids uuid[] := ARRAY[]::uuid[];
  invalid_group_id uuid;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    old_data := to_jsonb(OLD);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    new_data := to_jsonb(NEW);
  END IF;

  IF TG_TABLE_NAME = 'source_authority_transition_groups' THEN
    IF old_data IS NOT NULL THEN
      affected_group_ids := array_append(affected_group_ids, (old_data ->> 'id')::uuid);
    END IF;
    IF new_data IS NOT NULL THEN
      affected_group_ids := array_append(affected_group_ids, (new_data ->> 'id')::uuid);
    END IF;
  ELSE
    IF old_data IS NOT NULL THEN
      affected_group_ids := array_append(
        affected_group_ids,
        (old_data ->> 'transition_group_id')::uuid
      );
    END IF;
    IF new_data IS NOT NULL THEN
      affected_group_ids := array_append(
        affected_group_ids,
        (new_data ->> 'transition_group_id')::uuid
      );
    END IF;
  END IF;

  SELECT transition_group.id
    INTO invalid_group_id
    FROM source_authority_transition_groups transition_group
    LEFT JOIN source_authority_transitions transition
      ON transition.organization_id = transition_group.organization_id
     AND transition.transition_group_id = transition_group.id
   WHERE transition_group.id = ANY(affected_group_ids)
   GROUP BY transition_group.organization_id, transition_group.id, transition_group.group_size
  HAVING count(DISTINCT transition.domain_authority_id) <> transition_group.group_size
   LIMIT 1;

  IF invalid_group_id IS NOT NULL THEN
    RAISE EXCEPTION 'transition group % is incomplete', invalid_group_id
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION crm_validate_authority_transition_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  old_data jsonb;
  new_data jsonb;
  affected_parent_ids uuid[] := ARRAY[]::uuid[];
  affected_transition_ids uuid[] := ARRAY[]::uuid[];
  invalid_transition_id uuid;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    old_data := to_jsonb(OLD);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    new_data := to_jsonb(NEW);
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF
      TG_TABLE_NAME = 'import_batches'
      AND (old_data -> 'id') IS NOT DISTINCT FROM (new_data -> 'id')
      AND (old_data -> 'organization_id') IS NOT DISTINCT FROM (new_data -> 'organization_id')
      AND (old_data -> 'business_unit_id') IS NOT DISTINCT FROM (new_data -> 'business_unit_id')
      AND (old_data -> 'migration_source_id')
        IS NOT DISTINCT FROM (new_data -> 'migration_source_id')
      AND (old_data -> 'dry_run') IS NOT DISTINCT FROM (new_data -> 'dry_run')
      AND (old_data -> 'status') IS NOT DISTINCT FROM (new_data -> 'status')
      AND (old_data -> 'cutoff_at') IS NOT DISTINCT FROM (new_data -> 'cutoff_at')
    THEN
      RETURN NULL;
    ELSIF
      TG_TABLE_NAME = 'migration_domain_authorities'
      AND (old_data -> 'id') IS NOT DISTINCT FROM (new_data -> 'id')
      AND (old_data -> 'organization_id') IS NOT DISTINCT FROM (new_data -> 'organization_id')
      AND (old_data -> 'business_unit_id') IS NOT DISTINCT FROM (new_data -> 'business_unit_id')
      AND (old_data -> 'domain_key') IS NOT DISTINCT FROM (new_data -> 'domain_key')
      AND (old_data -> 'canonical_target') IS NOT DISTINCT FROM (new_data -> 'canonical_target')
      AND (old_data -> 'authority_state') IS NOT DISTINCT FROM (new_data -> 'authority_state')
      AND (old_data -> 'authority_source_scope_id')
        IS NOT DISTINCT FROM (new_data -> 'authority_source_scope_id')
    THEN
      RETURN NULL;
    ELSIF
      TG_TABLE_NAME = 'migration_source_scopes'
      AND (old_data -> 'id') IS NOT DISTINCT FROM (new_data -> 'id')
      AND (old_data -> 'organization_id') IS NOT DISTINCT FROM (new_data -> 'organization_id')
      AND (old_data -> 'business_unit_id') IS NOT DISTINCT FROM (new_data -> 'business_unit_id')
      AND (old_data -> 'migration_source_id')
        IS NOT DISTINCT FROM (new_data -> 'migration_source_id')
      AND (old_data -> 'domain_key') IS NOT DISTINCT FROM (new_data -> 'domain_key')
      AND (old_data -> 'canonical_target') IS NOT DISTINCT FROM (new_data -> 'canonical_target')
    THEN
      RETURN NULL;
    END IF;
  END IF;

  IF TG_TABLE_NAME = 'source_authority_transitions' THEN
    IF old_data IS NOT NULL THEN
      affected_transition_ids := array_append(
        affected_transition_ids,
        (old_data ->> 'id')::uuid
      );
    END IF;
    IF new_data IS NOT NULL THEN
      affected_transition_ids := array_append(
        affected_transition_ids,
        (new_data ->> 'id')::uuid
      );
    END IF;
  ELSE
    IF old_data IS NOT NULL THEN
      affected_parent_ids := array_append(affected_parent_ids, (old_data ->> 'id')::uuid);
    END IF;
    IF new_data IS NOT NULL THEN
      affected_parent_ids := array_append(affected_parent_ids, (new_data ->> 'id')::uuid);
    END IF;

    IF TG_TABLE_NAME = 'import_batches' THEN
      SELECT coalesce(array_agg(transition.id), ARRAY[]::uuid[])
        INTO affected_transition_ids
        FROM source_authority_transitions transition
       WHERE transition.final_batch_id = ANY(affected_parent_ids);
    ELSIF TG_TABLE_NAME = 'migration_domain_authorities' THEN
      SELECT coalesce(array_agg(transition.id), ARRAY[]::uuid[])
        INTO affected_transition_ids
        FROM source_authority_transitions transition
       WHERE transition.domain_authority_id = ANY(affected_parent_ids);
    ELSE
      SELECT coalesce(array_agg(transition.id), ARRAY[]::uuid[])
        INTO affected_transition_ids
        FROM source_authority_transitions transition
       WHERE transition.from_source_scope_id = ANY(affected_parent_ids)
          OR transition.to_source_scope_id = ANY(affected_parent_ids);
    END IF;
  END IF;

  IF cardinality(affected_transition_ids) = 0 THEN
    RETURN NULL;
  END IF;

  IF TG_TABLE_NAME = 'source_authority_transitions' THEN
    PERFORM authority.id
      FROM migration_domain_authorities authority
      JOIN source_authority_transitions transition
        ON transition.organization_id = authority.organization_id
       AND transition.business_unit_id = authority.business_unit_id
       AND transition.domain_authority_id = authority.id
     WHERE transition.id = ANY(affected_transition_ids)
     ORDER BY authority.organization_id, authority.business_unit_id, authority.id
     FOR SHARE OF authority;

    PERFORM scope.id
      FROM migration_source_scopes scope
     WHERE scope.id IN (
       SELECT transition.from_source_scope_id
         FROM source_authority_transitions transition
        WHERE transition.id = ANY(affected_transition_ids)
       UNION
       SELECT transition.to_source_scope_id
         FROM source_authority_transitions transition
        WHERE transition.id = ANY(affected_transition_ids)
     )
     ORDER BY scope.organization_id, scope.business_unit_id, scope.id
     FOR SHARE;

    PERFORM final_batch.id
      FROM import_batches final_batch
      JOIN source_authority_transitions transition
        ON transition.organization_id = final_batch.organization_id
       AND transition.business_unit_id = final_batch.business_unit_id
       AND transition.final_batch_id = final_batch.id
     WHERE transition.id = ANY(affected_transition_ids)
     ORDER BY final_batch.organization_id, final_batch.business_unit_id, final_batch.id
     FOR SHARE OF final_batch;
  END IF;

  SELECT transition.id
    INTO invalid_transition_id
    FROM source_authority_transitions transition
    JOIN source_authority_transition_groups transition_group
      ON transition_group.organization_id = transition.organization_id
     AND transition_group.id = transition.transition_group_id
    JOIN migration_domain_authorities authority
      ON authority.organization_id = transition.organization_id
     AND authority.business_unit_id = transition.business_unit_id
     AND authority.id = transition.domain_authority_id
    LEFT JOIN migration_source_scopes from_scope
      ON from_scope.organization_id = transition.organization_id
     AND from_scope.business_unit_id = transition.business_unit_id
     AND from_scope.id = transition.from_source_scope_id
    LEFT JOIN migration_source_scopes to_scope
      ON to_scope.organization_id = transition.organization_id
     AND to_scope.business_unit_id = transition.business_unit_id
     AND to_scope.id = transition.to_source_scope_id
    LEFT JOIN import_batches final_batch
      ON final_batch.organization_id = transition.organization_id
     AND final_batch.business_unit_id = transition.business_unit_id
     AND final_batch.id = transition.final_batch_id
   WHERE transition.id = ANY(affected_transition_ids)
     AND (
       (
         transition.from_state <> 'CANONICAL_WRITABLE'
         AND (
           from_scope.id IS NULL
           OR from_scope.domain_key <> authority.domain_key
           OR from_scope.canonical_target <> authority.canonical_target
         )
       )
       OR (
         transition.to_state <> 'CANONICAL_WRITABLE'
         AND (
           to_scope.id IS NULL
           OR to_scope.domain_key <> authority.domain_key
           OR to_scope.canonical_target <> authority.canonical_target
         )
       )
       OR (
         transition.to_state = 'CANONICAL_WRITABLE'
         AND (
           authority.authority_state <> 'CANONICAL_WRITABLE'
           OR authority.authority_source_scope_id IS NOT NULL
           OR final_batch.id IS NULL
           OR final_batch.dry_run
           OR final_batch.status <> 'RECONCILED'
           OR final_batch.migration_source_id IS DISTINCT FROM from_scope.migration_source_id
           OR transition.final_cutoff_at IS DISTINCT FROM final_batch.cutoff_at
           OR transition.write_frozen_at > final_batch.cutoff_at
           OR final_batch.cutoff_at > transition_group.effective_at
         )
       )
     )
   LIMIT 1;

  IF invalid_transition_id IS NOT NULL THEN
    RAISE EXCEPTION 'authority transition evidence is invalid for transition %', invalid_transition_id
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION crm_validate_migration_actor_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  row_data jsonb := to_jsonb(NEW);
  old_data jsonb;
  actor_column text;
  required_scope text;
  actor_id uuid;
  actor_business_unit_id uuid;
  evidence_business_unit_id uuid;
  evidence_organization_id uuid;
  actor_ids uuid[] := ARRAY[]::uuid[];
  argument_index integer;
  actor_scope_changed boolean := false;
BEGIN
  evidence_business_unit_id := NULLIF(row_data ->> 'business_unit_id', '')::uuid;
  evidence_organization_id := (row_data ->> 'organization_id')::uuid;

  IF TG_OP = 'UPDATE' THEN
    old_data := to_jsonb(OLD);
    actor_scope_changed :=
      (old_data -> 'organization_id') IS DISTINCT FROM (row_data -> 'organization_id')
      OR (old_data -> 'business_unit_id') IS DISTINCT FROM (row_data -> 'business_unit_id');
    FOR argument_index IN 0..(TG_NARGS / 2 - 1) LOOP
      actor_column := TG_ARGV[argument_index * 2];
      actor_scope_changed := actor_scope_changed
        OR (old_data -> actor_column) IS DISTINCT FROM (row_data -> actor_column);
    END LOOP;
    IF NOT actor_scope_changed THEN
      RETURN NULL;
    END IF;
  END IF;

  FOR argument_index IN 0..(TG_NARGS / 2 - 1) LOOP
    actor_column := TG_ARGV[argument_index * 2];
    actor_id := NULLIF(row_data ->> actor_column, '')::uuid;
    IF actor_id IS NOT NULL THEN
      actor_ids := array_append(actor_ids, actor_id);
    END IF;
  END LOOP;

  PERFORM membership.id
    FROM memberships membership
   WHERE membership.organization_id = evidence_organization_id
     AND membership.id = ANY(actor_ids)
   ORDER BY membership.id
   FOR SHARE;

  FOR argument_index IN 0..(TG_NARGS / 2 - 1) LOOP
    actor_column := TG_ARGV[argument_index * 2];
    required_scope := TG_ARGV[argument_index * 2 + 1];
    actor_id := NULLIF(row_data ->> actor_column, '')::uuid;

    IF actor_id IS NULL THEN
      CONTINUE;
    END IF;

    SELECT membership.business_unit_id
      INTO actor_business_unit_id
      FROM memberships membership
     WHERE membership.organization_id = evidence_organization_id
       AND membership.id = actor_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'migration actor membership does not exist in tenant scope'
        USING ERRCODE = '23503';
    END IF;

    IF required_scope = 'ORG' AND actor_business_unit_id IS NOT NULL THEN
      RAISE EXCEPTION 'transition approval requires an organisation-wide membership'
        USING ERRCODE = '23514';
    END IF;

    IF
      required_scope = 'BU'
      AND actor_business_unit_id IS NOT NULL
      AND actor_business_unit_id IS DISTINCT FROM evidence_business_unit_id
    THEN
      RAISE EXCEPTION 'migration actor membership scope does not match the business unit'
        USING ERRCODE = '23514';
    END IF;
  END LOOP;

  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION crm_revalidate_migration_membership_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  old_data jsonb;
  new_data jsonb;
  affected_membership_ids uuid[] := ARRAY[]::uuid[];
  invalid_evidence text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    old_data := to_jsonb(OLD);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    new_data := to_jsonb(NEW);
  END IF;
  IF
    TG_OP = 'UPDATE'
    AND (old_data -> 'id') IS NOT DISTINCT FROM (new_data -> 'id')
    AND (old_data -> 'organization_id') IS NOT DISTINCT FROM (new_data -> 'organization_id')
    AND (old_data -> 'business_unit_id') IS NOT DISTINCT FROM (new_data -> 'business_unit_id')
  THEN
    RETURN NULL;
  END IF;
  IF old_data IS NOT NULL THEN
    affected_membership_ids := array_append(
      affected_membership_ids,
      (old_data ->> 'id')::uuid
    );
  END IF;
  IF new_data IS NOT NULL THEN
    affected_membership_ids := array_append(
      affected_membership_ids,
      (new_data ->> 'id')::uuid
    );
  END IF;

  WITH evidence AS (
    SELECT organization_id, business_unit_id, owner_membership_id AS actor_id,
           false AS require_orgwide, 'migration_sources.owner_membership_id' AS label
      FROM migration_sources
     WHERE owner_membership_id = ANY(affected_membership_ids)
    UNION ALL
    SELECT organization_id, NULL::uuid, approved_by_membership_id,
           true, 'source_authority_transition_groups.approved_by_membership_id'
      FROM source_authority_transition_groups
     WHERE approved_by_membership_id = ANY(affected_membership_ids)
    UNION ALL
    SELECT organization_id, business_unit_id, approved_by_membership_id,
           false, 'transform_versions.approved_by_membership_id'
      FROM transform_versions
     WHERE approved_by_membership_id IS NOT NULL
       AND approved_by_membership_id = ANY(affected_membership_ids)
    UNION ALL
    SELECT organization_id, business_unit_id, validated_by_membership_id,
           false, 'import_batches.validated_by_membership_id'
      FROM import_batches
     WHERE validated_by_membership_id IS NOT NULL
       AND validated_by_membership_id = ANY(affected_membership_ids)
    UNION ALL
    SELECT organization_id, business_unit_id, approved_by_membership_id,
           false, 'import_batches.approved_by_membership_id'
      FROM import_batches
     WHERE approved_by_membership_id IS NOT NULL
       AND approved_by_membership_id = ANY(affected_membership_ids)
    UNION ALL
    SELECT organization_id, business_unit_id, applied_by_membership_id,
           false, 'import_batches.applied_by_membership_id'
      FROM import_batches
     WHERE applied_by_membership_id IS NOT NULL
       AND applied_by_membership_id = ANY(affected_membership_ids)
    UNION ALL
    SELECT organization_id, business_unit_id, created_by_membership_id,
           false, 'legacy_object_links.created_by_membership_id'
      FROM legacy_object_links
     WHERE created_by_membership_id = ANY(affected_membership_ids)
    UNION ALL
    SELECT organization_id, business_unit_id, resolved_by_membership_id,
           false, 'quarantine_items.resolved_by_membership_id'
      FROM quarantine_items
     WHERE resolved_by_membership_id IS NOT NULL
       AND resolved_by_membership_id = ANY(affected_membership_ids)
    UNION ALL
    SELECT organization_id, business_unit_id, signed_by_membership_id,
           false, 'reconciliation_runs.signed_by_membership_id'
      FROM reconciliation_runs
     WHERE signed_by_membership_id IS NOT NULL
       AND signed_by_membership_id = ANY(affected_membership_ids)
  )
  SELECT evidence.label
    INTO invalid_evidence
    FROM evidence
    LEFT JOIN memberships membership
      ON membership.id = evidence.actor_id
   WHERE membership.id IS NULL
     OR membership.organization_id IS DISTINCT FROM evidence.organization_id
     OR (
       evidence.require_orgwide
       AND membership.business_unit_id IS NOT NULL
     )
     OR (
       NOT evidence.require_orgwide
       AND membership.business_unit_id IS NOT NULL
       AND membership.business_unit_id IS DISTINCT FROM evidence.business_unit_id
     )
   LIMIT 1;

  IF invalid_evidence IS NOT NULL THEN
    RAISE EXCEPTION 'membership scope invalidates migration evidence at %', invalid_evidence
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION crm_validate_live_batch_dry_run_lineage()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  old_data jsonb;
  new_data jsonb;
  affected_batch_ids uuid[] := ARRAY[]::uuid[];
  invalid_batch_id uuid;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    old_data := to_jsonb(OLD);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    new_data := to_jsonb(NEW);
  END IF;

  IF TG_OP = 'UPDATE' AND TG_ARGV[0] = 'LIVE' THEN
    IF
      (old_data -> 'id') IS NOT DISTINCT FROM (new_data -> 'id')
      AND (old_data -> 'organization_id') IS NOT DISTINCT FROM (new_data -> 'organization_id')
      AND (old_data -> 'business_unit_id') IS NOT DISTINCT FROM (new_data -> 'business_unit_id')
      AND (old_data -> 'migration_source_id')
        IS NOT DISTINCT FROM (new_data -> 'migration_source_id')
      AND (old_data -> 'source_sha256') IS NOT DISTINCT FROM (new_data -> 'source_sha256')
      AND (old_data -> 'transform_version_id')
        IS NOT DISTINCT FROM (new_data -> 'transform_version_id')
      AND (old_data -> 'validated_dry_run_batch_id')
        IS NOT DISTINCT FROM (new_data -> 'validated_dry_run_batch_id')
      AND (old_data -> 'dry_run') IS NOT DISTINCT FROM (new_data -> 'dry_run')
    THEN
      RETURN NULL;
    END IF;
  ELSIF TG_OP = 'UPDATE' AND TG_ARGV[0] = 'DRY' THEN
    IF
      (old_data -> 'id') IS NOT DISTINCT FROM (new_data -> 'id')
      AND (old_data -> 'organization_id') IS NOT DISTINCT FROM (new_data -> 'organization_id')
      AND (old_data -> 'business_unit_id') IS NOT DISTINCT FROM (new_data -> 'business_unit_id')
      AND (old_data -> 'migration_source_id')
        IS NOT DISTINCT FROM (new_data -> 'migration_source_id')
      AND (old_data -> 'source_sha256') IS NOT DISTINCT FROM (new_data -> 'source_sha256')
      AND (old_data -> 'transform_version_id')
        IS NOT DISTINCT FROM (new_data -> 'transform_version_id')
      AND (old_data -> 'dry_run') IS NOT DISTINCT FROM (new_data -> 'dry_run')
      AND (old_data -> 'status') IS NOT DISTINCT FROM (new_data -> 'status')
    THEN
      RETURN NULL;
    END IF;
  END IF;

  IF TG_ARGV[0] = 'LIVE' THEN
    IF old_data IS NOT NULL AND (old_data ->> 'dry_run')::boolean IS FALSE THEN
      affected_batch_ids := array_append(affected_batch_ids, (old_data ->> 'id')::uuid);
    END IF;
    IF new_data IS NOT NULL AND (new_data ->> 'dry_run')::boolean IS FALSE THEN
      affected_batch_ids := array_append(affected_batch_ids, (new_data ->> 'id')::uuid);
    END IF;

    PERFORM dry_run_batch.id
      FROM import_batches dry_run_batch
      JOIN import_batches live_batch
        ON live_batch.organization_id = dry_run_batch.organization_id
       AND live_batch.business_unit_id = dry_run_batch.business_unit_id
       AND live_batch.migration_source_id = dry_run_batch.migration_source_id
       AND live_batch.source_sha256 = dry_run_batch.source_sha256
       AND live_batch.transform_version_id = dry_run_batch.transform_version_id
       AND live_batch.validated_dry_run_batch_id = dry_run_batch.id
     WHERE live_batch.id = ANY(affected_batch_ids)
       AND NOT live_batch.dry_run
     ORDER BY dry_run_batch.organization_id, dry_run_batch.business_unit_id, dry_run_batch.id
     FOR SHARE OF dry_run_batch;
  ELSE
    IF old_data IS NOT NULL AND (old_data ->> 'dry_run')::boolean IS TRUE THEN
      affected_batch_ids := array_append(affected_batch_ids, (old_data ->> 'id')::uuid);
    END IF;
    IF new_data IS NOT NULL AND (new_data ->> 'dry_run')::boolean IS TRUE THEN
      affected_batch_ids := array_append(affected_batch_ids, (new_data ->> 'id')::uuid);
    END IF;

  END IF;

  IF cardinality(affected_batch_ids) = 0 THEN
    RETURN NULL;
  END IF;

  SELECT live_batch.id
    INTO invalid_batch_id
    FROM import_batches live_batch
    LEFT JOIN import_batches dry_run_batch
      ON dry_run_batch.organization_id = live_batch.organization_id
     AND dry_run_batch.business_unit_id = live_batch.business_unit_id
     AND dry_run_batch.migration_source_id = live_batch.migration_source_id
     AND dry_run_batch.source_sha256 = live_batch.source_sha256
     AND dry_run_batch.transform_version_id = live_batch.transform_version_id
     AND dry_run_batch.id = live_batch.validated_dry_run_batch_id
   WHERE NOT live_batch.dry_run
     AND (
       (TG_ARGV[0] = 'LIVE' AND live_batch.id = ANY(affected_batch_ids))
       OR
       (TG_ARGV[0] = 'DRY' AND live_batch.validated_dry_run_batch_id = ANY(affected_batch_ids))
     )
     AND (
       dry_run_batch.id IS NULL
       OR NOT dry_run_batch.dry_run
       OR dry_run_batch.status <> 'DRY_RUN_COMPLETE'
     )
   LIMIT 1;

  IF invalid_batch_id IS NOT NULL THEN
    RAISE EXCEPTION 'live batch % has invalid dry-run lineage', invalid_batch_id
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION crm_guard_approved_transform()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.approved_at IS NOT NULL THEN
    RAISE EXCEPTION 'approved transform versions are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION crm_guard_import_row_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'import row evidence is durable and must be retained'
      USING ERRCODE = '55000';
  END IF;

  IF
    NEW.id IS DISTINCT FROM OLD.id
    OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.business_unit_id IS DISTINCT FROM OLD.business_unit_id
    OR NEW.batch_id IS DISTINCT FROM OLD.batch_id
    OR NEW.source_row_key IS DISTINCT FROM OLD.source_row_key
    OR NEW.row_number IS DISTINCT FROM OLD.row_number
    OR NEW.source_object_type IS DISTINCT FROM OLD.source_object_type
    OR NEW.source_record_id IS DISTINCT FROM OLD.source_record_id
    OR NEW.source_locator IS DISTINCT FROM OLD.source_locator
    OR NEW.row_sha256 IS DISTINCT FROM OLD.row_sha256
    OR NEW.raw_evidence_ref IS DISTINCT FROM OLD.raw_evidence_ref
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'import row source identity and raw evidence are immutable'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION crm_validate_import_row_resolved_link()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  linked_identity_exists boolean;
BEGIN
  IF NEW.resolved_link_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT true
    INTO linked_identity_exists
    FROM import_batches batch
    JOIN legacy_object_links link
      ON link.organization_id = NEW.organization_id
     AND link.business_unit_id = NEW.business_unit_id
     AND link.id = NEW.resolved_link_id
     AND link.migration_source_id = batch.migration_source_id
     AND link.source_object_type = NEW.source_object_type
     AND link.source_row_key = NEW.source_row_key
   WHERE batch.organization_id = NEW.organization_id
     AND batch.business_unit_id = NEW.business_unit_id
     AND batch.id = NEW.batch_id;

  IF linked_identity_exists IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'resolved link does not match the import row source identity'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION crm_guard_import_batch_claim()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'FAILED' THEN
    RAISE EXCEPTION 'terminal failed import batch is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.apply_run_id IS NOT NULL THEN
      RAISE EXCEPTION 'claimed import batch cannot be deleted and must be retained'
        USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;

  IF
    OLD.apply_run_id IS NULL
    AND NEW.apply_run_id IS NOT NULL
  THEN
    IF OLD.status <> 'APPROVED' OR NEW.status <> 'APPLYING' THEN
      RAISE EXCEPTION 'initial claim transition must be APPROVED to APPLYING'
        USING ERRCODE = '55000';
    END IF;

    IF
      to_jsonb(NEW) - ARRAY[
        'status', 'applied_by_membership_id', 'apply_run_id',
        'apply_lease_expires_at', 'apply_started_at', 'version', 'updated_at'
      ]
      IS DISTINCT FROM
      to_jsonb(OLD) - ARRAY[
        'status', 'applied_by_membership_id', 'apply_run_id',
        'apply_lease_expires_at', 'apply_started_at', 'version', 'updated_at'
      ]
    THEN
      RAISE EXCEPTION 'initial claim cannot mutate the approved import batch envelope or counters'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  IF OLD.apply_run_id IS NOT NULL THEN
    IF OLD.status IN ('RECONCILED', 'FAILED') THEN
      RAISE EXCEPTION 'terminal claimed import batches are immutable'
        USING ERRCODE = '55000';
    END IF;

    IF
      NEW.id IS DISTINCT FROM OLD.id
      OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
      OR NEW.business_unit_id IS DISTINCT FROM OLD.business_unit_id
      OR NEW.migration_source_id IS DISTINCT FROM OLD.migration_source_id
      OR NEW.transform_version_id IS DISTINCT FROM OLD.transform_version_id
      OR NEW.validated_dry_run_batch_id IS DISTINCT FROM OLD.validated_dry_run_batch_id
      OR NEW.repair_of_batch_id IS DISTINCT FROM OLD.repair_of_batch_id
      OR NEW.protected_artifact_ref IS DISTINCT FROM OLD.protected_artifact_ref
      OR NEW.source_sha256 IS DISTINCT FROM OLD.source_sha256
      OR NEW.size_bytes IS DISTINCT FROM OLD.size_bytes
      OR NEW.captured_at IS DISTINCT FROM OLD.captured_at
      OR NEW.cutoff_at IS DISTINCT FROM OLD.cutoff_at
      OR NEW.schema_version IS DISTINCT FROM OLD.schema_version
      OR NEW.dry_run IS DISTINCT FROM OLD.dry_run
      OR NEW.validated_by_membership_id IS DISTINCT FROM OLD.validated_by_membership_id
      OR NEW.validated_at IS DISTINCT FROM OLD.validated_at
      OR NEW.approved_by_membership_id IS DISTINCT FROM OLD.approved_by_membership_id
      OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
      OR NEW.approval_mode IS DISTINCT FROM OLD.approval_mode
      OR NEW.approval_reason IS DISTINCT FROM OLD.approval_reason
      OR NEW.applied_by_membership_id IS DISTINCT FROM OLD.applied_by_membership_id
      OR NEW.apply_run_id IS DISTINCT FROM OLD.apply_run_id
      OR NEW.apply_started_at IS DISTINCT FROM OLD.apply_started_at
      OR NEW.operator_reason IS DISTINCT FROM OLD.operator_reason
      OR NEW.created_at IS DISTINCT FROM OLD.created_at
    THEN
      RAISE EXCEPTION 'claimed import batch acquisition envelope is immutable'
        USING ERRCODE = '55000';
    END IF;

    IF
      NEW.total_row_count IS DISTINCT FROM OLD.total_row_count
      OR NEW.staged_row_count IS DISTINCT FROM OLD.staged_row_count
      OR NEW.rejected_row_count IS DISTINCT FROM OLD.rejected_row_count
      OR NEW.quarantined_row_count IS DISTINCT FROM OLD.quarantined_row_count
      OR NEW.hidden_row_count IS DISTINCT FROM OLD.hidden_row_count
      OR NEW.approved_row_count IS DISTINCT FROM OLD.approved_row_count
    THEN
      RAISE EXCEPTION 'claimed import batch fixed counters are immutable'
        USING ERRCODE = '55000';
    END IF;

    IF
      NEW.valid_row_count > OLD.valid_row_count
      OR NEW.imported_row_count < OLD.imported_row_count
      OR NEW.no_op_row_count < OLD.no_op_row_count
    THEN
      RAISE EXCEPTION 'claimed import batch work counters cannot reverse direction'
        USING ERRCODE = '55000';
    END IF;

    IF
      OLD.status = 'APPLYING'
      AND NEW.apply_lease_expires_at < OLD.apply_lease_expires_at
    THEN
      RAISE EXCEPTION 'claimed import batch lease cannot regress while applying'
        USING ERRCODE = '55000';
    END IF;

    IF
      OLD.status = 'APPLIED'
      AND NEW.apply_lease_expires_at IS DISTINCT FROM OLD.apply_lease_expires_at
    THEN
      RAISE EXCEPTION 'claimed import batch lease is immutable after apply completion'
        USING ERRCODE = '55000';
    END IF;

    IF
      (OLD.status = 'APPLYING' AND NEW.status NOT IN ('APPLYING', 'APPLIED', 'FAILED'))
      OR (OLD.status = 'APPLIED' AND NEW.status NOT IN ('APPLIED', 'RECONCILED'))
    THEN
      RAISE EXCEPTION 'invalid claimed import batch status transition from % to %',
        OLD.status, NEW.status USING ERRCODE = '55000';
    END IF;

    IF OLD.applied_at IS NOT NULL AND NEW.applied_at IS DISTINCT FROM OLD.applied_at THEN
      RAISE EXCEPTION 'claimed import batch applied timestamp is immutable once set'
        USING ERRCODE = '55000';
    END IF;

    IF OLD.failure_code IS NOT NULL AND NEW.failure_code IS DISTINCT FROM OLD.failure_code THEN
      RAISE EXCEPTION 'claimed import batch failure evidence is immutable once set'
        USING ERRCODE = '55000';
    END IF;

  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION crm_validate_legacy_link_lineage()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_link legacy_object_links%ROWTYPE;
  imported_source_id uuid;
  imported_object_type text;
  imported_row_key text;
BEGIN
  SELECT batch.migration_source_id, import_row.source_object_type, import_row.source_row_key
    INTO imported_source_id, imported_object_type, imported_row_key
    FROM import_rows import_row
    JOIN import_batches batch
      ON batch.organization_id = import_row.organization_id
     AND batch.business_unit_id = import_row.business_unit_id
     AND batch.id = import_row.batch_id
   WHERE import_row.organization_id = NEW.organization_id
     AND import_row.business_unit_id = NEW.business_unit_id
     AND import_row.id = NEW.import_row_id;

  IF
    NOT FOUND
    OR imported_source_id IS DISTINCT FROM NEW.migration_source_id
    OR imported_object_type IS DISTINCT FROM NEW.source_object_type
    OR imported_row_key IS DISTINCT FROM NEW.source_row_key
  THEN
    RAISE EXCEPTION 'legacy link must match its import row source identity'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.link_version = 1 THEN
    RETURN NEW;
  END IF;

  SELECT *
    INTO parent_link
    FROM legacy_object_links
   WHERE organization_id = NEW.organization_id
     AND business_unit_id = NEW.business_unit_id
     AND migration_source_id = NEW.migration_source_id
     AND id = NEW.supersedes_link_id
   FOR KEY SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'legacy link correction parent does not exist in source scope'
      USING ERRCODE = '23503';
  END IF;

  IF
    NEW.link_version <> parent_link.link_version + 1
    OR NEW.source_object_type <> parent_link.source_object_type
    OR NEW.source_row_key <> parent_link.source_row_key
  THEN
    RAISE EXCEPTION 'legacy link correction must advance the same source identity exactly once'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1 FROM legacy_object_links successor
     WHERE successor.supersedes_link_id = parent_link.id
  ) THEN
    RAISE EXCEPTION 'legacy link correction must supersede the current chain head'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION crm_validate_reconciliation_requirements()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  requirement jsonb;
  requirement_kind text;
  requirement_unit text;
  requirement_scale integer;
  requirement_scale_numeric numeric;
  canonical_requirements jsonb;
  requirement_count integer;
  distinct_requirement_count integer;
BEGIN
  IF jsonb_typeof(NEW.required_checks) <> 'array' THEN
    RAISE EXCEPTION 'reconciliation requirements must be a JSON array'
      USING ERRCODE = '23514';
  END IF;

  IF jsonb_array_length(NEW.required_checks) <> NEW.required_check_count THEN
    RAISE EXCEPTION 'reconciliation requirement count does not match the protected set'
      USING ERRCODE = '23514';
  END IF;

  IF digest(convert_to(NEW.required_checks::text, 'UTF8'), 'sha256') <> NEW.required_checks_sha256 THEN
    RAISE EXCEPTION 'reconciliation requirement digest does not match the protected set'
      USING ERRCODE = '23514';
  END IF;

  FOR requirement IN SELECT value FROM jsonb_array_elements(NEW.required_checks) LOOP
    IF
      jsonb_typeof(requirement) <> 'object'
      OR NOT (requirement ?& ARRAY[
        'check_kind', 'check_key', 'scope_key', 'measure_unit', 'decimal_scale'
      ])
      OR requirement - ARRAY[
        'check_kind', 'check_key', 'scope_key', 'measure_unit', 'decimal_scale'
      ] <> '{}'::jsonb
    THEN
      RAISE EXCEPTION 'reconciliation requirement tuples must use the exact canonical fields'
        USING ERRCODE = '23514';
    END IF;

    IF
      jsonb_typeof(requirement -> 'check_kind') <> 'string'
      OR jsonb_typeof(requirement -> 'check_key') <> 'string'
      OR jsonb_typeof(requirement -> 'scope_key') <> 'string'
      OR jsonb_typeof(requirement -> 'measure_unit') NOT IN ('string', 'null')
      OR jsonb_typeof(requirement -> 'decimal_scale') NOT IN ('number', 'null')
    THEN
      RAISE EXCEPTION 'reconciliation requirement identity scalars must use canonical string, number, or null types'
        USING ERRCODE = '23514';
    END IF;

    requirement_kind := requirement ->> 'check_kind';
    requirement_unit := requirement ->> 'measure_unit';

    IF requirement_kind NOT IN (
      'COUNT', 'AMOUNT', 'CHECKSUM', 'UNIQUENESS', 'REFERENCE', 'TIMELINE',
      'LOT_ALLOCATION', 'FINANCE_BALANCE', 'FILE', 'SAMPLE'
    ) THEN
      RAISE EXCEPTION 'reconciliation requirement has an invalid check kind'
        USING ERRCODE = '23514';
    END IF;

    IF
      char_length(requirement ->> 'check_key') NOT BETWEEN 1 AND 127
      OR (requirement ->> 'check_key') !~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'
      OR char_length(btrim(requirement ->> 'scope_key')) NOT BETWEEN 1 AND 255
      OR (requirement ->> 'scope_key') !~ '^[a-z][a-z0-9_.:-]*$'
    THEN
      RAISE EXCEPTION 'reconciliation requirement identity is invalid'
        USING ERRCODE = '23514';
    END IF;

    IF requirement_kind IN ('AMOUNT', 'FINANCE_BALANCE') THEN
      IF
        requirement_unit IS NULL
        OR char_length(btrim(requirement_unit)) NOT BETWEEN 1 AND 32
        OR jsonb_typeof(requirement -> 'decimal_scale') <> 'number'
      THEN
        RAISE EXCEPTION 'amount reconciliation requirements need a unit and decimal scale'
          USING ERRCODE = '23514';
      END IF;
      requirement_scale_numeric := (requirement ->> 'decimal_scale')::numeric;
      requirement_scale := requirement_scale_numeric::integer;
      IF
        requirement_scale_numeric <> trunc(requirement_scale_numeric)
        OR requirement_scale NOT BETWEEN 0 AND 12
      THEN
        RAISE EXCEPTION 'reconciliation decimal scale is out of range'
          USING ERRCODE = '23514';
      END IF;
    ELSIF requirement_unit IS NOT NULL OR jsonb_typeof(requirement -> 'decimal_scale') <> 'null' THEN
      RAISE EXCEPTION 'non-amount reconciliation requirements cannot declare a unit or scale'
        USING ERRCODE = '23514';
    END IF;
  END LOOP;

  SELECT count(*), count(DISTINCT jsonb_build_array(
           value ->> 'check_kind',
           value ->> 'check_key',
           value ->> 'scope_key',
           value ->> 'measure_unit',
           (value ->> 'decimal_scale')::numeric
         ))
    INTO requirement_count, distinct_requirement_count
    FROM jsonb_array_elements(NEW.required_checks);

  IF requirement_count <> distinct_requirement_count THEN
    RAISE EXCEPTION 'reconciliation requirements contain duplicate tuple identities'
      USING ERRCODE = '23514';
  END IF;

  SELECT jsonb_agg(value ORDER BY
           value ->> 'check_kind',
           value ->> 'check_key',
           value ->> 'scope_key',
           value ->> 'measure_unit' NULLS FIRST,
           (value ->> 'decimal_scale')::numeric NULLS FIRST
         )
    INTO canonical_requirements
    FROM jsonb_array_elements(NEW.required_checks);

  IF canonical_requirements IS DISTINCT FROM NEW.required_checks THEN
    RAISE EXCEPTION 'reconciliation requirements must be in canonical sorted order'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION crm_guard_reconciliation_run()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'SIGNED' THEN
      RAISE EXCEPTION 'signed reconciliation runs are immutable'
        USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;

  IF
    NEW.id IS DISTINCT FROM OLD.id
    OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.business_unit_id IS DISTINCT FROM OLD.business_unit_id
    OR NEW.batch_id IS DISTINCT FROM OLD.batch_id
    OR NEW.run_no IS DISTINCT FROM OLD.run_no
    OR NEW.plan_artifact_ref IS DISTINCT FROM OLD.plan_artifact_ref
    OR NEW.plan_sha256 IS DISTINCT FROM OLD.plan_sha256
    OR NEW.required_checks IS DISTINCT FROM OLD.required_checks
    OR NEW.required_checks_sha256 IS DISTINCT FROM OLD.required_checks_sha256
    OR NEW.required_check_count IS DISTINCT FROM OLD.required_check_count
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'reconciliation plan and requirement envelope is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.status = 'SIGNED' THEN
    RAISE EXCEPTION 'signed reconciliation runs are immutable'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION crm_guard_signed_reconciliation_result()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_run_id uuid;
  parent_organization_id uuid;
  parent_business_unit_id uuid;
  parent_run_status text;
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW.id IS DISTINCT FROM OLD.id
    OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.business_unit_id IS DISTINCT FROM OLD.business_unit_id
    OR NEW.run_id IS DISTINCT FROM OLD.run_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  ) THEN
    RAISE EXCEPTION 'reconciliation result parent identity is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'DELETE' THEN
    parent_run_id := OLD.run_id;
    parent_organization_id := OLD.organization_id;
    parent_business_unit_id := OLD.business_unit_id;
  ELSIF TG_OP = 'UPDATE' THEN
    parent_run_id := OLD.run_id;
    parent_organization_id := OLD.organization_id;
    parent_business_unit_id := OLD.business_unit_id;
  ELSE
    parent_run_id := NEW.run_id;
    parent_organization_id := NEW.organization_id;
    parent_business_unit_id := NEW.business_unit_id;
  END IF;

  SELECT status INTO parent_run_status
    FROM reconciliation_runs
   WHERE organization_id = parent_organization_id
     AND business_unit_id = parent_business_unit_id
     AND id = parent_run_id
   FOR SHARE;

  IF parent_run_status = 'SIGNED' THEN
    RAISE EXCEPTION 'signed reconciliation results are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION crm_validate_reconciliation_signoff()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  old_data jsonb;
  new_data jsonb;
  affected_run_ids uuid[] := ARRAY[]::uuid[];
  invalid_run_id uuid;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    old_data := to_jsonb(OLD);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    new_data := to_jsonb(NEW);
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF
      TG_TABLE_NAME = 'reconciliation_runs'
      AND (old_data -> 'id') IS NOT DISTINCT FROM (new_data -> 'id')
      AND (old_data -> 'organization_id') IS NOT DISTINCT FROM (new_data -> 'organization_id')
      AND (old_data -> 'business_unit_id') IS NOT DISTINCT FROM (new_data -> 'business_unit_id')
      AND (old_data -> 'status') IS NOT DISTINCT FROM (new_data -> 'status')
      AND (old_data -> 'required_checks') IS NOT DISTINCT FROM (new_data -> 'required_checks')
      AND (old_data -> 'required_check_count')
        IS NOT DISTINCT FROM (new_data -> 'required_check_count')
      AND (old_data -> 'passed_check_count')
        IS NOT DISTINCT FROM (new_data -> 'passed_check_count')
      AND (old_data -> 'failed_check_count')
        IS NOT DISTINCT FROM (new_data -> 'failed_check_count')
    THEN
      RETURN NULL;
    ELSIF
      TG_TABLE_NAME = 'reconciliation_results'
      AND (old_data -> 'organization_id') IS NOT DISTINCT FROM (new_data -> 'organization_id')
      AND (old_data -> 'business_unit_id') IS NOT DISTINCT FROM (new_data -> 'business_unit_id')
      AND (old_data -> 'run_id') IS NOT DISTINCT FROM (new_data -> 'run_id')
      AND (old_data -> 'check_kind') IS NOT DISTINCT FROM (new_data -> 'check_kind')
      AND (old_data -> 'check_key') IS NOT DISTINCT FROM (new_data -> 'check_key')
      AND (old_data -> 'scope_key') IS NOT DISTINCT FROM (new_data -> 'scope_key')
      AND (old_data -> 'measure_unit') IS NOT DISTINCT FROM (new_data -> 'measure_unit')
      AND (old_data -> 'decimal_scale') IS NOT DISTINCT FROM (new_data -> 'decimal_scale')
      AND (old_data -> 'passed') IS NOT DISTINCT FROM (new_data -> 'passed')
    THEN
      RETURN NULL;
    END IF;
  END IF;

  IF TG_TABLE_NAME = 'reconciliation_runs' THEN
    IF old_data IS NOT NULL THEN
      affected_run_ids := array_append(affected_run_ids, (old_data ->> 'id')::uuid);
    END IF;
    IF new_data IS NOT NULL THEN
      affected_run_ids := array_append(affected_run_ids, (new_data ->> 'id')::uuid);
    END IF;
  ELSE
    IF old_data IS NOT NULL THEN
      affected_run_ids := array_append(affected_run_ids, (old_data ->> 'run_id')::uuid);
    END IF;
    IF new_data IS NOT NULL THEN
      affected_run_ids := array_append(affected_run_ids, (new_data ->> 'run_id')::uuid);
    END IF;
  END IF;

  SELECT reconciliation_run.id
    INTO invalid_run_id
    FROM reconciliation_runs reconciliation_run
   WHERE reconciliation_run.id = ANY(affected_run_ids)
     AND reconciliation_run.status = 'SIGNED'
     AND (
       (SELECT count(*) FROM reconciliation_results result
         WHERE result.organization_id = reconciliation_run.organization_id
           AND result.run_id = reconciliation_run.id) <> reconciliation_run.required_check_count
       OR
       (SELECT count(*) FROM reconciliation_results result
         WHERE result.organization_id = reconciliation_run.organization_id
           AND result.run_id = reconciliation_run.id
           AND result.passed) <> reconciliation_run.passed_check_count
       OR
       (SELECT count(*) FROM reconciliation_results result
         WHERE result.organization_id = reconciliation_run.organization_id
           AND result.run_id = reconciliation_run.id
           AND NOT result.passed) <> reconciliation_run.failed_check_count
       OR EXISTS (
         SELECT
           result.check_kind,
           result.check_key,
           result.scope_key,
           result.measure_unit,
           result.decimal_scale
         FROM reconciliation_results result
         WHERE result.organization_id = reconciliation_run.organization_id
           AND result.run_id = reconciliation_run.id
         EXCEPT
         SELECT
           requirement ->> 'check_kind',
           requirement ->> 'check_key',
           requirement ->> 'scope_key',
           requirement ->> 'measure_unit',
           (requirement ->> 'decimal_scale')::smallint
         FROM jsonb_array_elements(reconciliation_run.required_checks) requirement
       )
       OR EXISTS (
         SELECT
           requirement ->> 'check_kind',
           requirement ->> 'check_key',
           requirement ->> 'scope_key',
           requirement ->> 'measure_unit',
           (requirement ->> 'decimal_scale')::smallint
         FROM jsonb_array_elements(reconciliation_run.required_checks) requirement
         EXCEPT
         SELECT
           result.check_kind,
           result.check_key,
           result.scope_key,
           result.measure_unit,
           result.decimal_scale
         FROM reconciliation_results result
         WHERE result.organization_id = reconciliation_run.organization_id
           AND result.run_id = reconciliation_run.id
       )
     )
   LIMIT 1;

  IF invalid_run_id IS NOT NULL THEN
    RAISE EXCEPTION 'reconciliation sign-off does not exactly match required passed tuples for run %',
      invalid_run_id USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$;

-- Authority heads and source scopes are validated from both relationship sides.
CREATE CONSTRAINT TRIGGER migration_authority_scope_from_authority_guard
AFTER INSERT OR UPDATE OR DELETE ON migration_domain_authorities
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION crm_validate_migration_authority_scope();

CREATE CONSTRAINT TRIGGER migration_authority_scope_from_scope_guard
AFTER INSERT OR UPDATE OR DELETE ON migration_source_scopes
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION crm_validate_migration_authority_scope();

CREATE TRIGGER migration_domain_authorities_terminal_guard
BEFORE UPDATE OR DELETE ON migration_domain_authorities
FOR EACH ROW EXECUTE FUNCTION crm_guard_terminal_migration_authority();

-- Group completeness is commit-time and insert order independent.
CREATE TRIGGER source_authority_transition_groups_effective_at
BEFORE INSERT ON source_authority_transition_groups
FOR EACH ROW EXECUTE FUNCTION crm_set_transition_group_effective_at();

CREATE CONSTRAINT TRIGGER migration_transition_group_from_group_guard
AFTER INSERT OR UPDATE OR DELETE ON source_authority_transition_groups
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION crm_validate_transition_group_completeness();

CREATE CONSTRAINT TRIGGER migration_transition_group_from_transition_guard
AFTER INSERT OR UPDATE OR DELETE ON source_authority_transitions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION crm_validate_transition_group_completeness();

CREATE CONSTRAINT TRIGGER migration_transition_evidence_from_transition_guard
AFTER INSERT OR UPDATE OR DELETE ON source_authority_transitions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION crm_validate_authority_transition_evidence();

CREATE CONSTRAINT TRIGGER migration_transition_evidence_from_batch_guard
AFTER INSERT OR UPDATE OR DELETE ON import_batches
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION crm_validate_authority_transition_evidence();

CREATE CONSTRAINT TRIGGER migration_transition_evidence_from_authority_guard
AFTER INSERT OR UPDATE OR DELETE ON migration_domain_authorities
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION crm_validate_authority_transition_evidence();

CREATE CONSTRAINT TRIGGER migration_transition_evidence_from_scope_guard
AFTER INSERT OR UPDATE OR DELETE ON migration_source_scopes
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION crm_validate_authority_transition_evidence();

-- Actor scope is validated when evidence changes and when membership scope changes later.
CREATE CONSTRAINT TRIGGER migration_membership_from_evidence_guard
AFTER INSERT OR UPDATE ON migration_sources
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION crm_validate_migration_actor_scope('owner_membership_id', 'BU');

CREATE CONSTRAINT TRIGGER migration_membership_from_evidence_guard
AFTER INSERT OR UPDATE ON source_authority_transition_groups
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION crm_validate_migration_actor_scope('approved_by_membership_id', 'ORG');

CREATE CONSTRAINT TRIGGER migration_membership_from_evidence_guard
AFTER INSERT OR UPDATE ON transform_versions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION crm_validate_migration_actor_scope('approved_by_membership_id', 'BU');

CREATE CONSTRAINT TRIGGER migration_membership_from_evidence_guard
AFTER INSERT OR UPDATE ON import_batches
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION crm_validate_migration_actor_scope(
  'validated_by_membership_id', 'BU',
  'approved_by_membership_id', 'BU',
  'applied_by_membership_id', 'BU'
);

CREATE CONSTRAINT TRIGGER migration_membership_from_evidence_guard
AFTER INSERT OR UPDATE ON legacy_object_links
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION crm_validate_migration_actor_scope('created_by_membership_id', 'BU');

CREATE CONSTRAINT TRIGGER migration_membership_from_evidence_guard
AFTER INSERT OR UPDATE ON quarantine_items
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION crm_validate_migration_actor_scope('resolved_by_membership_id', 'BU');

CREATE CONSTRAINT TRIGGER migration_membership_from_evidence_guard
AFTER INSERT OR UPDATE ON reconciliation_runs
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION crm_validate_migration_actor_scope('signed_by_membership_id', 'BU');

CREATE CONSTRAINT TRIGGER migration_membership_from_membership_guard
AFTER UPDATE OR DELETE ON memberships
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION crm_revalidate_migration_membership_evidence();

-- Live imports remain bound to an unchanged, terminal dry-run proof.
CREATE CONSTRAINT TRIGGER migration_live_batch_from_live_guard
AFTER INSERT OR UPDATE OR DELETE ON import_batches
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION crm_validate_live_batch_dry_run_lineage('LIVE');

CREATE CONSTRAINT TRIGGER migration_live_batch_from_dry_guard
AFTER INSERT OR UPDATE OR DELETE ON import_batches
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION crm_validate_live_batch_dry_run_lineage('DRY');

-- Protected records and acquisition envelopes.
CREATE TRIGGER transform_versions_approved_guard
BEFORE UPDATE OR DELETE ON transform_versions
FOR EACH ROW EXECUTE FUNCTION crm_guard_approved_transform();

CREATE TRIGGER import_batches_claim_guard
BEFORE UPDATE OR DELETE ON import_batches
FOR EACH ROW EXECUTE FUNCTION crm_guard_import_batch_claim();

CREATE TRIGGER import_rows_evidence_guard
BEFORE UPDATE OR DELETE ON import_rows
FOR EACH ROW EXECUTE FUNCTION crm_guard_import_row_evidence();

CREATE TRIGGER import_rows_resolved_link_guard
BEFORE INSERT OR UPDATE OF
  organization_id, business_unit_id, batch_id, source_object_type, source_row_key, resolved_link_id
ON import_rows
FOR EACH ROW EXECUTE FUNCTION crm_validate_import_row_resolved_link();

CREATE TRIGGER legacy_object_links_lineage_guard
BEFORE INSERT ON legacy_object_links
FOR EACH ROW EXECUTE FUNCTION crm_validate_legacy_link_lineage();

CREATE TRIGGER reconciliation_runs_requirements_guard
BEFORE INSERT OR UPDATE OF
  required_checks, required_checks_sha256, required_check_count
ON reconciliation_runs
FOR EACH ROW EXECUTE FUNCTION crm_validate_reconciliation_requirements();

CREATE TRIGGER reconciliation_runs_mutation_guard
BEFORE UPDATE OR DELETE ON reconciliation_runs
FOR EACH ROW EXECUTE FUNCTION crm_guard_reconciliation_run();

CREATE TRIGGER reconciliation_results_signed_guard
BEFORE INSERT OR UPDATE OR DELETE ON reconciliation_results
FOR EACH ROW EXECUTE FUNCTION crm_guard_signed_reconciliation_result();

CREATE CONSTRAINT TRIGGER migration_reconciliation_from_run_guard
AFTER INSERT OR UPDATE OR DELETE ON reconciliation_runs
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION crm_validate_reconciliation_signoff();

CREATE CONSTRAINT TRIGGER migration_reconciliation_from_result_guard
AFTER INSERT OR UPDATE OR DELETE ON reconciliation_results
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION crm_validate_reconciliation_signoff();

-- Optimistic versioning for mutable control-plane rows.
CREATE TRIGGER migration_sources_touch_version
BEFORE UPDATE ON migration_sources
FOR EACH ROW EXECUTE FUNCTION crm_touch_version();

CREATE TRIGGER migration_source_scopes_touch_version
BEFORE UPDATE ON migration_source_scopes
FOR EACH ROW EXECUTE FUNCTION crm_touch_version();

CREATE TRIGGER migration_domain_authorities_touch_version
BEFORE UPDATE ON migration_domain_authorities
FOR EACH ROW EXECUTE FUNCTION crm_touch_version();

CREATE TRIGGER import_batches_touch_version
BEFORE UPDATE ON import_batches
FOR EACH ROW EXECUTE FUNCTION crm_touch_version();

CREATE TRIGGER import_rows_touch_version
BEFORE UPDATE ON import_rows
FOR EACH ROW EXECUTE FUNCTION crm_touch_version();

CREATE TRIGGER quarantine_items_touch_version
BEFORE UPDATE ON quarantine_items
FOR EACH ROW EXECUTE FUNCTION crm_touch_version();

CREATE TRIGGER reconciliation_runs_touch_version
BEFORE UPDATE ON reconciliation_runs
FOR EACH ROW EXECUTE FUNCTION crm_touch_version();

-- Historical group, transition, and link evidence is fully append-only.
CREATE TRIGGER source_authority_transition_groups_append_only
BEFORE UPDATE OR DELETE OR TRUNCATE ON source_authority_transition_groups
FOR EACH STATEMENT EXECUTE FUNCTION crm_block_mutation();

CREATE TRIGGER source_authority_transitions_append_only
BEFORE UPDATE OR DELETE OR TRUNCATE ON source_authority_transitions
FOR EACH STATEMENT EXECUTE FUNCTION crm_block_mutation();

CREATE TRIGGER legacy_object_links_append_only
BEFORE UPDATE OR DELETE OR TRUNCATE ON legacy_object_links
FOR EACH STATEMENT EXECUTE FUNCTION crm_block_mutation();

-- TRUNCATE bypasses row-level guards, so every control-plane table blocks it.
CREATE TRIGGER migration_control_plane_no_truncate
BEFORE TRUNCATE ON migration_sources
FOR EACH STATEMENT EXECUTE FUNCTION crm_block_mutation();
CREATE TRIGGER migration_control_plane_no_truncate
BEFORE TRUNCATE ON migration_source_scopes
FOR EACH STATEMENT EXECUTE FUNCTION crm_block_mutation();
CREATE TRIGGER migration_control_plane_no_truncate
BEFORE TRUNCATE ON migration_domain_authorities
FOR EACH STATEMENT EXECUTE FUNCTION crm_block_mutation();
CREATE TRIGGER migration_control_plane_no_truncate
BEFORE TRUNCATE ON source_authority_transition_groups
FOR EACH STATEMENT EXECUTE FUNCTION crm_block_mutation();
CREATE TRIGGER migration_control_plane_no_truncate
BEFORE TRUNCATE ON transform_versions
FOR EACH STATEMENT EXECUTE FUNCTION crm_block_mutation();
CREATE TRIGGER migration_control_plane_no_truncate
BEFORE TRUNCATE ON import_batches
FOR EACH STATEMENT EXECUTE FUNCTION crm_block_mutation();
CREATE TRIGGER migration_control_plane_no_truncate
BEFORE TRUNCATE ON source_authority_transitions
FOR EACH STATEMENT EXECUTE FUNCTION crm_block_mutation();
CREATE TRIGGER migration_control_plane_no_truncate
BEFORE TRUNCATE ON import_rows
FOR EACH STATEMENT EXECUTE FUNCTION crm_block_mutation();
CREATE TRIGGER migration_control_plane_no_truncate
BEFORE TRUNCATE ON legacy_object_links
FOR EACH STATEMENT EXECUTE FUNCTION crm_block_mutation();
CREATE TRIGGER migration_control_plane_no_truncate
BEFORE TRUNCATE ON quarantine_items
FOR EACH STATEMENT EXECUTE FUNCTION crm_block_mutation();
CREATE TRIGGER migration_control_plane_no_truncate
BEFORE TRUNCATE ON reconciliation_runs
FOR EACH STATEMENT EXECUTE FUNCTION crm_block_mutation();
CREATE TRIGGER migration_control_plane_no_truncate
BEFORE TRUNCATE ON reconciliation_results
FOR EACH STATEMENT EXECUTE FUNCTION crm_block_mutation();

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Mutable aggregate rows own updated_at and a monotonically increasing version.
CREATE OR REPLACE FUNCTION crm_touch_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.created_at := OLD.created_at;
  NEW.updated_at := clock_timestamp();
  NEW.version := OLD.version + 1;
  RETURN NEW;
END;
$$;

-- Append-only evidence must be corrected through a compensating record.
CREATE OR REPLACE FUNCTION crm_block_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; create a compensating record instead', TG_TABLE_NAME
    USING ERRCODE = '55000';
END;
$$;

-- The acquisition envelope never changes. Terminal decisions are durable, and
-- only expired records may be purged through row-scoped housekeeping.
CREATE OR REPLACE FUNCTION crm_guard_idempotency_record()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'idempotency records cannot be truncated; purge expired rows explicitly'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.expires_at > clock_timestamp() THEN
      RAISE EXCEPTION 'unexpired idempotency records cannot be deleted'
        USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;

  IF
    NEW.id IS DISTINCT FROM OLD.id OR
    NEW.organization_id IS DISTINCT FROM OLD.organization_id OR
    NEW.business_unit_id IS DISTINCT FROM OLD.business_unit_id OR
    NEW.actor_scope IS DISTINCT FROM OLD.actor_scope OR
    NEW.actor_user_id IS DISTINCT FROM OLD.actor_user_id OR
    NEW.command_name IS DISTINCT FROM OLD.command_name OR
    NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key OR
    NEW.request_hash IS DISTINCT FROM OLD.request_hash OR
    NEW.locked_at IS DISTINCT FROM OLD.locked_at OR
    NEW.expires_at < OLD.expires_at OR
    NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'idempotency acquisition envelopes are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.status IN ('COMPLETED', 'FAILED') AND (
    NEW.status IS DISTINCT FROM OLD.status OR
    NEW.result_entity_type IS DISTINCT FROM OLD.result_entity_type OR
    NEW.result_entity_id IS DISTINCT FROM OLD.result_entity_id OR
    NEW.response_code IS DISTINCT FROM OLD.response_code OR
    NEW.response_snapshot IS DISTINCT FROM OLD.response_snapshot OR
    NEW.response_mac IS DISTINCT FROM OLD.response_mac OR
    NEW.error_code IS DISTINCT FROM OLD.error_code OR
    NEW.completed_at IS DISTINCT FROM OLD.completed_at
  ) THEN
    RAISE EXCEPTION 'terminal idempotency decisions are immutable'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- Tenant, identity, and access
-- ---------------------------------------------------------------------------

CREATE TABLE organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL,
  name text NOT NULL,
  default_timezone text NOT NULL DEFAULT 'Asia/Kuala_Lumpur',
  default_currency char(3) NOT NULL DEFAULT 'MYR',
  status text NOT NULL DEFAULT 'ACTIVE',
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT organizations_code_format CHECK (code ~ '^[a-z][a-z0-9-]{1,62}$'),
  CONSTRAINT organizations_code_unique UNIQUE (code),
  CONSTRAINT organizations_name_nonempty CHECK (btrim(name) <> ''),
  CONSTRAINT organizations_currency_format CHECK (default_currency ~ '^[A-Z]{3}$'),
  CONSTRAINT organizations_status_valid CHECK (status IN ('ACTIVE', 'SUSPENDED', 'CLOSED')),
  CONSTRAINT organizations_version_positive CHECK (version >= 1),
  CONSTRAINT organizations_tenant_key UNIQUE (id, code)
);

CREATE TABLE business_units (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  timezone text NOT NULL DEFAULT 'Asia/Kuala_Lumpur',
  currency char(3) NOT NULL DEFAULT 'MYR',
  status text NOT NULL DEFAULT 'ACTIVE',
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT business_units_organization_fk FOREIGN KEY (organization_id)
    REFERENCES organizations (id),
  CONSTRAINT business_units_code_format CHECK (code ~ '^[a-z][a-z0-9-]{1,62}$'),
  CONSTRAINT business_units_name_nonempty CHECK (btrim(name) <> ''),
  CONSTRAINT business_units_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT business_units_status_valid CHECK (status IN ('ACTIVE', 'SUSPENDED', 'CLOSED')),
  CONSTRAINT business_units_version_positive CHECK (version >= 1),
  CONSTRAINT business_units_code_unique UNIQUE (organization_id, code),
  CONSTRAINT business_units_tenant_key UNIQUE (organization_id, id)
);

CREATE INDEX business_units_organization_status_idx
  ON business_units (organization_id, status);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_subject text NOT NULL,
  display_name text NOT NULL,
  email_hash bytea,
  user_type text NOT NULL DEFAULT 'HUMAN',
  status text NOT NULL DEFAULT 'PENDING',
  last_authenticated_at timestamptz,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT users_auth_subject_unique UNIQUE (auth_subject),
  CONSTRAINT users_display_name_nonempty CHECK (btrim(display_name) <> ''),
  CONSTRAINT users_type_valid CHECK (user_type IN ('HUMAN', 'SERVICE')),
  CONSTRAINT users_status_valid CHECK (status IN ('PENDING', 'ACTIVE', 'SUSPENDED', 'DISABLED')),
  CONSTRAINT users_version_positive CHECK (version >= 1)
);

CREATE INDEX users_email_hash_idx ON users (email_hash) WHERE email_hash IS NOT NULL;

CREATE TABLE memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_unit_id uuid,
  user_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE',
  valid_from timestamptz NOT NULL DEFAULT clock_timestamp(),
  valid_until timestamptz,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT memberships_organization_fk FOREIGN KEY (organization_id)
    REFERENCES organizations (id),
  CONSTRAINT memberships_business_unit_fk FOREIGN KEY (organization_id, business_unit_id)
    REFERENCES business_units (organization_id, id),
  CONSTRAINT memberships_user_fk FOREIGN KEY (user_id)
    REFERENCES users (id),
  CONSTRAINT memberships_status_valid CHECK (status IN ('INVITED', 'ACTIVE', 'SUSPENDED', 'EXPIRED', 'REVOKED')),
  CONSTRAINT memberships_valid_window CHECK (valid_until IS NULL OR valid_until > valid_from),
  CONSTRAINT memberships_version_positive CHECK (version >= 1),
  CONSTRAINT memberships_org_key UNIQUE (organization_id, id),
  CONSTRAINT memberships_bu_key UNIQUE (organization_id, business_unit_id, id)
);

CREATE UNIQUE INDEX memberships_org_user_unique
  ON memberships (organization_id, user_id)
  WHERE business_unit_id IS NULL;

CREATE UNIQUE INDEX memberships_bu_user_unique
  ON memberships (organization_id, business_unit_id, user_id)
  WHERE business_unit_id IS NOT NULL;

CREATE INDEX memberships_user_status_idx ON memberships (user_id, status);
CREATE INDEX memberships_tenant_status_idx
  ON memberships (organization_id, business_unit_id, status);

CREATE TABLE capabilities (
  key text PRIMARY KEY,
  description text NOT NULL,
  risk_level text NOT NULL DEFAULT 'STANDARD',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT capabilities_key_format CHECK (key ~ '^[a-z][a-z0-9_.:-]{2,127}$'),
  CONSTRAINT capabilities_description_nonempty CHECK (btrim(description) <> ''),
  CONSTRAINT capabilities_risk_valid CHECK (risk_level IN ('STANDARD', 'SENSITIVE', 'PRIVILEGED'))
);

CREATE TABLE roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  key text NOT NULL,
  name text NOT NULL,
  description text,
  is_system boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'ACTIVE',
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT roles_organization_fk FOREIGN KEY (organization_id)
    REFERENCES organizations (id),
  CONSTRAINT roles_key_format CHECK (key ~ '^[a-z][a-z0-9_.:-]{1,127}$'),
  CONSTRAINT roles_name_nonempty CHECK (btrim(name) <> ''),
  CONSTRAINT roles_status_valid CHECK (status IN ('ACTIVE', 'DISABLED')),
  CONSTRAINT roles_version_positive CHECK (version >= 1),
  CONSTRAINT roles_key_unique UNIQUE (organization_id, key),
  CONSTRAINT roles_tenant_key UNIQUE (organization_id, id)
);

CREATE TABLE role_capabilities (
  organization_id uuid NOT NULL,
  role_id uuid NOT NULL,
  capability_key text NOT NULL,
  constraints jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, role_id, capability_key),
  CONSTRAINT role_capabilities_role_fk FOREIGN KEY (organization_id, role_id)
    REFERENCES roles (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT role_capabilities_capability_fk FOREIGN KEY (capability_key)
    REFERENCES capabilities (key),
  CONSTRAINT role_capabilities_constraints_object CHECK (jsonb_typeof(constraints) = 'object')
);

CREATE TABLE membership_roles (
  organization_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  role_id uuid NOT NULL,
  granted_by_user_id uuid,
  valid_from timestamptz NOT NULL DEFAULT clock_timestamp(),
  valid_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, membership_id, role_id),
  CONSTRAINT membership_roles_membership_fk FOREIGN KEY (organization_id, membership_id)
    REFERENCES memberships (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT membership_roles_role_fk FOREIGN KEY (organization_id, role_id)
    REFERENCES roles (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT membership_roles_grantor_fk FOREIGN KEY (granted_by_user_id)
    REFERENCES users (id),
  CONSTRAINT membership_roles_valid_window CHECK (valid_until IS NULL OR valid_until > valid_from)
);

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  active_business_unit_id uuid,
  user_id uuid NOT NULL,
  token_hash bytea NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE',
  assurance_level smallint NOT NULL DEFAULT 1,
  issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoke_reason text,
  ip_hash bytea,
  user_agent_hash bytea,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT sessions_organization_fk FOREIGN KEY (organization_id)
    REFERENCES organizations (id),
  CONSTRAINT sessions_business_unit_fk FOREIGN KEY (organization_id, active_business_unit_id)
    REFERENCES business_units (organization_id, id),
  CONSTRAINT sessions_user_fk FOREIGN KEY (user_id)
    REFERENCES users (id),
  CONSTRAINT sessions_token_hash_unique UNIQUE (token_hash),
  CONSTRAINT sessions_status_valid CHECK (status IN ('ACTIVE', 'REVOKED', 'EXPIRED')),
  CONSTRAINT sessions_assurance_valid CHECK (assurance_level BETWEEN 1 AND 3),
  CONSTRAINT sessions_expiry_valid CHECK (expires_at > issued_at),
  CONSTRAINT sessions_revoke_state CHECK (
    (status = 'REVOKED' AND revoked_at IS NOT NULL) OR
    (status <> 'REVOKED')
  ),
  CONSTRAINT sessions_version_positive CHECK (version >= 1),
  CONSTRAINT sessions_tenant_key UNIQUE (organization_id, id)
);

CREATE INDEX sessions_user_active_idx
  ON sessions (user_id, expires_at)
  WHERE status = 'ACTIVE';

CREATE INDEX sessions_tenant_active_idx
  ON sessions (organization_id, active_business_unit_id, expires_at)
  WHERE status = 'ACTIVE';

CREATE TABLE auth_login_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid,
  user_id uuid,
  attempted_identifier_hash bytea NOT NULL,
  outcome text NOT NULL,
  failure_code text,
  ip_hash bytea,
  user_agent_hash bytea,
  correlation_id uuid,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT auth_login_attempts_organization_fk FOREIGN KEY (organization_id)
    REFERENCES organizations (id),
  CONSTRAINT auth_login_attempts_user_fk FOREIGN KEY (user_id)
    REFERENCES users (id),
  CONSTRAINT auth_login_attempts_outcome_valid CHECK (outcome IN ('SUCCESS', 'FAILURE', 'BLOCKED', 'CHALLENGE')),
  CONSTRAINT auth_login_attempts_failure_consistency CHECK (
    outcome = 'SUCCESS' OR failure_code IS NOT NULL
  )
);

CREATE INDEX auth_login_attempts_identifier_time_idx
  ON auth_login_attempts (attempted_identifier_hash, occurred_at DESC);
CREATE INDEX auth_login_attempts_user_time_idx
  ON auth_login_attempts (user_id, occurred_at DESC)
  WHERE user_id IS NOT NULL;

CREATE TABLE teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_unit_id uuid NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE',
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT teams_business_unit_fk FOREIGN KEY (organization_id, business_unit_id)
    REFERENCES business_units (organization_id, id),
  CONSTRAINT teams_code_format CHECK (code ~ '^[a-z][a-z0-9-]{1,62}$'),
  CONSTRAINT teams_name_nonempty CHECK (btrim(name) <> ''),
  CONSTRAINT teams_status_valid CHECK (status IN ('ACTIVE', 'DISABLED')),
  CONSTRAINT teams_version_positive CHECK (version >= 1),
  CONSTRAINT teams_code_unique UNIQUE (organization_id, business_unit_id, code),
  CONSTRAINT teams_tenant_key UNIQUE (organization_id, business_unit_id, id)
);

CREATE TABLE team_memberships (
  organization_id uuid NOT NULL,
  business_unit_id uuid NOT NULL,
  team_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  is_manager boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, business_unit_id, team_id, membership_id),
  CONSTRAINT team_memberships_team_fk FOREIGN KEY (organization_id, business_unit_id, team_id)
    REFERENCES teams (organization_id, business_unit_id, id) ON DELETE CASCADE,
  CONSTRAINT team_memberships_membership_fk FOREIGN KEY (organization_id, business_unit_id, membership_id)
    REFERENCES memberships (organization_id, business_unit_id, id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------------------
-- Parties, identifiers, and consent
-- ---------------------------------------------------------------------------

CREATE TABLE accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  account_type text NOT NULL DEFAULT 'BUSINESS',
  display_name text NOT NULL,
  legal_name text,
  registration_number_hash bytea,
  status text NOT NULL DEFAULT 'ACTIVE',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT accounts_organization_fk FOREIGN KEY (organization_id)
    REFERENCES organizations (id),
  CONSTRAINT accounts_type_valid CHECK (account_type IN ('BUSINESS', 'INSTITUTION', 'HOUSEHOLD')),
  CONSTRAINT accounts_display_name_nonempty CHECK (btrim(display_name) <> ''),
  CONSTRAINT accounts_status_valid CHECK (status IN ('ACTIVE', 'INACTIVE', 'POSSIBLE_DUPLICATE', 'MERGED', 'ANONYMIZED')),
  CONSTRAINT accounts_metadata_object CHECK (jsonb_typeof(metadata) = 'object'),
  CONSTRAINT accounts_version_positive CHECK (version >= 1),
  CONSTRAINT accounts_tenant_key UNIQUE (organization_id, id)
);

CREATE INDEX accounts_organization_status_idx ON accounts (organization_id, status);
CREATE INDEX accounts_registration_hash_idx
  ON accounts (organization_id, registration_number_hash)
  WHERE registration_number_hash IS NOT NULL;

CREATE TABLE account_business_units (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_unit_id uuid NOT NULL,
  account_id uuid NOT NULL,
  relationship_type text NOT NULL DEFAULT 'CUSTOMER',
  purpose text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE',
  first_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  version bigint NOT NULL DEFAULT 1,
  CONSTRAINT account_business_units_business_unit_fk FOREIGN KEY (organization_id, business_unit_id)
    REFERENCES business_units (organization_id, id),
  CONSTRAINT account_business_units_account_fk FOREIGN KEY (organization_id, account_id)
    REFERENCES accounts (organization_id, id),
  CONSTRAINT account_business_units_purpose_nonempty CHECK (btrim(purpose) <> ''),
  CONSTRAINT account_business_units_status_valid CHECK (status IN ('ACTIVE', 'INACTIVE', 'RESTRICTED')),
  CONSTRAINT account_business_units_seen_order CHECK (last_seen_at >= first_seen_at),
  CONSTRAINT account_business_units_version_positive CHECK (version >= 1),
  CONSTRAINT account_business_units_unique UNIQUE (organization_id, business_unit_id, account_id, relationship_type),
  CONSTRAINT account_business_units_tenant_key UNIQUE (organization_id, business_unit_id, id)
);

CREATE TABLE contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  display_name text NOT NULL,
  given_name text,
  family_name text,
  preferred_name text,
  locale text,
  status text NOT NULL DEFAULT 'ACTIVE',
  merged_into_contact_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT contacts_organization_fk FOREIGN KEY (organization_id)
    REFERENCES organizations (id),
  CONSTRAINT contacts_merged_into_fk FOREIGN KEY (organization_id, merged_into_contact_id)
    REFERENCES contacts (organization_id, id),
  CONSTRAINT contacts_display_name_nonempty CHECK (btrim(display_name) <> ''),
  CONSTRAINT contacts_status_valid CHECK (status IN ('ACTIVE', 'INACTIVE', 'POSSIBLE_DUPLICATE', 'MERGED', 'ANONYMIZED')),
  CONSTRAINT contacts_merge_consistency CHECK (
    (status = 'MERGED' AND merged_into_contact_id IS NOT NULL) OR
    (status <> 'MERGED' AND merged_into_contact_id IS NULL)
  ),
  CONSTRAINT contacts_not_self_merged CHECK (merged_into_contact_id IS NULL OR merged_into_contact_id <> id),
  CONSTRAINT contacts_metadata_object CHECK (jsonb_typeof(metadata) = 'object'),
  CONSTRAINT contacts_version_positive CHECK (version >= 1),
  CONSTRAINT contacts_tenant_key UNIQUE (organization_id, id)
);

CREATE INDEX contacts_organization_status_idx ON contacts (organization_id, status);

CREATE TABLE contact_business_units (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_unit_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  relationship_type text NOT NULL DEFAULT 'CUSTOMER',
  purpose text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE',
  first_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  version bigint NOT NULL DEFAULT 1,
  CONSTRAINT contact_business_units_business_unit_fk FOREIGN KEY (organization_id, business_unit_id)
    REFERENCES business_units (organization_id, id),
  CONSTRAINT contact_business_units_contact_fk FOREIGN KEY (organization_id, contact_id)
    REFERENCES contacts (organization_id, id),
  CONSTRAINT contact_business_units_purpose_nonempty CHECK (btrim(purpose) <> ''),
  CONSTRAINT contact_business_units_status_valid CHECK (status IN ('ACTIVE', 'INACTIVE', 'RESTRICTED')),
  CONSTRAINT contact_business_units_seen_order CHECK (last_seen_at >= first_seen_at),
  CONSTRAINT contact_business_units_version_positive CHECK (version >= 1),
  CONSTRAINT contact_business_units_unique UNIQUE (organization_id, business_unit_id, contact_id, relationship_type),
  CONSTRAINT contact_business_units_tenant_key UNIQUE (organization_id, business_unit_id, id)
);

CREATE INDEX contact_business_units_contact_idx
  ON contact_business_units (organization_id, contact_id, status);

CREATE TABLE contact_identifiers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  identifier_type text NOT NULL,
  normalized_value text,
  value_hash bytea NOT NULL,
  protected_value_ref text,
  verification_status text NOT NULL DEFAULT 'UNVERIFIED',
  verified_at timestamptz,
  is_primary boolean NOT NULL DEFAULT false,
  source text NOT NULL,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT contact_identifiers_contact_fk FOREIGN KEY (organization_id, contact_id)
    REFERENCES contacts (organization_id, id),
  CONSTRAINT contact_identifiers_type_valid CHECK (identifier_type IN ('PHONE', 'EMAIL', 'PROVIDER', 'NATIONAL_ID', 'OTHER')),
  CONSTRAINT contact_identifiers_value_present CHECK (
    normalized_value IS NOT NULL OR protected_value_ref IS NOT NULL
  ),
  CONSTRAINT contact_identifiers_verification_valid CHECK (
    verification_status IN ('UNVERIFIED', 'PENDING', 'VERIFIED', 'FAILED', 'REVOKED')
  ),
  CONSTRAINT contact_identifiers_verified_consistency CHECK (
    (verification_status = 'VERIFIED' AND verified_at IS NOT NULL) OR
    verification_status <> 'VERIFIED'
  ),
  CONSTRAINT contact_identifiers_source_nonempty CHECK (btrim(source) <> ''),
  CONSTRAINT contact_identifiers_version_positive CHECK (version >= 1),
  CONSTRAINT contact_identifiers_duplicate UNIQUE (organization_id, contact_id, identifier_type, value_hash),
  CONSTRAINT contact_identifiers_tenant_key UNIQUE (organization_id, id),
  CONSTRAINT contact_identifiers_contact_key UNIQUE (organization_id, contact_id, id)
);

CREATE INDEX contact_identifiers_match_idx
  ON contact_identifiers (organization_id, identifier_type, value_hash);

CREATE UNIQUE INDEX contact_identifiers_primary_unique
  ON contact_identifiers (organization_id, contact_id, identifier_type)
  WHERE is_primary AND verification_status <> 'REVOKED';

CREATE TABLE consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_unit_id uuid,
  contact_id uuid NOT NULL,
  channel text NOT NULL,
  purpose text NOT NULL,
  decision text NOT NULL,
  legal_basis text NOT NULL,
  notice_version text,
  evidence_ref text,
  source text NOT NULL,
  actor_user_id uuid,
  supersedes_consent_id uuid,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  correlation_id uuid,
  CONSTRAINT consents_business_unit_fk FOREIGN KEY (organization_id, business_unit_id)
    REFERENCES business_units (organization_id, id),
  CONSTRAINT consents_contact_fk FOREIGN KEY (organization_id, contact_id)
    REFERENCES contacts (organization_id, id),
  CONSTRAINT consents_actor_fk FOREIGN KEY (actor_user_id)
    REFERENCES users (id),
  CONSTRAINT consents_supersedes_fk FOREIGN KEY (organization_id, contact_id, supersedes_consent_id)
    REFERENCES consents (organization_id, contact_id, id),
  CONSTRAINT consents_channel_valid CHECK (channel IN ('WHATSAPP', 'SMS', 'EMAIL', 'PHONE', 'PUSH', 'ALL')),
  CONSTRAINT consents_purpose_nonempty CHECK (btrim(purpose) <> ''),
  CONSTRAINT consents_decision_valid CHECK (decision IN ('GRANTED', 'WITHDRAWN', 'DENIED', 'UNKNOWN')),
  CONSTRAINT consents_legal_basis_nonempty CHECK (btrim(legal_basis) <> ''),
  CONSTRAINT consents_source_nonempty CHECK (btrim(source) <> ''),
  CONSTRAINT consents_not_self_superseding CHECK (supersedes_consent_id IS NULL OR supersedes_consent_id <> id),
  CONSTRAINT consents_tenant_key UNIQUE (organization_id, id),
  CONSTRAINT consents_contact_key UNIQUE (organization_id, contact_id, id)
);

CREATE INDEX consents_current_lookup_idx
  ON consents (organization_id, contact_id, business_unit_id, channel, purpose, occurred_at DESC);

-- ---------------------------------------------------------------------------
-- Pipeline, leads, opportunities, and work
-- ---------------------------------------------------------------------------

CREATE TABLE pipelines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_unit_id uuid NOT NULL,
  entity_type text NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE',
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT pipelines_business_unit_fk FOREIGN KEY (organization_id, business_unit_id)
    REFERENCES business_units (organization_id, id),
  CONSTRAINT pipelines_entity_type_valid CHECK (entity_type IN ('LEAD', 'OPPORTUNITY')),
  CONSTRAINT pipelines_code_format CHECK (code ~ '^[a-z][a-z0-9-]{1,62}$'),
  CONSTRAINT pipelines_name_nonempty CHECK (btrim(name) <> ''),
  CONSTRAINT pipelines_status_valid CHECK (status IN ('ACTIVE', 'DISABLED')),
  CONSTRAINT pipelines_version_positive CHECK (version >= 1),
  CONSTRAINT pipelines_code_unique UNIQUE (organization_id, business_unit_id, entity_type, code),
  CONSTRAINT pipelines_tenant_key UNIQUE (organization_id, business_unit_id, id)
);

CREATE UNIQUE INDEX pipelines_one_active_entity_per_bu
  ON pipelines (organization_id, business_unit_id, entity_type)
  WHERE status = 'ACTIVE';

CREATE TABLE pipeline_stages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_unit_id uuid NOT NULL,
  pipeline_id uuid NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  category text NOT NULL,
  position integer NOT NULL,
  probability numeric(5,2),
  is_terminal boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'ACTIVE',
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT pipeline_stages_pipeline_fk FOREIGN KEY (organization_id, business_unit_id, pipeline_id)
    REFERENCES pipelines (organization_id, business_unit_id, id),
  CONSTRAINT pipeline_stages_code_format CHECK (code ~ '^[a-z][a-z0-9-]{1,62}$'),
  CONSTRAINT pipeline_stages_name_nonempty CHECK (btrim(name) <> ''),
  CONSTRAINT pipeline_stages_category_valid CHECK (
    category IN ('OPEN', 'CONVERTED', 'WON', 'LOST', 'DISQUALIFIED', 'ON_HOLD')
  ),
  CONSTRAINT pipeline_stages_position_nonnegative CHECK (position >= 0),
  CONSTRAINT pipeline_stages_probability_valid CHECK (probability IS NULL OR probability BETWEEN 0 AND 100),
  CONSTRAINT pipeline_stages_terminal_consistency CHECK (
    is_terminal = (category IN ('CONVERTED', 'WON', 'LOST', 'DISQUALIFIED'))
  ),
  CONSTRAINT pipeline_stages_status_valid CHECK (status IN ('ACTIVE', 'DISABLED')),
  CONSTRAINT pipeline_stages_version_positive CHECK (version >= 1),
  CONSTRAINT pipeline_stages_code_unique UNIQUE (organization_id, business_unit_id, pipeline_id, code),
  CONSTRAINT pipeline_stages_position_unique UNIQUE (organization_id, business_unit_id, pipeline_id, position),
  CONSTRAINT pipeline_stages_tenant_key UNIQUE (organization_id, business_unit_id, id),
  CONSTRAINT pipeline_stages_pipeline_key UNIQUE (organization_id, business_unit_id, pipeline_id, id)
);

CREATE TABLE pipeline_stage_transitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_unit_id uuid NOT NULL,
  pipeline_id uuid NOT NULL,
  from_stage_id uuid NOT NULL,
  to_stage_id uuid NOT NULL,
  requires_reason boolean NOT NULL DEFAULT false,
  required_capability text,
  status text NOT NULL DEFAULT 'ACTIVE',
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT pipeline_stage_transitions_from_fk FOREIGN KEY (
    organization_id, business_unit_id, pipeline_id, from_stage_id
  ) REFERENCES pipeline_stages (organization_id, business_unit_id, pipeline_id, id),
  CONSTRAINT pipeline_stage_transitions_to_fk FOREIGN KEY (
    organization_id, business_unit_id, pipeline_id, to_stage_id
  ) REFERENCES pipeline_stages (organization_id, business_unit_id, pipeline_id, id),
  CONSTRAINT pipeline_stage_transitions_change CHECK (from_stage_id <> to_stage_id),
  CONSTRAINT pipeline_stage_transitions_capability_nonempty CHECK (
    required_capability IS NULL OR btrim(required_capability) <> ''
  ),
  CONSTRAINT pipeline_stage_transitions_status_valid CHECK (status IN ('ACTIVE', 'DISABLED')),
  CONSTRAINT pipeline_stage_transitions_version_positive CHECK (version >= 1),
  CONSTRAINT pipeline_stage_transitions_edge_unique UNIQUE (
    organization_id, business_unit_id, pipeline_id, from_stage_id, to_stage_id
  ),
  CONSTRAINT pipeline_stage_transitions_tenant_key UNIQUE (organization_id, business_unit_id, id)
);

CREATE INDEX pipeline_stage_transitions_from_idx
  ON pipeline_stage_transitions (
    organization_id, business_unit_id, pipeline_id, from_stage_id, status
  );

CREATE TABLE leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_unit_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  account_id uuid,
  pipeline_id uuid NOT NULL,
  stage_id uuid NOT NULL,
  owner_membership_id uuid,
  assigned_by_membership_id uuid,
  title text NOT NULL,
  source_provider text NOT NULL,
  source_channel text,
  external_lead_id text,
  duplicate_fingerprint bytea,
  provider_occurred_at timestamptz,
  received_at timestamptz NOT NULL,
  ingested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  assigned_at timestamptz,
  assignment_locked boolean NOT NULL DEFAULT false,
  attribution jsonb NOT NULL DEFAULT '{}'::jsonb,
  legacy_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT leads_business_unit_fk FOREIGN KEY (organization_id, business_unit_id)
    REFERENCES business_units (organization_id, id),
  CONSTRAINT leads_contact_fk FOREIGN KEY (organization_id, contact_id)
    REFERENCES contacts (organization_id, id),
  CONSTRAINT leads_account_fk FOREIGN KEY (organization_id, account_id)
    REFERENCES accounts (organization_id, id),
  CONSTRAINT leads_stage_fk FOREIGN KEY (organization_id, business_unit_id, pipeline_id, stage_id)
    REFERENCES pipeline_stages (organization_id, business_unit_id, pipeline_id, id),
  CONSTRAINT leads_owner_fk FOREIGN KEY (organization_id, business_unit_id, owner_membership_id)
    REFERENCES memberships (organization_id, business_unit_id, id),
  CONSTRAINT leads_assigner_fk FOREIGN KEY (organization_id, assigned_by_membership_id)
    REFERENCES memberships (organization_id, id),
  CONSTRAINT leads_title_nonempty CHECK (btrim(title) <> ''),
  CONSTRAINT leads_source_provider_format CHECK (
    source_provider ~ '^[a-z][a-z0-9._-]{1,79}$'
  ),
  CONSTRAINT leads_time_order CHECK (
    provider_occurred_at IS NULL OR received_at >= provider_occurred_at
  ),
  CONSTRAINT leads_ingest_order CHECK (ingested_at >= received_at),
  CONSTRAINT leads_assignment_consistency CHECK (
    (
      owner_membership_id IS NULL AND
      assigned_by_membership_id IS NULL AND
      assigned_at IS NULL
    ) OR (
      owner_membership_id IS NOT NULL AND
      assigned_by_membership_id IS NOT NULL AND
      assigned_at IS NOT NULL
    )
  ),
  CONSTRAINT leads_attribution_object CHECK (jsonb_typeof(attribution) = 'object'),
  CONSTRAINT leads_legacy_object CHECK (jsonb_typeof(legacy_data) = 'object'),
  CONSTRAINT leads_version_positive CHECK (version >= 1),
  CONSTRAINT leads_tenant_key UNIQUE (organization_id, business_unit_id, id)
);

CREATE UNIQUE INDEX leads_provider_external_unique
  ON leads (organization_id, business_unit_id, source_provider, external_lead_id)
  WHERE external_lead_id IS NOT NULL;

CREATE INDEX leads_stage_owner_queue_idx
  ON leads (organization_id, business_unit_id, stage_id, owner_membership_id, received_at DESC);
CREATE INDEX leads_contact_time_idx
  ON leads (organization_id, contact_id, received_at DESC);
CREATE INDEX leads_duplicate_fingerprint_idx
  ON leads (organization_id, business_unit_id, duplicate_fingerprint)
  WHERE duplicate_fingerprint IS NOT NULL;

CREATE TABLE lead_stage_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_unit_id uuid NOT NULL,
  lead_id uuid NOT NULL,
  from_stage_id uuid,
  to_stage_id uuid NOT NULL,
  actor_user_id uuid,
  transition_source text NOT NULL,
  reason text,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  correlation_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT lead_stage_history_lead_fk FOREIGN KEY (organization_id, business_unit_id, lead_id)
    REFERENCES leads (organization_id, business_unit_id, id),
  CONSTRAINT lead_stage_history_from_stage_fk FOREIGN KEY (organization_id, business_unit_id, from_stage_id)
    REFERENCES pipeline_stages (organization_id, business_unit_id, id),
  CONSTRAINT lead_stage_history_to_stage_fk FOREIGN KEY (organization_id, business_unit_id, to_stage_id)
    REFERENCES pipeline_stages (organization_id, business_unit_id, id),
  CONSTRAINT lead_stage_history_actor_fk FOREIGN KEY (actor_user_id)
    REFERENCES users (id),
  CONSTRAINT lead_stage_history_source_nonempty CHECK (btrim(transition_source) <> ''),
  CONSTRAINT lead_stage_history_change CHECK (from_stage_id IS NULL OR from_stage_id <> to_stage_id)
);

CREATE INDEX lead_stage_history_lead_time_idx
  ON lead_stage_history (organization_id, business_unit_id, lead_id, occurred_at);

CREATE TABLE opportunities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_unit_id uuid NOT NULL,
  lead_id uuid,
  contact_id uuid NOT NULL,
  account_id uuid,
  pipeline_id uuid NOT NULL,
  stage_id uuid NOT NULL,
  owner_membership_id uuid,
  name text NOT NULL,
  expected_amount numeric(19,4),
  currency char(3) NOT NULL DEFAULT 'MYR',
  probability numeric(5,2),
  expected_close_date date,
  won_at timestamptz,
  lost_at timestamptz,
  loss_reason text,
  legacy_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT opportunities_business_unit_fk FOREIGN KEY (organization_id, business_unit_id)
    REFERENCES business_units (organization_id, id),
  CONSTRAINT opportunities_lead_fk FOREIGN KEY (organization_id, business_unit_id, lead_id)
    REFERENCES leads (organization_id, business_unit_id, id),
  CONSTRAINT opportunities_contact_fk FOREIGN KEY (organization_id, contact_id)
    REFERENCES contacts (organization_id, id),
  CONSTRAINT opportunities_account_fk FOREIGN KEY (organization_id, account_id)
    REFERENCES accounts (organization_id, id),
  CONSTRAINT opportunities_stage_fk FOREIGN KEY (organization_id, business_unit_id, pipeline_id, stage_id)
    REFERENCES pipeline_stages (organization_id, business_unit_id, pipeline_id, id),
  CONSTRAINT opportunities_owner_fk FOREIGN KEY (organization_id, business_unit_id, owner_membership_id)
    REFERENCES memberships (organization_id, business_unit_id, id),
  CONSTRAINT opportunities_name_nonempty CHECK (btrim(name) <> ''),
  CONSTRAINT opportunities_amount_nonnegative CHECK (expected_amount IS NULL OR expected_amount >= 0),
  CONSTRAINT opportunities_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT opportunities_probability_valid CHECK (probability IS NULL OR probability BETWEEN 0 AND 100),
  CONSTRAINT opportunities_outcome_exclusive CHECK (won_at IS NULL OR lost_at IS NULL),
  CONSTRAINT opportunities_loss_reason_required CHECK (lost_at IS NULL OR btrim(COALESCE(loss_reason, '')) <> ''),
  CONSTRAINT opportunities_legacy_object CHECK (jsonb_typeof(legacy_data) = 'object'),
  CONSTRAINT opportunities_version_positive CHECK (version >= 1),
  CONSTRAINT opportunities_tenant_key UNIQUE (organization_id, business_unit_id, id)
);

CREATE UNIQUE INDEX opportunities_lead_unique
  ON opportunities (organization_id, business_unit_id, lead_id)
  WHERE lead_id IS NOT NULL;

CREATE INDEX opportunities_stage_owner_idx
  ON opportunities (organization_id, business_unit_id, stage_id, owner_membership_id, expected_close_date);
CREATE INDEX opportunities_contact_idx
  ON opportunities (organization_id, contact_id, created_at DESC);

CREATE TABLE opportunity_stage_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_unit_id uuid NOT NULL,
  opportunity_id uuid NOT NULL,
  from_stage_id uuid,
  to_stage_id uuid NOT NULL,
  actor_user_id uuid,
  transition_source text NOT NULL,
  reason text,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  correlation_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT opportunity_stage_history_opportunity_fk FOREIGN KEY (organization_id, business_unit_id, opportunity_id)
    REFERENCES opportunities (organization_id, business_unit_id, id),
  CONSTRAINT opportunity_stage_history_from_stage_fk FOREIGN KEY (organization_id, business_unit_id, from_stage_id)
    REFERENCES pipeline_stages (organization_id, business_unit_id, id),
  CONSTRAINT opportunity_stage_history_to_stage_fk FOREIGN KEY (organization_id, business_unit_id, to_stage_id)
    REFERENCES pipeline_stages (organization_id, business_unit_id, id),
  CONSTRAINT opportunity_stage_history_actor_fk FOREIGN KEY (actor_user_id)
    REFERENCES users (id),
  CONSTRAINT opportunity_stage_history_source_nonempty CHECK (btrim(transition_source) <> ''),
  CONSTRAINT opportunity_stage_history_change CHECK (from_stage_id IS NULL OR from_stage_id <> to_stage_id)
);

CREATE INDEX opportunity_stage_history_opportunity_time_idx
  ON opportunity_stage_history (organization_id, business_unit_id, opportunity_id, occurred_at);

CREATE TABLE tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_unit_id uuid NOT NULL,
  contact_id uuid,
  lead_id uuid,
  opportunity_id uuid,
  assigned_membership_id uuid,
  assigned_team_id uuid,
  task_type text NOT NULL,
  subject text NOT NULL,
  description text,
  priority text NOT NULL DEFAULT 'NORMAL',
  status text NOT NULL DEFAULT 'OPEN',
  due_at timestamptz,
  reminder_at timestamptz,
  completed_at timestamptz,
  completed_by_user_id uuid,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT tasks_business_unit_fk FOREIGN KEY (organization_id, business_unit_id)
    REFERENCES business_units (organization_id, id),
  CONSTRAINT tasks_contact_fk FOREIGN KEY (organization_id, contact_id)
    REFERENCES contacts (organization_id, id),
  CONSTRAINT tasks_lead_fk FOREIGN KEY (organization_id, business_unit_id, lead_id)
    REFERENCES leads (organization_id, business_unit_id, id),
  CONSTRAINT tasks_opportunity_fk FOREIGN KEY (organization_id, business_unit_id, opportunity_id)
    REFERENCES opportunities (organization_id, business_unit_id, id),
  CONSTRAINT tasks_assignee_fk FOREIGN KEY (organization_id, business_unit_id, assigned_membership_id)
    REFERENCES memberships (organization_id, business_unit_id, id),
  CONSTRAINT tasks_team_fk FOREIGN KEY (organization_id, business_unit_id, assigned_team_id)
    REFERENCES teams (organization_id, business_unit_id, id),
  CONSTRAINT tasks_completed_by_fk FOREIGN KEY (completed_by_user_id)
    REFERENCES users (id),
  CONSTRAINT tasks_one_parent CHECK (num_nonnulls(contact_id, lead_id, opportunity_id) = 1),
  CONSTRAINT tasks_one_assignee CHECK (num_nonnulls(assigned_membership_id, assigned_team_id) <= 1),
  CONSTRAINT tasks_type_nonempty CHECK (btrim(task_type) <> ''),
  CONSTRAINT tasks_subject_nonempty CHECK (btrim(subject) <> ''),
  CONSTRAINT tasks_priority_valid CHECK (priority IN ('LOW', 'NORMAL', 'HIGH', 'URGENT')),
  CONSTRAINT tasks_status_valid CHECK (status IN ('OPEN', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED')),
  CONSTRAINT tasks_completion_consistency CHECK (
    (status = 'COMPLETED' AND completed_at IS NOT NULL) OR status <> 'COMPLETED'
  ),
  CONSTRAINT tasks_reminder_order CHECK (reminder_at IS NULL OR due_at IS NULL OR reminder_at <= due_at),
  CONSTRAINT tasks_version_positive CHECK (version >= 1),
  CONSTRAINT tasks_tenant_key UNIQUE (organization_id, business_unit_id, id)
);

CREATE INDEX tasks_membership_queue_idx
  ON tasks (organization_id, business_unit_id, assigned_membership_id, status, due_at)
  WHERE status IN ('OPEN', 'IN_PROGRESS');
CREATE INDEX tasks_team_queue_idx
  ON tasks (organization_id, business_unit_id, assigned_team_id, status, due_at)
  WHERE status IN ('OPEN', 'IN_PROGRESS');

-- ---------------------------------------------------------------------------
-- Salam Land inventory, holds, and reservations
-- ---------------------------------------------------------------------------

CREATE TABLE land_projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_unit_id uuid NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  location_text text,
  status text NOT NULL DEFAULT 'ACTIVE',
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT land_projects_business_unit_fk FOREIGN KEY (organization_id, business_unit_id)
    REFERENCES business_units (organization_id, id),
  CONSTRAINT land_projects_code_format CHECK (code ~ '^[a-z][a-z0-9-]{1,62}$'),
  CONSTRAINT land_projects_name_nonempty CHECK (btrim(name) <> ''),
  CONSTRAINT land_projects_status_valid CHECK (status IN ('ACTIVE', 'INACTIVE', 'COMPLETED')),
  CONSTRAINT land_projects_version_positive CHECK (version >= 1),
  CONSTRAINT land_projects_code_unique UNIQUE (organization_id, business_unit_id, code),
  CONSTRAINT land_projects_tenant_key UNIQUE (organization_id, business_unit_id, id)
);

CREATE TABLE lots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_unit_id uuid NOT NULL,
  project_id uuid NOT NULL,
  lot_number text NOT NULL,
  title_reference text,
  operational_status text NOT NULL DEFAULT 'ACTIVE',
  list_price numeric(19,4),
  currency char(3) NOT NULL DEFAULT 'MYR',
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
  blocked_reason text,
  sold_at timestamptz,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT lots_project_fk FOREIGN KEY (organization_id, business_unit_id, project_id)
    REFERENCES land_projects (organization_id, business_unit_id, id),
  CONSTRAINT lots_number_nonempty CHECK (btrim(lot_number) <> ''),
  CONSTRAINT lots_status_valid CHECK (operational_status IN ('ACTIVE', 'BLOCKED', 'WITHDRAWN', 'SOLD')),
  CONSTRAINT lots_price_nonnegative CHECK (list_price IS NULL OR list_price >= 0),
  CONSTRAINT lots_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT lots_attributes_object CHECK (jsonb_typeof(attributes) = 'object'),
  CONSTRAINT lots_blocked_reason_required CHECK (
    operational_status <> 'BLOCKED' OR btrim(COALESCE(blocked_reason, '')) <> ''
  ),
  CONSTRAINT lots_sold_time_consistency CHECK (
    (operational_status = 'SOLD' AND sold_at IS NOT NULL) OR
    (operational_status <> 'SOLD' AND sold_at IS NULL)
  ),
  CONSTRAINT lots_version_positive CHECK (version >= 1),
  CONSTRAINT lots_project_number_unique UNIQUE (organization_id, business_unit_id, project_id, lot_number),
  CONSTRAINT lots_tenant_key UNIQUE (organization_id, business_unit_id, id)
);

CREATE INDEX lots_status_project_idx
  ON lots (organization_id, business_unit_id, operational_status, project_id, lot_number);

CREATE TABLE lot_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_unit_id uuid NOT NULL,
  lot_id uuid NOT NULL,
  allocation_kind text NOT NULL,
  allocated_by_user_id uuid,
  allocated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  released_at timestamptz,
  release_reason text,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT lot_allocations_lot_fk FOREIGN KEY (organization_id, business_unit_id, lot_id)
    REFERENCES lots (organization_id, business_unit_id, id),
  CONSTRAINT lot_allocations_actor_fk FOREIGN KEY (allocated_by_user_id)
    REFERENCES users (id),
  CONSTRAINT lot_allocations_kind_valid CHECK (allocation_kind IN ('HOLD', 'RESERVATION')),
  CONSTRAINT lot_allocations_release_order CHECK (released_at IS NULL OR released_at >= allocated_at),
  CONSTRAINT lot_allocations_release_reason_required CHECK (
    released_at IS NULL OR btrim(COALESCE(release_reason, '')) <> ''
  ),
  CONSTRAINT lot_allocations_version_positive CHECK (version >= 1),
  CONSTRAINT lot_allocations_tenant_key UNIQUE (organization_id, business_unit_id, id)
);

CREATE UNIQUE INDEX lot_allocations_one_active_per_lot
  ON lot_allocations (organization_id, business_unit_id, lot_id)
  WHERE released_at IS NULL;

CREATE INDEX lot_allocations_lot_history_idx
  ON lot_allocations (organization_id, business_unit_id, lot_id, allocated_at DESC);

CREATE TABLE lot_holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_unit_id uuid NOT NULL,
  allocation_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  opportunity_id uuid,
  status text NOT NULL DEFAULT 'ACTIVE',
  expires_at timestamptz NOT NULL,
  extended_count integer NOT NULL DEFAULT 0,
  converted_at timestamptz,
  released_at timestamptz,
  reason text,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT lot_holds_allocation_fk FOREIGN KEY (organization_id, business_unit_id, allocation_id)
    REFERENCES lot_allocations (organization_id, business_unit_id, id),
  CONSTRAINT lot_holds_contact_fk FOREIGN KEY (organization_id, contact_id)
    REFERENCES contacts (organization_id, id),
  CONSTRAINT lot_holds_opportunity_fk FOREIGN KEY (organization_id, business_unit_id, opportunity_id)
    REFERENCES opportunities (organization_id, business_unit_id, id),
  CONSTRAINT lot_holds_status_valid CHECK (status IN ('ACTIVE', 'EXPIRED', 'RELEASED', 'CONVERTED')),
  CONSTRAINT lot_holds_expiry_after_create CHECK (expires_at > created_at),
  CONSTRAINT lot_holds_extended_nonnegative CHECK (extended_count >= 0),
  CONSTRAINT lot_holds_terminal_time CHECK (
    (status = 'CONVERTED' AND converted_at IS NOT NULL) OR
    (status IN ('EXPIRED', 'RELEASED') AND released_at IS NOT NULL) OR
    status = 'ACTIVE'
  ),
  CONSTRAINT lot_holds_version_positive CHECK (version >= 1),
  CONSTRAINT lot_holds_allocation_unique UNIQUE (organization_id, business_unit_id, allocation_id),
  CONSTRAINT lot_holds_tenant_key UNIQUE (organization_id, business_unit_id, id)
);

CREATE INDEX lot_holds_expiry_idx
  ON lot_holds (organization_id, business_unit_id, expires_at)
  WHERE status = 'ACTIVE';

CREATE TABLE reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_unit_id uuid NOT NULL,
  allocation_id uuid NOT NULL,
  originating_hold_id uuid,
  contact_id uuid NOT NULL,
  opportunity_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'PENDING',
  reserved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  confirmed_at timestamptz,
  converted_at timestamptz,
  cancelled_at timestamptz,
  cancellation_reason text,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT reservations_allocation_fk FOREIGN KEY (organization_id, business_unit_id, allocation_id)
    REFERENCES lot_allocations (organization_id, business_unit_id, id),
  CONSTRAINT reservations_hold_fk FOREIGN KEY (organization_id, business_unit_id, originating_hold_id)
    REFERENCES lot_holds (organization_id, business_unit_id, id),
  CONSTRAINT reservations_contact_fk FOREIGN KEY (organization_id, contact_id)
    REFERENCES contacts (organization_id, id),
  CONSTRAINT reservations_opportunity_fk FOREIGN KEY (organization_id, business_unit_id, opportunity_id)
    REFERENCES opportunities (organization_id, business_unit_id, id),
  CONSTRAINT reservations_status_valid CHECK (status IN ('PENDING', 'CONFIRMED', 'CONVERTED_TO_SALE', 'CANCELLED')),
  CONSTRAINT reservations_status_time CHECK (
    (status = 'CONFIRMED' AND confirmed_at IS NOT NULL) OR
    (status = 'CONVERTED_TO_SALE' AND converted_at IS NOT NULL) OR
    (status = 'CANCELLED' AND cancelled_at IS NOT NULL AND btrim(COALESCE(cancellation_reason, '')) <> '') OR
    status = 'PENDING'
  ),
  CONSTRAINT reservations_version_positive CHECK (version >= 1),
  CONSTRAINT reservations_allocation_unique UNIQUE (organization_id, business_unit_id, allocation_id),
  CONSTRAINT reservations_tenant_key UNIQUE (organization_id, business_unit_id, id)
);

CREATE INDEX reservations_opportunity_idx
  ON reservations (organization_id, business_unit_id, opportunity_id, status);

-- ---------------------------------------------------------------------------
-- Orders, invoices, installments, payments, allocations, and refunds
-- ---------------------------------------------------------------------------

CREATE TABLE orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_unit_id uuid NOT NULL,
  order_number text NOT NULL,
  contact_id uuid NOT NULL,
  account_id uuid,
  opportunity_id uuid,
  reservation_id uuid,
  direct_sale_reason text,
  status text NOT NULL DEFAULT 'DRAFT',
  currency char(3) NOT NULL DEFAULT 'MYR',
  subtotal_amount numeric(19,4) NOT NULL DEFAULT 0,
  discount_amount numeric(19,4) NOT NULL DEFAULT 0,
  tax_amount numeric(19,4) NOT NULL DEFAULT 0,
  total_amount numeric(19,4) NOT NULL DEFAULT 0,
  approved_at timestamptz,
  approved_by_user_id uuid,
  cancelled_at timestamptz,
  cancellation_reason text,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT orders_business_unit_fk FOREIGN KEY (organization_id, business_unit_id)
    REFERENCES business_units (organization_id, id),
  CONSTRAINT orders_contact_fk FOREIGN KEY (organization_id, contact_id)
    REFERENCES contacts (organization_id, id),
  CONSTRAINT orders_account_fk FOREIGN KEY (organization_id, account_id)
    REFERENCES accounts (organization_id, id),
  CONSTRAINT orders_opportunity_fk FOREIGN KEY (organization_id, business_unit_id, opportunity_id)
    REFERENCES opportunities (organization_id, business_unit_id, id),
  CONSTRAINT orders_reservation_fk FOREIGN KEY (organization_id, business_unit_id, reservation_id)
    REFERENCES reservations (organization_id, business_unit_id, id),
  CONSTRAINT orders_approver_fk FOREIGN KEY (approved_by_user_id)
    REFERENCES users (id),
  CONSTRAINT orders_number_nonempty CHECK (btrim(order_number) <> ''),
  CONSTRAINT orders_origin_required CHECK (
    opportunity_id IS NOT NULL OR btrim(COALESCE(direct_sale_reason, '')) <> ''
  ),
  CONSTRAINT orders_status_valid CHECK (status IN ('DRAFT', 'SUBMITTED', 'APPROVED', 'IN_FULFILMENT', 'COMPLETED', 'CANCELLED')),
  CONSTRAINT orders_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT orders_amounts_nonnegative CHECK (
    subtotal_amount >= 0 AND discount_amount >= 0 AND tax_amount >= 0 AND total_amount >= 0
  ),
  CONSTRAINT orders_total_math CHECK (
    total_amount = subtotal_amount + tax_amount - discount_amount
  ),
  CONSTRAINT orders_approval_consistency CHECK (
    status NOT IN ('APPROVED', 'IN_FULFILMENT', 'COMPLETED') OR
    (approved_at IS NOT NULL AND approved_by_user_id IS NOT NULL)
  ),
  CONSTRAINT orders_cancellation_consistency CHECK (
    status <> 'CANCELLED' OR
    (cancelled_at IS NOT NULL AND btrim(COALESCE(cancellation_reason, '')) <> '')
  ),
  CONSTRAINT orders_version_positive CHECK (version >= 1),
  CONSTRAINT orders_number_unique UNIQUE (organization_id, business_unit_id, order_number),
  CONSTRAINT orders_reservation_unique UNIQUE (organization_id, business_unit_id, reservation_id),
  CONSTRAINT orders_tenant_key UNIQUE (organization_id, business_unit_id, id)
);

CREATE INDEX orders_contact_time_idx
  ON orders (organization_id, contact_id, created_at DESC);
CREATE INDEX orders_status_time_idx
  ON orders (organization_id, business_unit_id, status, created_at DESC);

CREATE TABLE order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_unit_id uuid NOT NULL,
  order_id uuid NOT NULL,
  line_number integer NOT NULL,
  item_type text NOT NULL DEFAULT 'PRODUCT',
  product_code text,
  description text NOT NULL,
  quantity numeric(19,6) NOT NULL,
  unit_price numeric(19,4) NOT NULL,
  discount_amount numeric(19,4) NOT NULL DEFAULT 0,
  tax_amount numeric(19,4) NOT NULL DEFAULT 0,
  total_amount numeric(19,4) NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT order_items_order_fk FOREIGN KEY (organization_id, business_unit_id, order_id)
    REFERENCES orders (organization_id, business_unit_id, id),
  CONSTRAINT order_items_line_positive CHECK (line_number > 0),
  CONSTRAINT order_items_type_valid CHECK (item_type IN ('PRODUCT', 'SERVICE', 'FEE', 'DISCOUNT', 'ADJUSTMENT')),
  CONSTRAINT order_items_description_nonempty CHECK (btrim(description) <> ''),
  CONSTRAINT order_items_quantity_positive CHECK (quantity > 0),
  CONSTRAINT order_items_amounts_nonnegative CHECK (
    unit_price >= 0 AND discount_amount >= 0 AND tax_amount >= 0 AND total_amount >= 0
  ),
  CONSTRAINT order_items_total_math CHECK (
    total_amount = round((quantity * unit_price) + tax_amount - discount_amount, 4)
  ),
  CONSTRAINT order_items_metadata_object CHECK (jsonb_typeof(metadata) = 'object'),
  CONSTRAINT order_items_version_positive CHECK (version >= 1),
  CONSTRAINT order_items_line_unique UNIQUE (organization_id, business_unit_id, order_id, line_number),
  CONSTRAINT order_items_tenant_key UNIQUE (organization_id, business_unit_id, id)
);

CREATE TABLE invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_unit_id uuid NOT NULL,
  order_id uuid NOT NULL,
  invoice_number text NOT NULL,
  status text NOT NULL DEFAULT 'DRAFT',
  currency char(3) NOT NULL DEFAULT 'MYR',
  issue_date date,
  due_date date,
  subtotal_amount numeric(19,4) NOT NULL DEFAULT 0,
  discount_amount numeric(19,4) NOT NULL DEFAULT 0,
  tax_amount numeric(19,4) NOT NULL DEFAULT 0,
  total_amount numeric(19,4) NOT NULL DEFAULT 0,
  issued_at timestamptz,
  voided_at timestamptz,
  void_reason text,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT invoices_order_fk FOREIGN KEY (organization_id, business_unit_id, order_id)
    REFERENCES orders (organization_id, business_unit_id, id),
  CONSTRAINT invoices_number_nonempty CHECK (btrim(invoice_number) <> ''),
  CONSTRAINT invoices_status_valid CHECK (status IN ('DRAFT', 'ISSUED', 'PARTIALLY_PAID', 'PAID', 'VOID')),
  CONSTRAINT invoices_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT invoices_date_order CHECK (due_date IS NULL OR issue_date IS NULL OR due_date >= issue_date),
  CONSTRAINT invoices_amounts_nonnegative CHECK (
    subtotal_amount >= 0 AND discount_amount >= 0 AND tax_amount >= 0 AND total_amount >= 0
  ),
  CONSTRAINT invoices_total_math CHECK (
    total_amount = subtotal_amount + tax_amount - discount_amount
  ),
  CONSTRAINT invoices_issue_consistency CHECK (
    status = 'DRAFT' OR (issue_date IS NOT NULL AND issued_at IS NOT NULL)
  ),
  CONSTRAINT invoices_void_consistency CHECK (
    status <> 'VOID' OR (voided_at IS NOT NULL AND btrim(COALESCE(void_reason, '')) <> '')
  ),
  CONSTRAINT invoices_version_positive CHECK (version >= 1),
  CONSTRAINT invoices_number_unique UNIQUE (organization_id, business_unit_id, invoice_number),
  CONSTRAINT invoices_tenant_key UNIQUE (organization_id, business_unit_id, id)
);

CREATE INDEX invoices_order_idx ON invoices (organization_id, business_unit_id, order_id);
CREATE INDEX invoices_due_status_idx
  ON invoices (organization_id, business_unit_id, status, due_date)
  WHERE status IN ('ISSUED', 'PARTIALLY_PAID');

CREATE TABLE installments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_unit_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  sequence_number integer NOT NULL,
  label text,
  due_date date NOT NULL,
  amount numeric(19,4) NOT NULL,
  status text NOT NULL DEFAULT 'SCHEDULED',
  waived_amount numeric(19,4) NOT NULL DEFAULT 0,
  waived_reason text,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT installments_invoice_fk FOREIGN KEY (organization_id, business_unit_id, invoice_id)
    REFERENCES invoices (organization_id, business_unit_id, id),
  CONSTRAINT installments_sequence_positive CHECK (sequence_number > 0),
  CONSTRAINT installments_amount_positive CHECK (amount > 0),
  CONSTRAINT installments_status_valid CHECK (status IN ('SCHEDULED', 'DUE', 'PARTIALLY_PAID', 'PAID', 'WAIVED', 'CANCELLED')),
  CONSTRAINT installments_waiver_valid CHECK (
    waived_amount >= 0 AND waived_amount <= amount AND
    (waived_amount = 0 OR btrim(COALESCE(waived_reason, '')) <> '')
  ),
  CONSTRAINT installments_version_positive CHECK (version >= 1),
  CONSTRAINT installments_sequence_unique UNIQUE (organization_id, business_unit_id, invoice_id, sequence_number),
  CONSTRAINT installments_tenant_key UNIQUE (organization_id, business_unit_id, id)
);

CREATE INDEX installments_due_status_idx
  ON installments (organization_id, business_unit_id, status, due_date)
  WHERE status IN ('SCHEDULED', 'DUE', 'PARTIALLY_PAID');

CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_unit_id uuid NOT NULL,
  payment_number text NOT NULL,
  contact_id uuid,
  account_id uuid,
  status text NOT NULL DEFAULT 'PENDING',
  method text NOT NULL,
  amount numeric(19,4) NOT NULL,
  currency char(3) NOT NULL DEFAULT 'MYR',
  external_provider text,
  external_reference text,
  idempotency_key text,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  settled_at timestamptz,
  failed_at timestamptz,
  reversed_at timestamptz,
  failure_code text,
  evidence_ref text,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT payments_business_unit_fk FOREIGN KEY (organization_id, business_unit_id)
    REFERENCES business_units (organization_id, id),
  CONSTRAINT payments_contact_fk FOREIGN KEY (organization_id, contact_id)
    REFERENCES contacts (organization_id, id),
  CONSTRAINT payments_account_fk FOREIGN KEY (organization_id, account_id)
    REFERENCES accounts (organization_id, id),
  CONSTRAINT payments_number_nonempty CHECK (btrim(payment_number) <> ''),
  CONSTRAINT payments_payer_required CHECK (num_nonnulls(contact_id, account_id) >= 1),
  CONSTRAINT payments_status_valid CHECK (status IN ('PENDING', 'SETTLED', 'FAILED', 'REVERSED')),
  CONSTRAINT payments_method_nonempty CHECK (btrim(method) <> ''),
  CONSTRAINT payments_amount_positive CHECK (amount > 0),
  CONSTRAINT payments_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT payments_settlement_consistency CHECK (
    status <> 'SETTLED' OR settled_at IS NOT NULL
  ),
  CONSTRAINT payments_failure_consistency CHECK (
    status <> 'FAILED' OR (failed_at IS NOT NULL AND failure_code IS NOT NULL)
  ),
  CONSTRAINT payments_reversal_consistency CHECK (
    status <> 'REVERSED' OR reversed_at IS NOT NULL
  ),
  CONSTRAINT payments_version_positive CHECK (version >= 1),
  CONSTRAINT payments_number_unique UNIQUE (organization_id, business_unit_id, payment_number),
  CONSTRAINT payments_tenant_key UNIQUE (organization_id, business_unit_id, id)
);

CREATE UNIQUE INDEX payments_provider_reference_unique
  ON payments (organization_id, business_unit_id, external_provider, external_reference)
  WHERE external_provider IS NOT NULL AND external_reference IS NOT NULL;

CREATE UNIQUE INDEX payments_idempotency_unique
  ON payments (organization_id, business_unit_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX payments_contact_time_idx
  ON payments (organization_id, contact_id, received_at DESC)
  WHERE contact_id IS NOT NULL;

CREATE TABLE payment_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_unit_id uuid NOT NULL,
  payment_id uuid NOT NULL,
  installment_id uuid NOT NULL,
  allocation_type text NOT NULL DEFAULT 'ALLOCATION',
  reverses_allocation_id uuid,
  amount numeric(19,4) NOT NULL,
  reason text,
  allocated_by_user_id uuid,
  allocated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  correlation_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT payment_allocations_payment_fk FOREIGN KEY (organization_id, business_unit_id, payment_id)
    REFERENCES payments (organization_id, business_unit_id, id),
  CONSTRAINT payment_allocations_installment_fk FOREIGN KEY (organization_id, business_unit_id, installment_id)
    REFERENCES installments (organization_id, business_unit_id, id),
  CONSTRAINT payment_allocations_actor_fk FOREIGN KEY (allocated_by_user_id)
    REFERENCES users (id),
  CONSTRAINT payment_allocations_reversal_fk FOREIGN KEY (
    organization_id, business_unit_id, payment_id, reverses_allocation_id
  ) REFERENCES payment_allocations (organization_id, business_unit_id, payment_id, id),
  CONSTRAINT payment_allocations_type_valid CHECK (allocation_type IN ('ALLOCATION', 'REVERSAL')),
  CONSTRAINT payment_allocations_reversal_consistency CHECK (
    (allocation_type = 'ALLOCATION' AND reverses_allocation_id IS NULL) OR
    (allocation_type = 'REVERSAL' AND reverses_allocation_id IS NOT NULL)
  ),
  CONSTRAINT payment_allocations_amount_positive CHECK (amount > 0),
  CONSTRAINT payment_allocations_tenant_key UNIQUE (organization_id, business_unit_id, id),
  CONSTRAINT payment_allocations_payment_key UNIQUE (organization_id, business_unit_id, payment_id, id)
);

CREATE UNIQUE INDEX payment_allocations_one_reversal
  ON payment_allocations (organization_id, business_unit_id, reverses_allocation_id)
  WHERE allocation_type = 'REVERSAL';

CREATE INDEX payment_allocations_payment_idx
  ON payment_allocations (organization_id, business_unit_id, payment_id, allocated_at);
CREATE INDEX payment_allocations_installment_idx
  ON payment_allocations (organization_id, business_unit_id, installment_id, allocated_at);

CREATE TABLE refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_unit_id uuid NOT NULL,
  payment_id uuid NOT NULL,
  refund_number text NOT NULL,
  status text NOT NULL DEFAULT 'REQUESTED',
  amount numeric(19,4) NOT NULL,
  currency char(3) NOT NULL DEFAULT 'MYR',
  reason text NOT NULL,
  idempotency_key text,
  requested_by_user_id uuid,
  approved_by_user_id uuid,
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  approved_at timestamptz,
  settled_at timestamptz,
  failed_at timestamptz,
  failure_code text,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT refunds_payment_fk FOREIGN KEY (organization_id, business_unit_id, payment_id)
    REFERENCES payments (organization_id, business_unit_id, id),
  CONSTRAINT refunds_requester_fk FOREIGN KEY (requested_by_user_id)
    REFERENCES users (id),
  CONSTRAINT refunds_approver_fk FOREIGN KEY (approved_by_user_id)
    REFERENCES users (id),
  CONSTRAINT refunds_number_nonempty CHECK (btrim(refund_number) <> ''),
  CONSTRAINT refunds_status_valid CHECK (
    status IN ('REQUESTED', 'APPROVED', 'PROCESSING', 'SETTLED', 'FAILED', 'REJECTED', 'CANCELLED')
  ),
  CONSTRAINT refunds_amount_positive CHECK (amount > 0),
  CONSTRAINT refunds_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT refunds_reason_nonempty CHECK (btrim(reason) <> ''),
  CONSTRAINT refunds_approval_consistency CHECK (
    status NOT IN ('APPROVED', 'PROCESSING', 'SETTLED') OR
    (
      requested_by_user_id IS NOT NULL AND
      approved_at IS NOT NULL AND
      approved_by_user_id IS NOT NULL AND
      approved_by_user_id IS DISTINCT FROM requested_by_user_id
    )
  ),
  CONSTRAINT refunds_settlement_consistency CHECK (
    status <> 'SETTLED' OR settled_at IS NOT NULL
  ),
  CONSTRAINT refunds_failure_consistency CHECK (
    status <> 'FAILED' OR (failed_at IS NOT NULL AND failure_code IS NOT NULL)
  ),
  CONSTRAINT refunds_version_positive CHECK (version >= 1),
  CONSTRAINT refunds_number_unique UNIQUE (organization_id, business_unit_id, refund_number),
  CONSTRAINT refunds_tenant_key UNIQUE (organization_id, business_unit_id, id)
);

CREATE UNIQUE INDEX refunds_idempotency_unique
  ON refunds (organization_id, business_unit_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX refunds_payment_status_idx
  ON refunds (organization_id, business_unit_id, payment_id, status);

CREATE TABLE finance_ledger_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_unit_id uuid NOT NULL,
  entry_type text NOT NULL,
  order_id uuid,
  invoice_id uuid,
  payment_id uuid,
  refund_id uuid,
  source_type text NOT NULL,
  source_id uuid NOT NULL,
  amount numeric(19,4) NOT NULL,
  currency char(3) NOT NULL,
  actor_user_id uuid,
  reason text,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  correlation_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT finance_ledger_entries_order_fk FOREIGN KEY (organization_id, business_unit_id, order_id)
    REFERENCES orders (organization_id, business_unit_id, id),
  CONSTRAINT finance_ledger_entries_invoice_fk FOREIGN KEY (organization_id, business_unit_id, invoice_id)
    REFERENCES invoices (organization_id, business_unit_id, id),
  CONSTRAINT finance_ledger_entries_payment_fk FOREIGN KEY (organization_id, business_unit_id, payment_id)
    REFERENCES payments (organization_id, business_unit_id, id),
  CONSTRAINT finance_ledger_entries_refund_fk FOREIGN KEY (organization_id, business_unit_id, refund_id)
    REFERENCES refunds (organization_id, business_unit_id, id),
  CONSTRAINT finance_ledger_entries_actor_fk FOREIGN KEY (actor_user_id)
    REFERENCES users (id),
  CONSTRAINT finance_ledger_entries_type_valid CHECK (
    entry_type IN ('CHARGE', 'PAYMENT', 'ALLOCATION', 'REFUND', 'REVERSAL', 'WAIVER', 'ADJUSTMENT')
  ),
  CONSTRAINT finance_ledger_entries_source_nonempty CHECK (btrim(source_type) <> ''),
  CONSTRAINT finance_ledger_entries_amount_nonzero CHECK (amount <> 0),
  CONSTRAINT finance_ledger_entries_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT finance_ledger_entries_source_unique UNIQUE (organization_id, business_unit_id, source_type, source_id),
  CONSTRAINT finance_ledger_entries_tenant_key UNIQUE (organization_id, business_unit_id, id)
);

CREATE INDEX finance_ledger_entries_order_time_idx
  ON finance_ledger_entries (organization_id, business_unit_id, order_id, occurred_at)
  WHERE order_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Activities and cross-entity timeline links
-- ---------------------------------------------------------------------------

CREATE TABLE activities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_unit_id uuid NOT NULL,
  activity_type text NOT NULL,
  channel text,
  direction text,
  subject text,
  body_text text,
  actor_user_id uuid,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT activities_business_unit_fk FOREIGN KEY (organization_id, business_unit_id)
    REFERENCES business_units (organization_id, id),
  CONSTRAINT activities_actor_fk FOREIGN KEY (actor_user_id)
    REFERENCES users (id),
  CONSTRAINT activities_type_nonempty CHECK (btrim(activity_type) <> ''),
  CONSTRAINT activities_direction_valid CHECK (direction IS NULL OR direction IN ('INBOUND', 'OUTBOUND', 'INTERNAL')),
  CONSTRAINT activities_metadata_object CHECK (jsonb_typeof(metadata) = 'object'),
  CONSTRAINT activities_version_positive CHECK (version >= 1),
  CONSTRAINT activities_tenant_key UNIQUE (organization_id, business_unit_id, id)
);

CREATE INDEX activities_tenant_time_idx
  ON activities (organization_id, business_unit_id, occurred_at DESC);

CREATE TABLE activity_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_unit_id uuid NOT NULL,
  activity_id uuid NOT NULL,
  contact_id uuid,
  account_id uuid,
  lead_id uuid,
  opportunity_id uuid,
  order_id uuid,
  task_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT activity_links_activity_fk FOREIGN KEY (organization_id, business_unit_id, activity_id)
    REFERENCES activities (organization_id, business_unit_id, id) ON DELETE CASCADE,
  CONSTRAINT activity_links_contact_fk FOREIGN KEY (organization_id, contact_id)
    REFERENCES contacts (organization_id, id),
  CONSTRAINT activity_links_account_fk FOREIGN KEY (organization_id, account_id)
    REFERENCES accounts (organization_id, id),
  CONSTRAINT activity_links_lead_fk FOREIGN KEY (organization_id, business_unit_id, lead_id)
    REFERENCES leads (organization_id, business_unit_id, id),
  CONSTRAINT activity_links_opportunity_fk FOREIGN KEY (organization_id, business_unit_id, opportunity_id)
    REFERENCES opportunities (organization_id, business_unit_id, id),
  CONSTRAINT activity_links_order_fk FOREIGN KEY (organization_id, business_unit_id, order_id)
    REFERENCES orders (organization_id, business_unit_id, id),
  CONSTRAINT activity_links_task_fk FOREIGN KEY (organization_id, business_unit_id, task_id)
    REFERENCES tasks (organization_id, business_unit_id, id),
  CONSTRAINT activity_links_one_target CHECK (
    num_nonnulls(contact_id, account_id, lead_id, opportunity_id, order_id, task_id) = 1
  )
);

CREATE UNIQUE INDEX activity_links_contact_unique
  ON activity_links (organization_id, business_unit_id, activity_id, contact_id)
  WHERE contact_id IS NOT NULL;
CREATE UNIQUE INDEX activity_links_account_unique
  ON activity_links (organization_id, business_unit_id, activity_id, account_id)
  WHERE account_id IS NOT NULL;
CREATE UNIQUE INDEX activity_links_lead_unique
  ON activity_links (organization_id, business_unit_id, activity_id, lead_id)
  WHERE lead_id IS NOT NULL;
CREATE UNIQUE INDEX activity_links_opportunity_unique
  ON activity_links (organization_id, business_unit_id, activity_id, opportunity_id)
  WHERE opportunity_id IS NOT NULL;
CREATE UNIQUE INDEX activity_links_order_unique
  ON activity_links (organization_id, business_unit_id, activity_id, order_id)
  WHERE order_id IS NOT NULL;
CREATE UNIQUE INDEX activity_links_task_unique
  ON activity_links (organization_id, business_unit_id, activity_id, task_id)
  WHERE task_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Integration inbox, command idempotency, outbox, and audit
-- ---------------------------------------------------------------------------

CREATE TABLE integration_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_unit_id uuid NOT NULL,
  provider text NOT NULL,
  connection_key text NOT NULL,
  external_account_ref text,
  credential_ref text,
  status text NOT NULL DEFAULT 'DISABLED',
  configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_verified_at timestamptz,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT integration_connections_business_unit_fk FOREIGN KEY (organization_id, business_unit_id)
    REFERENCES business_units (organization_id, id),
  CONSTRAINT integration_connections_provider_nonempty CHECK (btrim(provider) <> ''),
  CONSTRAINT integration_connections_key_nonempty CHECK (btrim(connection_key) <> ''),
  CONSTRAINT integration_connections_status_valid CHECK (status IN ('DISABLED', 'ACTIVE', 'DEGRADED', 'REVOKED')),
  CONSTRAINT integration_connections_configuration_object CHECK (jsonb_typeof(configuration) = 'object'),
  CONSTRAINT integration_connections_version_positive CHECK (version >= 1),
  CONSTRAINT integration_connections_key_unique UNIQUE (
    organization_id, business_unit_id, provider, connection_key
  ),
  CONSTRAINT integration_connections_tenant_key UNIQUE (organization_id, business_unit_id, id)
);

CREATE TABLE webhook_inbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_unit_id uuid NOT NULL,
  integration_connection_id uuid NOT NULL,
  provider text NOT NULL,
  provider_event_id text,
  deduplication_key text,
  signature_verified boolean NOT NULL,
  provider_occurred_at timestamptz,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  payload jsonb NOT NULL,
  payload_sha256 bytea NOT NULL,
  protected_payload_ref text,
  sanitized_headers jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'RECEIVED',
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  locked_at timestamptz,
  locked_by text,
  processed_at timestamptz,
  outcome_ref text,
  error_code text,
  error_detail text,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT webhook_inbox_connection_fk FOREIGN KEY (
    organization_id, business_unit_id, integration_connection_id
  ) REFERENCES integration_connections (organization_id, business_unit_id, id),
  CONSTRAINT webhook_inbox_provider_nonempty CHECK (btrim(provider) <> ''),
  CONSTRAINT webhook_inbox_dedupe_present CHECK (
    provider_event_id IS NOT NULL OR deduplication_key IS NOT NULL
  ),
  CONSTRAINT webhook_inbox_signature_required CHECK (signature_verified),
  CONSTRAINT webhook_inbox_payload_object CHECK (jsonb_typeof(payload) IN ('object', 'array')),
  CONSTRAINT webhook_inbox_headers_object CHECK (jsonb_typeof(sanitized_headers) = 'object'),
  CONSTRAINT webhook_inbox_status_valid CHECK (
    status IN ('RECEIVED', 'PROCESSING', 'RETRY', 'PROCESSED', 'QUARANTINED', 'DEAD_LETTER')
  ),
  CONSTRAINT webhook_inbox_attempt_nonnegative CHECK (attempt_count >= 0),
  CONSTRAINT webhook_inbox_processing_consistency CHECK (
    status <> 'PROCESSING' OR (locked_at IS NOT NULL AND locked_by IS NOT NULL)
  ),
  CONSTRAINT webhook_inbox_processed_consistency CHECK (
    status <> 'PROCESSED' OR processed_at IS NOT NULL
  ),
  CONSTRAINT webhook_inbox_version_positive CHECK (version >= 1),
  CONSTRAINT webhook_inbox_tenant_key UNIQUE (organization_id, business_unit_id, id)
);

CREATE UNIQUE INDEX webhook_inbox_provider_event_unique
  ON webhook_inbox (organization_id, business_unit_id, provider, provider_event_id)
  WHERE provider_event_id IS NOT NULL;

CREATE UNIQUE INDEX webhook_inbox_deduplication_unique
  ON webhook_inbox (organization_id, business_unit_id, provider, deduplication_key)
  WHERE deduplication_key IS NOT NULL;

CREATE INDEX webhook_inbox_due_idx
  ON webhook_inbox (status, next_attempt_at, received_at)
  WHERE status IN ('RECEIVED', 'RETRY');

CREATE TABLE idempotency_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_unit_id uuid,
  actor_scope text NOT NULL,
  actor_user_id uuid,
  command_name text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash bytea NOT NULL,
  status text NOT NULL DEFAULT 'IN_PROGRESS',
  result_entity_type text,
  result_entity_id uuid,
  response_code integer,
  response_snapshot jsonb,
  response_mac bytea,
  error_code text,
  locked_at timestamptz,
  expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT idempotency_keys_business_unit_fk FOREIGN KEY (organization_id, business_unit_id)
    REFERENCES business_units (organization_id, id),
  CONSTRAINT idempotency_keys_actor_fk FOREIGN KEY (actor_user_id)
    REFERENCES users (id),
  CONSTRAINT idempotency_keys_actor_scope_nonempty CHECK (btrim(actor_scope) <> ''),
  CONSTRAINT idempotency_keys_command_nonempty CHECK (btrim(command_name) <> ''),
  CONSTRAINT idempotency_keys_key_nonempty CHECK (btrim(idempotency_key) <> ''),
  CONSTRAINT idempotency_keys_status_valid CHECK (status IN ('IN_PROGRESS', 'COMPLETED', 'FAILED')),
  CONSTRAINT idempotency_keys_response_code_valid CHECK (
    response_code IS NULL OR response_code BETWEEN 100 AND 599
  ),
  CONSTRAINT idempotency_keys_response_snapshot_object CHECK (
    response_snapshot IS NULL OR jsonb_typeof(response_snapshot) = 'object'
  ),
  CONSTRAINT idempotency_keys_response_mac_length CHECK (
    response_mac IS NULL OR octet_length(response_mac) = 32
  ),
  CONSTRAINT idempotency_keys_response_mac_lifecycle CHECK (
    (status = 'COMPLETED' AND response_mac IS NOT NULL) OR
    (status IN ('IN_PROGRESS', 'FAILED') AND response_mac IS NULL)
  ),
  CONSTRAINT idempotency_keys_expiry_valid CHECK (expires_at > created_at),
  CONSTRAINT idempotency_keys_completion_consistency CHECK (
    (
      status = 'IN_PROGRESS' AND
      completed_at IS NULL AND
      response_code IS NULL AND
      response_snapshot IS NULL AND
      error_code IS NULL
    ) OR (
      status = 'COMPLETED' AND
      completed_at IS NOT NULL AND
      response_code IS NOT NULL AND
      response_snapshot IS NOT NULL AND
      jsonb_typeof(response_snapshot) = 'object' AND
      error_code IS NULL
    ) OR (
      status = 'FAILED' AND
      completed_at IS NOT NULL AND
      response_code IS NULL AND
      response_snapshot IS NULL AND
      error_code IS NOT NULL
    )
  ),
  CONSTRAINT idempotency_keys_version_positive CHECK (version >= 1),
  CONSTRAINT idempotency_keys_unique UNIQUE (
    organization_id, actor_scope, command_name, idempotency_key
  ),
  CONSTRAINT idempotency_keys_tenant_key UNIQUE (organization_id, id)
);

CREATE INDEX idempotency_keys_expiry_idx ON idempotency_keys (expires_at);
CREATE INDEX idempotency_keys_in_progress_idx
  ON idempotency_keys (organization_id, status, locked_at)
  WHERE status = 'IN_PROGRESS';

CREATE TABLE outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_unit_id uuid,
  event_type text NOT NULL,
  event_version integer NOT NULL DEFAULT 1,
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  aggregate_version bigint,
  actor_type text NOT NULL,
  actor_user_id uuid,
  correlation_id uuid NOT NULL,
  causation_event_id uuid,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'PENDING',
  attempt_count integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  locked_at timestamptz,
  locked_by text,
  published_at timestamptz,
  last_error_code text,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  version bigint NOT NULL DEFAULT 1,
  CONSTRAINT outbox_events_business_unit_fk FOREIGN KEY (organization_id, business_unit_id)
    REFERENCES business_units (organization_id, id),
  CONSTRAINT outbox_events_actor_fk FOREIGN KEY (actor_user_id)
    REFERENCES users (id),
  CONSTRAINT outbox_events_event_type_nonempty CHECK (btrim(event_type) <> ''),
  CONSTRAINT outbox_events_event_version_positive CHECK (event_version >= 1),
  CONSTRAINT outbox_events_aggregate_nonempty CHECK (btrim(aggregate_type) <> ''),
  CONSTRAINT outbox_events_actor_type_valid CHECK (actor_type IN ('USER', 'SERVICE', 'SYSTEM')),
  CONSTRAINT outbox_events_payload_object CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT outbox_events_status_valid CHECK (status IN ('PENDING', 'PUBLISHING', 'PUBLISHED', 'RETRY', 'DEAD_LETTER')),
  CONSTRAINT outbox_events_attempt_nonnegative CHECK (attempt_count >= 0),
  CONSTRAINT outbox_events_publishing_consistency CHECK (
    status <> 'PUBLISHING' OR (locked_at IS NOT NULL AND locked_by IS NOT NULL)
  ),
  CONSTRAINT outbox_events_published_consistency CHECK (
    status <> 'PUBLISHED' OR published_at IS NOT NULL
  ),
  CONSTRAINT outbox_events_version_positive CHECK (version >= 1),
  CONSTRAINT outbox_events_tenant_key UNIQUE (organization_id, id)
);

CREATE INDEX outbox_events_due_idx
  ON outbox_events (status, available_at, occurred_at)
  WHERE status IN ('PENDING', 'RETRY');
CREATE INDEX outbox_events_aggregate_idx
  ON outbox_events (organization_id, aggregate_type, aggregate_id, occurred_at);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_unit_id uuid,
  actor_type text NOT NULL,
  actor_user_id uuid,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id uuid,
  outcome text NOT NULL,
  reason text,
  request_id uuid,
  correlation_id uuid,
  ip_address inet,
  user_agent_hash bytea,
  change_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  protected_before_ref text,
  protected_after_ref text,
  previous_event_hash bytea,
  event_hash bytea,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT audit_events_business_unit_fk FOREIGN KEY (organization_id, business_unit_id)
    REFERENCES business_units (organization_id, id),
  CONSTRAINT audit_events_actor_fk FOREIGN KEY (actor_user_id)
    REFERENCES users (id),
  CONSTRAINT audit_events_actor_type_valid CHECK (actor_type IN ('USER', 'SERVICE', 'SYSTEM', 'SUPPORT')),
  CONSTRAINT audit_events_action_nonempty CHECK (btrim(action) <> ''),
  CONSTRAINT audit_events_target_nonempty CHECK (btrim(target_type) <> ''),
  CONSTRAINT audit_events_outcome_valid CHECK (outcome IN ('SUCCESS', 'DENIED', 'FAILURE')),
  CONSTRAINT audit_events_change_summary_object CHECK (jsonb_typeof(change_summary) = 'object'),
  CONSTRAINT audit_events_time_order CHECK (recorded_at >= occurred_at),
  CONSTRAINT audit_events_tenant_key UNIQUE (organization_id, id)
);

CREATE INDEX audit_events_target_time_idx
  ON audit_events (organization_id, business_unit_id, target_type, target_id, occurred_at DESC);
CREATE INDEX audit_events_actor_time_idx
  ON audit_events (organization_id, actor_user_id, occurred_at DESC)
  WHERE actor_user_id IS NOT NULL;
CREATE INDEX audit_events_correlation_idx
  ON audit_events (organization_id, correlation_id)
  WHERE correlation_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Database-enforced high-risk invariants
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION crm_validate_lot_allocation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  lot_status text;
BEGIN
  IF NEW.released_at IS NULL THEN
    SELECT operational_status
      INTO lot_status
      FROM lots
     WHERE organization_id = NEW.organization_id
       AND business_unit_id = NEW.business_unit_id
       AND id = NEW.lot_id
     FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Lot does not exist in allocation tenant scope'
        USING ERRCODE = '23503';
    END IF;

    IF lot_status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'Lot % is not available for allocation (status %)', NEW.lot_id, lot_status
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION crm_validate_allocation_subtype()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  actual_kind text;
  expected_kind text;
BEGIN
  expected_kind := CASE WHEN TG_TABLE_NAME = 'lot_holds' THEN 'HOLD' ELSE 'RESERVATION' END;

  SELECT allocation_kind
    INTO actual_kind
    FROM lot_allocations
   WHERE organization_id = NEW.organization_id
     AND business_unit_id = NEW.business_unit_id
     AND id = NEW.allocation_id;

  IF actual_kind IS DISTINCT FROM expected_kind THEN
    RAISE EXCEPTION '% requires a % allocation', TG_TABLE_NAME, expected_kind
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION crm_assert_payment_limits(target_payment_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  payment_row payments%ROWTYPE;
  net_allocated numeric(19,4);
  active_refunds numeric(19,4);
BEGIN
  SELECT *
    INTO payment_row
    FROM payments
   WHERE id = target_payment_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM payment_allocations reversal
      JOIN payment_allocations original
        ON original.organization_id = reversal.organization_id
       AND original.business_unit_id = reversal.business_unit_id
       AND original.payment_id = reversal.payment_id
       AND original.id = reversal.reverses_allocation_id
     WHERE reversal.payment_id = target_payment_id
       AND reversal.allocation_type = 'REVERSAL'
       AND (
         original.allocation_type <> 'ALLOCATION' OR
         original.installment_id <> reversal.installment_id OR
         original.amount <> reversal.amount
       )
  ) THEN
    RAISE EXCEPTION 'Payment allocation reversal must exactly reverse its original allocation'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM payment_allocations allocation
      JOIN installments installment
        ON installment.organization_id = allocation.organization_id
       AND installment.business_unit_id = allocation.business_unit_id
       AND installment.id = allocation.installment_id
      JOIN invoices invoice
        ON invoice.organization_id = installment.organization_id
       AND invoice.business_unit_id = installment.business_unit_id
       AND invoice.id = installment.invoice_id
     WHERE allocation.payment_id = target_payment_id
       AND invoice.currency <> payment_row.currency
  ) THEN
    RAISE EXCEPTION 'Payment and allocated invoice currencies must match'
      USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(SUM(
           CASE allocation_type WHEN 'ALLOCATION' THEN amount ELSE -amount END
         ), 0)
    INTO net_allocated
    FROM payment_allocations
   WHERE payment_id = target_payment_id;

  IF net_allocated < 0 OR net_allocated > payment_row.amount THEN
    RAISE EXCEPTION 'Net payment allocations % exceed valid range 0..%', net_allocated, payment_row.amount
      USING ERRCODE = '23514';
  END IF;

  IF net_allocated > 0 AND payment_row.status <> 'SETTLED' THEN
    RAISE EXCEPTION 'Only settled payments can retain allocations'
      USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(SUM(amount), 0)
    INTO active_refunds
    FROM refunds
   WHERE payment_id = target_payment_id
     AND status IN ('APPROVED', 'PROCESSING', 'SETTLED');

  IF active_refunds > payment_row.amount THEN
    RAISE EXCEPTION 'Active refunds % exceed settled payment amount %', active_refunds, payment_row.amount
      USING ERRCODE = '23514';
  END IF;

  IF active_refunds > 0 AND payment_row.status <> 'SETTLED' THEN
    RAISE EXCEPTION 'Only settled payments are eligible for refund'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM refunds refund
     WHERE refund.payment_id = target_payment_id
       AND refund.currency <> payment_row.currency
  ) THEN
    RAISE EXCEPTION 'Payment and refund currencies must match'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION crm_assert_installment_limit(target_installment_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  installment_amount numeric(19,4);
  waived numeric(19,4);
  net_allocated numeric(19,4);
BEGIN
  SELECT amount, waived_amount
    INTO installment_amount, waived
    FROM installments
   WHERE id = target_installment_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT COALESCE(SUM(
           CASE allocation_type WHEN 'ALLOCATION' THEN amount ELSE -amount END
         ), 0)
    INTO net_allocated
    FROM payment_allocations
   WHERE installment_id = target_installment_id;

  IF net_allocated < 0 OR net_allocated > (installment_amount - waived) THEN
    RAISE EXCEPTION 'Net installment allocations % exceed collectible amount %',
      net_allocated, (installment_amount - waived)
      USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION crm_finance_constraint_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_TABLE_NAME = 'payment_allocations' THEN
    IF TG_OP <> 'DELETE' THEN
      PERFORM crm_assert_payment_limits(NEW.payment_id);
      PERFORM crm_assert_installment_limit(NEW.installment_id);
    END IF;
    IF TG_OP <> 'INSERT' THEN
      PERFORM crm_assert_payment_limits(OLD.payment_id);
      PERFORM crm_assert_installment_limit(OLD.installment_id);
    END IF;
  ELSIF TG_TABLE_NAME = 'refunds' THEN
    IF TG_OP <> 'DELETE' THEN
      PERFORM crm_assert_payment_limits(NEW.payment_id);
    END IF;
    IF TG_OP <> 'INSERT' THEN
      PERFORM crm_assert_payment_limits(OLD.payment_id);
    END IF;
  ELSIF TG_TABLE_NAME = 'payments' THEN
    PERFORM crm_assert_payment_limits(NEW.id);
  ELSIF TG_TABLE_NAME = 'installments' THEN
    PERFORM crm_assert_installment_limit(NEW.id);
  END IF;

  RETURN NULL;
END;
$$;

CREATE TRIGGER lot_allocations_validate
BEFORE INSERT OR UPDATE ON lot_allocations
FOR EACH ROW EXECUTE FUNCTION crm_validate_lot_allocation();

CREATE TRIGGER lot_holds_allocation_kind
BEFORE INSERT OR UPDATE OF allocation_id ON lot_holds
FOR EACH ROW EXECUTE FUNCTION crm_validate_allocation_subtype();

CREATE TRIGGER reservations_allocation_kind
BEFORE INSERT OR UPDATE OF allocation_id ON reservations
FOR EACH ROW EXECUTE FUNCTION crm_validate_allocation_subtype();

CREATE CONSTRAINT TRIGGER payment_allocations_financial_guard
AFTER INSERT OR UPDATE OR DELETE ON payment_allocations
DEFERRABLE INITIALLY IMMEDIATE
FOR EACH ROW EXECUTE FUNCTION crm_finance_constraint_trigger();

CREATE CONSTRAINT TRIGGER refunds_financial_guard
AFTER INSERT OR UPDATE OR DELETE ON refunds
DEFERRABLE INITIALLY IMMEDIATE
FOR EACH ROW EXECUTE FUNCTION crm_finance_constraint_trigger();

CREATE CONSTRAINT TRIGGER payments_financial_guard
AFTER UPDATE OF amount, currency, status ON payments
DEFERRABLE INITIALLY IMMEDIATE
FOR EACH ROW EXECUTE FUNCTION crm_finance_constraint_trigger();

CREATE CONSTRAINT TRIGGER installments_financial_guard
AFTER UPDATE OF amount, waived_amount ON installments
DEFERRABLE INITIALLY IMMEDIATE
FOR EACH ROW EXECUTE FUNCTION crm_finance_constraint_trigger();

-- ---------------------------------------------------------------------------
-- Optimistic-version triggers
-- ---------------------------------------------------------------------------

CREATE TRIGGER organizations_touch_version BEFORE UPDATE ON organizations
  FOR EACH ROW EXECUTE FUNCTION crm_touch_version();
CREATE TRIGGER business_units_touch_version BEFORE UPDATE ON business_units
  FOR EACH ROW EXECUTE FUNCTION crm_touch_version();
CREATE TRIGGER users_touch_version BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION crm_touch_version();
CREATE TRIGGER memberships_touch_version BEFORE UPDATE ON memberships
  FOR EACH ROW EXECUTE FUNCTION crm_touch_version();
CREATE TRIGGER roles_touch_version BEFORE UPDATE ON roles
  FOR EACH ROW EXECUTE FUNCTION crm_touch_version();
CREATE TRIGGER sessions_touch_version BEFORE UPDATE ON sessions
  FOR EACH ROW EXECUTE FUNCTION crm_touch_version();
CREATE TRIGGER teams_touch_version BEFORE UPDATE ON teams
  FOR EACH ROW EXECUTE FUNCTION crm_touch_version();
CREATE TRIGGER accounts_touch_version BEFORE UPDATE ON accounts
  FOR EACH ROW EXECUTE FUNCTION crm_touch_version();
CREATE TRIGGER account_business_units_touch_version BEFORE UPDATE ON account_business_units
  FOR EACH ROW EXECUTE FUNCTION crm_touch_version();
CREATE TRIGGER contacts_touch_version BEFORE UPDATE ON contacts
  FOR EACH ROW EXECUTE FUNCTION crm_touch_version();
CREATE TRIGGER contact_business_units_touch_version BEFORE UPDATE ON contact_business_units
  FOR EACH ROW EXECUTE FUNCTION crm_touch_version();
CREATE TRIGGER contact_identifiers_touch_version BEFORE UPDATE ON contact_identifiers
  FOR EACH ROW EXECUTE FUNCTION crm_touch_version();
CREATE TRIGGER pipelines_touch_version BEFORE UPDATE ON pipelines
  FOR EACH ROW EXECUTE FUNCTION crm_touch_version();
CREATE TRIGGER pipeline_stages_touch_version BEFORE UPDATE ON pipeline_stages
  FOR EACH ROW EXECUTE FUNCTION crm_touch_version();
CREATE TRIGGER pipeline_stage_transitions_touch_version BEFORE UPDATE ON pipeline_stage_transitions
  FOR EACH ROW EXECUTE FUNCTION crm_touch_version();
CREATE TRIGGER leads_touch_version BEFORE UPDATE ON leads
  FOR EACH ROW EXECUTE FUNCTION crm_touch_version();
CREATE TRIGGER opportunities_touch_version BEFORE UPDATE ON opportunities
  FOR EACH ROW EXECUTE FUNCTION crm_touch_version();
CREATE TRIGGER tasks_touch_version BEFORE UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION crm_touch_version();
CREATE TRIGGER land_projects_touch_version BEFORE UPDATE ON land_projects
  FOR EACH ROW EXECUTE FUNCTION crm_touch_version();
CREATE TRIGGER lots_touch_version BEFORE UPDATE ON lots
  FOR EACH ROW EXECUTE FUNCTION crm_touch_version();
CREATE TRIGGER lot_allocations_touch_version BEFORE UPDATE ON lot_allocations
  FOR EACH ROW EXECUTE FUNCTION crm_touch_version();
CREATE TRIGGER lot_holds_touch_version BEFORE UPDATE ON lot_holds
  FOR EACH ROW EXECUTE FUNCTION crm_touch_version();
CREATE TRIGGER reservations_touch_version BEFORE UPDATE ON reservations
  FOR EACH ROW EXECUTE FUNCTION crm_touch_version();
CREATE TRIGGER orders_touch_version BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION crm_touch_version();
CREATE TRIGGER order_items_touch_version BEFORE UPDATE ON order_items
  FOR EACH ROW EXECUTE FUNCTION crm_touch_version();
CREATE TRIGGER invoices_touch_version BEFORE UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION crm_touch_version();
CREATE TRIGGER installments_touch_version BEFORE UPDATE ON installments
  FOR EACH ROW EXECUTE FUNCTION crm_touch_version();
CREATE TRIGGER payments_touch_version BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION crm_touch_version();
CREATE TRIGGER refunds_touch_version BEFORE UPDATE ON refunds
  FOR EACH ROW EXECUTE FUNCTION crm_touch_version();
CREATE TRIGGER activities_touch_version BEFORE UPDATE ON activities
  FOR EACH ROW EXECUTE FUNCTION crm_touch_version();
CREATE TRIGGER integration_connections_touch_version BEFORE UPDATE ON integration_connections
  FOR EACH ROW EXECUTE FUNCTION crm_touch_version();
CREATE TRIGGER webhook_inbox_touch_version BEFORE UPDATE ON webhook_inbox
  FOR EACH ROW EXECUTE FUNCTION crm_touch_version();
CREATE TRIGGER idempotency_keys_immutable_record BEFORE UPDATE OR DELETE ON idempotency_keys
  FOR EACH ROW EXECUTE FUNCTION crm_guard_idempotency_record();
CREATE TRIGGER idempotency_keys_no_truncate BEFORE TRUNCATE ON idempotency_keys
  FOR EACH STATEMENT EXECUTE FUNCTION crm_guard_idempotency_record();
CREATE TRIGGER idempotency_keys_touch_version BEFORE UPDATE ON idempotency_keys
  FOR EACH ROW EXECUTE FUNCTION crm_touch_version();
CREATE TRIGGER outbox_events_touch_version BEFORE UPDATE ON outbox_events
  FOR EACH ROW EXECUTE FUNCTION crm_touch_version();

-- ---------------------------------------------------------------------------
-- Append-only evidence guards
-- ---------------------------------------------------------------------------

CREATE TRIGGER auth_login_attempts_append_only
BEFORE UPDATE OR DELETE OR TRUNCATE ON auth_login_attempts
FOR EACH STATEMENT EXECUTE FUNCTION crm_block_mutation();

CREATE TRIGGER consents_append_only
BEFORE UPDATE OR DELETE OR TRUNCATE ON consents
FOR EACH STATEMENT EXECUTE FUNCTION crm_block_mutation();

CREATE TRIGGER lead_stage_history_append_only
BEFORE UPDATE OR DELETE OR TRUNCATE ON lead_stage_history
FOR EACH STATEMENT EXECUTE FUNCTION crm_block_mutation();

CREATE TRIGGER opportunity_stage_history_append_only
BEFORE UPDATE OR DELETE OR TRUNCATE ON opportunity_stage_history
FOR EACH STATEMENT EXECUTE FUNCTION crm_block_mutation();

CREATE TRIGGER payment_allocations_append_only
BEFORE UPDATE OR DELETE OR TRUNCATE ON payment_allocations
FOR EACH STATEMENT EXECUTE FUNCTION crm_block_mutation();

CREATE TRIGGER finance_ledger_entries_append_only
BEFORE UPDATE OR DELETE OR TRUNCATE ON finance_ledger_entries
FOR EACH STATEMENT EXECUTE FUNCTION crm_block_mutation();

CREATE TRIGGER audit_events_append_only
BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_events
FOR EACH STATEMENT EXECUTE FUNCTION crm_block_mutation();

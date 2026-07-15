import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  char,
  customType,
  date,
  inet,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

type JsonObject = Record<string, unknown>;

const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => "bytea",
});

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).default(sql`clock_timestamp()`).notNull();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).default(sql`clock_timestamp()`).notNull();
const version = () => bigint("version", { mode: "number" }).default(1).notNull();
const emptyJsonObject = sql`'{}'::jsonb`;

export type OrganizationStatus = "ACTIVE" | "SUSPENDED" | "CLOSED";
export type BusinessUnitStatus = OrganizationStatus;
export type UserType = "HUMAN" | "SERVICE";
export type UserStatus = "PENDING" | "ACTIVE" | "SUSPENDED" | "DISABLED";
export type MembershipStatus = "INVITED" | "ACTIVE" | "SUSPENDED" | "EXPIRED" | "REVOKED";
export type RiskLevel = "STANDARD" | "SENSITIVE" | "PRIVILEGED";
export type RoleStatus = "ACTIVE" | "DISABLED";
export type SessionStatus = "ACTIVE" | "REVOKED" | "EXPIRED";
export type LoginOutcome = "SUCCESS" | "FAILURE" | "BLOCKED" | "CHALLENGE";
export type PartyStatus = "ACTIVE" | "INACTIVE" | "POSSIBLE_DUPLICATE" | "MERGED" | "ANONYMIZED";
export type RelationshipStatus = "ACTIVE" | "INACTIVE" | "RESTRICTED";
export type ContactIdentifierType = "PHONE" | "EMAIL" | "PROVIDER" | "NATIONAL_ID" | "OTHER";
export type VerificationStatus = "UNVERIFIED" | "PENDING" | "VERIFIED" | "FAILED" | "REVOKED";
export type PipelineEntityType = "LEAD" | "OPPORTUNITY";
export type PipelineStatus = "ACTIVE" | "DISABLED";
export type PipelineStageCategory = "OPEN" | "CONVERTED" | "WON" | "LOST" | "DISQUALIFIED" | "ON_HOLD";
export type TaskPriority = "LOW" | "NORMAL" | "HIGH" | "URGENT";
export type TaskStatus = "OPEN" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED";
export type IdempotencyStatus = "IN_PROGRESS" | "COMPLETED" | "FAILED";
export interface LeadCreateReplaySnapshot extends Record<string, unknown> {
  id: string;
  contactId: string;
  pipelineId: string;
  stageId: string;
  stage: string;
  version: number;
  receivedAt: string;
  createdAt: string;
}
export interface LeadTransitionReplaySnapshot extends Record<string, unknown> {
  id: string;
  stage: string;
  stageId: string;
  ownerMembershipId: string | null;
  version: number;
  updatedAt: string;
  changed: boolean;
}
export type WebhookStatus = "RECEIVED" | "PROCESSING" | "RETRY" | "PROCESSED" | "QUARANTINED" | "DEAD_LETTER";
export type OutboxActorType = "USER" | "SERVICE" | "SYSTEM";
export type OutboxStatus = "PENDING" | "PUBLISHING" | "PUBLISHED" | "RETRY" | "DEAD_LETTER";
export type AuditActorType = OutboxActorType | "SUPPORT";
export type AuditOutcome = "SUCCESS" | "DENIED" | "FAILURE";

export const organizations = pgTable("organizations", {
  id: uuid("id").defaultRandom().primaryKey(),
  code: text("code").notNull(),
  name: text("name").notNull(),
  defaultTimezone: text("default_timezone").default("Asia/Kuala_Lumpur").notNull(),
  defaultCurrency: char("default_currency", { length: 3 }).default("MYR").notNull(),
  status: text("status").$type<OrganizationStatus>().default("ACTIVE").notNull(),
  version: version(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const businessUnits = pgTable("business_units", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull(),
  code: text("code").notNull(),
  name: text("name").notNull(),
  timezone: text("timezone").default("Asia/Kuala_Lumpur").notNull(),
  currency: char("currency", { length: 3 }).default("MYR").notNull(),
  status: text("status").$type<BusinessUnitStatus>().default("ACTIVE").notNull(),
  version: version(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  authSubject: text("auth_subject").notNull(),
  displayName: text("display_name").notNull(),
  emailHash: bytea("email_hash"),
  userType: text("user_type").$type<UserType>().default("HUMAN").notNull(),
  status: text("status").$type<UserStatus>().default("PENDING").notNull(),
  lastAuthenticatedAt: timestamp("last_authenticated_at", { withTimezone: true }),
  version: version(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const memberships = pgTable("memberships", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull(),
  businessUnitId: uuid("business_unit_id"),
  userId: uuid("user_id").notNull(),
  status: text("status").$type<MembershipStatus>().default("ACTIVE").notNull(),
  validFrom: timestamp("valid_from", { withTimezone: true })
    .default(sql`clock_timestamp()`)
    .notNull(),
  validUntil: timestamp("valid_until", { withTimezone: true }),
  version: version(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const capabilities = pgTable("capabilities", {
  key: text("key").primaryKey(),
  description: text("description").notNull(),
  riskLevel: text("risk_level").$type<RiskLevel>().default("STANDARD").notNull(),
  createdAt: createdAt(),
});

export const roles = pgTable("roles", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull(),
  key: text("key").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  isSystem: boolean("is_system").default(false).notNull(),
  status: text("status").$type<RoleStatus>().default("ACTIVE").notNull(),
  version: version(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const roleCapabilities = pgTable(
  "role_capabilities",
  {
    organizationId: uuid("organization_id").notNull(),
    roleId: uuid("role_id").notNull(),
    capabilityKey: text("capability_key").notNull(),
    constraints: jsonb("constraints").$type<JsonObject>().default(emptyJsonObject).notNull(),
    createdAt: createdAt(),
  },
  (table) => [primaryKey({ columns: [table.organizationId, table.roleId, table.capabilityKey] })],
);

export const membershipRoles = pgTable(
  "membership_roles",
  {
    organizationId: uuid("organization_id").notNull(),
    membershipId: uuid("membership_id").notNull(),
    roleId: uuid("role_id").notNull(),
    grantedByUserId: uuid("granted_by_user_id"),
    validFrom: timestamp("valid_from", { withTimezone: true })
      .default(sql`clock_timestamp()`)
      .notNull(),
    validUntil: timestamp("valid_until", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [primaryKey({ columns: [table.organizationId, table.membershipId, table.roleId] })],
);

export const sessions = pgTable("sessions", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull(),
  activeBusinessUnitId: uuid("active_business_unit_id"),
  userId: uuid("user_id").notNull(),
  tokenHash: bytea("token_hash").notNull(),
  status: text("status").$type<SessionStatus>().default("ACTIVE").notNull(),
  assuranceLevel: smallint("assurance_level").default(1).notNull(),
  issuedAt: timestamp("issued_at", { withTimezone: true })
    .default(sql`clock_timestamp()`)
    .notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
    .default(sql`clock_timestamp()`)
    .notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  revokeReason: text("revoke_reason"),
  ipHash: bytea("ip_hash"),
  userAgentHash: bytea("user_agent_hash"),
  version: version(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const authLoginAttempts = pgTable("auth_login_attempts", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id"),
  userId: uuid("user_id"),
  attemptedIdentifierHash: bytea("attempted_identifier_hash").notNull(),
  outcome: text("outcome").$type<LoginOutcome>().notNull(),
  failureCode: text("failure_code"),
  ipHash: bytea("ip_hash"),
  userAgentHash: bytea("user_agent_hash"),
  correlationId: uuid("correlation_id"),
  occurredAt: timestamp("occurred_at", { withTimezone: true })
    .default(sql`clock_timestamp()`)
    .notNull(),
  createdAt: createdAt(),
});

export const accounts = pgTable("accounts", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull(),
  accountType: text("account_type")
    .$type<"BUSINESS" | "INSTITUTION" | "HOUSEHOLD">()
    .default("BUSINESS")
    .notNull(),
  displayName: text("display_name").notNull(),
  legalName: text("legal_name"),
  registrationNumberHash: bytea("registration_number_hash"),
  status: text("status").$type<PartyStatus>().default("ACTIVE").notNull(),
  metadata: jsonb("metadata").$type<JsonObject>().default(emptyJsonObject).notNull(),
  version: version(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const contacts = pgTable("contacts", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull(),
  displayName: text("display_name").notNull(),
  givenName: text("given_name"),
  familyName: text("family_name"),
  preferredName: text("preferred_name"),
  locale: text("locale"),
  status: text("status").$type<PartyStatus>().default("ACTIVE").notNull(),
  mergedIntoContactId: uuid("merged_into_contact_id"),
  metadata: jsonb("metadata").$type<JsonObject>().default(emptyJsonObject).notNull(),
  version: version(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const contactBusinessUnits = pgTable("contact_business_units", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull(),
  businessUnitId: uuid("business_unit_id").notNull(),
  contactId: uuid("contact_id").notNull(),
  relationshipType: text("relationship_type").default("CUSTOMER").notNull(),
  purpose: text("purpose").notNull(),
  status: text("status").$type<RelationshipStatus>().default("ACTIVE").notNull(),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
    .default(sql`clock_timestamp()`)
    .notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
    .default(sql`clock_timestamp()`)
    .notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  version: version(),
});

export const contactIdentifiers = pgTable("contact_identifiers", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull(),
  contactId: uuid("contact_id").notNull(),
  identifierType: text("identifier_type").$type<ContactIdentifierType>().notNull(),
  normalizedValue: text("normalized_value"),
  valueHash: bytea("value_hash").notNull(),
  protectedValueRef: text("protected_value_ref"),
  verificationStatus: text("verification_status")
    .$type<VerificationStatus>()
    .default("UNVERIFIED")
    .notNull(),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  isPrimary: boolean("is_primary").default(false).notNull(),
  source: text("source").notNull(),
  version: version(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const pipelines = pgTable("pipelines", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull(),
  businessUnitId: uuid("business_unit_id").notNull(),
  entityType: text("entity_type").$type<PipelineEntityType>().notNull(),
  code: text("code").notNull(),
  name: text("name").notNull(),
  status: text("status").$type<PipelineStatus>().default("ACTIVE").notNull(),
  version: version(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const pipelineStages = pgTable("pipeline_stages", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull(),
  businessUnitId: uuid("business_unit_id").notNull(),
  pipelineId: uuid("pipeline_id").notNull(),
  code: text("code").notNull(),
  name: text("name").notNull(),
  category: text("category").$type<PipelineStageCategory>().notNull(),
  position: integer("position").notNull(),
  probability: numeric("probability", { precision: 5, scale: 2 }),
  isTerminal: boolean("is_terminal").default(false).notNull(),
  status: text("status").$type<PipelineStatus>().default("ACTIVE").notNull(),
  version: version(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const pipelineStageTransitions = pgTable("pipeline_stage_transitions", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull(),
  businessUnitId: uuid("business_unit_id").notNull(),
  pipelineId: uuid("pipeline_id").notNull(),
  fromStageId: uuid("from_stage_id").notNull(),
  toStageId: uuid("to_stage_id").notNull(),
  requiresReason: boolean("requires_reason").default(false).notNull(),
  requiredCapability: text("required_capability"),
  status: text("status").$type<PipelineStatus>().default("ACTIVE").notNull(),
  version: version(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const leads = pgTable("leads", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull(),
  businessUnitId: uuid("business_unit_id").notNull(),
  contactId: uuid("contact_id").notNull(),
  accountId: uuid("account_id"),
  pipelineId: uuid("pipeline_id").notNull(),
  stageId: uuid("stage_id").notNull(),
  ownerMembershipId: uuid("owner_membership_id"),
  assignedByMembershipId: uuid("assigned_by_membership_id"),
  title: text("title").notNull(),
  sourceProvider: text("source_provider").notNull(),
  sourceChannel: text("source_channel"),
  externalLeadId: text("external_lead_id"),
  duplicateFingerprint: bytea("duplicate_fingerprint"),
  providerOccurredAt: timestamp("provider_occurred_at", { withTimezone: true }),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
  ingestedAt: timestamp("ingested_at", { withTimezone: true })
    .default(sql`clock_timestamp()`)
    .notNull(),
  assignedAt: timestamp("assigned_at", { withTimezone: true }),
  assignmentLocked: boolean("assignment_locked").default(false).notNull(),
  attribution: jsonb("attribution").$type<JsonObject>().default(emptyJsonObject).notNull(),
  legacyData: jsonb("legacy_data").$type<JsonObject>().default(emptyJsonObject).notNull(),
  version: version(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const leadStageHistory = pgTable("lead_stage_history", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull(),
  businessUnitId: uuid("business_unit_id").notNull(),
  leadId: uuid("lead_id").notNull(),
  fromStageId: uuid("from_stage_id"),
  toStageId: uuid("to_stage_id").notNull(),
  actorUserId: uuid("actor_user_id"),
  transitionSource: text("transition_source").notNull(),
  reason: text("reason"),
  occurredAt: timestamp("occurred_at", { withTimezone: true })
    .default(sql`clock_timestamp()`)
    .notNull(),
  correlationId: uuid("correlation_id"),
  createdAt: createdAt(),
});

export const opportunities = pgTable("opportunities", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull(),
  businessUnitId: uuid("business_unit_id").notNull(),
  leadId: uuid("lead_id"),
  contactId: uuid("contact_id").notNull(),
  accountId: uuid("account_id"),
  pipelineId: uuid("pipeline_id").notNull(),
  stageId: uuid("stage_id").notNull(),
  ownerMembershipId: uuid("owner_membership_id"),
  name: text("name").notNull(),
  expectedAmount: numeric("expected_amount", { precision: 19, scale: 4 }),
  currency: char("currency", { length: 3 }).default("MYR").notNull(),
  probability: numeric("probability", { precision: 5, scale: 2 }),
  expectedCloseDate: date("expected_close_date"),
  wonAt: timestamp("won_at", { withTimezone: true }),
  lostAt: timestamp("lost_at", { withTimezone: true }),
  lossReason: text("loss_reason"),
  legacyData: jsonb("legacy_data").$type<JsonObject>().default(emptyJsonObject).notNull(),
  version: version(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const tasks = pgTable("tasks", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull(),
  businessUnitId: uuid("business_unit_id").notNull(),
  contactId: uuid("contact_id"),
  leadId: uuid("lead_id"),
  opportunityId: uuid("opportunity_id"),
  assignedMembershipId: uuid("assigned_membership_id"),
  assignedTeamId: uuid("assigned_team_id"),
  taskType: text("task_type").notNull(),
  subject: text("subject").notNull(),
  description: text("description"),
  priority: text("priority").$type<TaskPriority>().default("NORMAL").notNull(),
  status: text("status").$type<TaskStatus>().default("OPEN").notNull(),
  dueAt: timestamp("due_at", { withTimezone: true }),
  reminderAt: timestamp("reminder_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  completedByUserId: uuid("completed_by_user_id"),
  version: version(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const idempotencyKeys = pgTable("idempotency_keys", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull(),
  businessUnitId: uuid("business_unit_id"),
  actorScope: text("actor_scope").notNull(),
  actorUserId: uuid("actor_user_id"),
  commandName: text("command_name").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  requestHash: bytea("request_hash").notNull(),
  status: text("status").$type<IdempotencyStatus>().default("IN_PROGRESS").notNull(),
  resultEntityType: text("result_entity_type"),
  resultEntityId: uuid("result_entity_id"),
  responseCode: integer("response_code"),
  responseSnapshot: jsonb("response_snapshot").$type<
    LeadCreateReplaySnapshot | LeadTransitionReplaySnapshot
  >(),
  responseMac: bytea("response_mac"),
  errorCode: text("error_code"),
  lockedAt: timestamp("locked_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  version: version(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const webhookInbox = pgTable("webhook_inbox", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull(),
  businessUnitId: uuid("business_unit_id").notNull(),
  integrationConnectionId: uuid("integration_connection_id").notNull(),
  provider: text("provider").notNull(),
  providerEventId: text("provider_event_id"),
  deduplicationKey: text("deduplication_key"),
  signatureVerified: boolean("signature_verified").notNull(),
  providerOccurredAt: timestamp("provider_occurred_at", { withTimezone: true }),
  receivedAt: timestamp("received_at", { withTimezone: true })
    .default(sql`clock_timestamp()`)
    .notNull(),
  payload: jsonb("payload").$type<JsonObject | unknown[]>().notNull(),
  payloadSha256: bytea("payload_sha256").notNull(),
  protectedPayloadRef: text("protected_payload_ref"),
  sanitizedHeaders: jsonb("sanitized_headers").$type<JsonObject>().default(emptyJsonObject).notNull(),
  status: text("status").$type<WebhookStatus>().default("RECEIVED").notNull(),
  attemptCount: integer("attempt_count").default(0).notNull(),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
  lockedAt: timestamp("locked_at", { withTimezone: true }),
  lockedBy: text("locked_by"),
  processedAt: timestamp("processed_at", { withTimezone: true }),
  outcomeRef: text("outcome_ref"),
  errorCode: text("error_code"),
  errorDetail: text("error_detail"),
  version: version(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const outboxEvents = pgTable("outbox_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull(),
  businessUnitId: uuid("business_unit_id"),
  eventType: text("event_type").notNull(),
  eventVersion: integer("event_version").default(1).notNull(),
  aggregateType: text("aggregate_type").notNull(),
  aggregateId: uuid("aggregate_id").notNull(),
  aggregateVersion: bigint("aggregate_version", { mode: "number" }),
  actorType: text("actor_type").$type<OutboxActorType>().notNull(),
  actorUserId: uuid("actor_user_id"),
  correlationId: uuid("correlation_id").notNull(),
  causationEventId: uuid("causation_event_id"),
  payload: jsonb("payload").$type<JsonObject>().notNull(),
  status: text("status").$type<OutboxStatus>().default("PENDING").notNull(),
  attemptCount: integer("attempt_count").default(0).notNull(),
  availableAt: timestamp("available_at", { withTimezone: true })
    .default(sql`clock_timestamp()`)
    .notNull(),
  lockedAt: timestamp("locked_at", { withTimezone: true }),
  lockedBy: text("locked_by"),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  lastErrorCode: text("last_error_code"),
  occurredAt: timestamp("occurred_at", { withTimezone: true })
    .default(sql`clock_timestamp()`)
    .notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  version: version(),
});

export const auditEvents = pgTable("audit_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull(),
  businessUnitId: uuid("business_unit_id"),
  actorType: text("actor_type").$type<AuditActorType>().notNull(),
  actorUserId: uuid("actor_user_id"),
  action: text("action").notNull(),
  targetType: text("target_type").notNull(),
  targetId: uuid("target_id"),
  outcome: text("outcome").$type<AuditOutcome>().notNull(),
  reason: text("reason"),
  requestId: uuid("request_id"),
  correlationId: uuid("correlation_id"),
  ipAddress: inet("ip_address"),
  userAgentHash: bytea("user_agent_hash"),
  changeSummary: jsonb("change_summary").$type<JsonObject>().default(emptyJsonObject).notNull(),
  protectedBeforeRef: text("protected_before_ref"),
  protectedAfterRef: text("protected_after_ref"),
  previousEventHash: bytea("previous_event_hash"),
  eventHash: bytea("event_hash"),
  occurredAt: timestamp("occurred_at", { withTimezone: true })
    .default(sql`clock_timestamp()`)
    .notNull(),
  recordedAt: timestamp("recorded_at", { withTimezone: true })
    .default(sql`clock_timestamp()`)
    .notNull(),
  createdAt: createdAt(),
});

export type LeadRecord = typeof leads.$inferSelect;
export type NewLeadRecord = typeof leads.$inferInsert;

import { describe, expectTypeOf, it } from "vitest";
import type { PgTable } from "drizzle-orm/pg-core";
import type * as coreSchema from "./schema";
import type { getDatabase } from "./client";
import type {
  AuthorityState,
  ImportBatchStatus,
  ImportRowOutcome,
  SourceKind,
  SourceMode,
  SourceScopeStatus,
  importBatches,
  importRows,
  migrationDomainAuthorities,
  migrationSourceScopes,
  migrationSources,
  reconciliationResults,
  reconciliationRuns,
  sourceAuthorityTransitions,
} from "./migration-schema";

type MigrationSourceSelect = typeof migrationSources.$inferSelect;
type MigrationSourceInsert = typeof migrationSources.$inferInsert;
type ImportBatchSelect = typeof importBatches.$inferSelect;
type ImportBatchInsert = typeof importBatches.$inferInsert;
type ImportRowSelect = typeof importRows.$inferSelect;
type ImportRowInsert = typeof importRows.$inferInsert;
type MigrationDomainAuthoritySelect = typeof migrationDomainAuthorities.$inferSelect;
type MigrationDomainAuthorityInsert = typeof migrationDomainAuthorities.$inferInsert;
type MigrationSourceScopeSelect = typeof migrationSourceScopes.$inferSelect;
type MigrationSourceScopeInsert = typeof migrationSourceScopes.$inferInsert;
type SourceAuthorityTransitionSelect = typeof sourceAuthorityTransitions.$inferSelect;
type SourceAuthorityTransitionInsert = typeof sourceAuthorityTransitions.$inferInsert;
type ReconciliationRunSelect = typeof reconciliationRuns.$inferSelect;
type ReconciliationResultSelect = typeof reconciliationResults.$inferSelect;
type ReconciliationResultInsert = typeof reconciliationResults.$inferInsert;
type DatabaseQuery = ReturnType<typeof getDatabase>["query"];
type CoreTableKeys = {
  [Key in keyof typeof coreSchema]: (typeof coreSchema)[Key] extends PgTable ? Key : never;
}[keyof typeof coreSchema];

describe("typed migration schema contract", () => {
  it("locks the exact shared migration vocabularies", () => {
    expectTypeOf<SourceKind>().toEqualTypeOf<
      "SALAM_CRM_JSON" | "TASHA_SQLITE" | "NIAGAWAN_CSV" | "BARAKAH_SHEET"
    >();
    expectTypeOf<SourceMode>().toEqualTypeOf<
      "ONE_TIME_MIGRATION" | "RECURRING_READ_ONLY_SNAPSHOT"
    >();
    expectTypeOf<AuthorityState>().toEqualTypeOf<
      | "LEGACY_WRITABLE"
      | "EXTERNAL_SYSTEM_AUTHORITY"
      | "SHADOW_READ"
      | "CANONICAL_WRITABLE"
    >();
    expectTypeOf<SourceScopeStatus>().toEqualTypeOf<
      "REGISTERED" | "ACTIVE_AUTHORITY" | "ARCHIVED_READ_ONLY"
    >();
    expectTypeOf<ImportBatchStatus>().toEqualTypeOf<
      | "REGISTERED"
      | "STAGED"
      | "VALIDATED"
      | "DRY_RUN_COMPLETE"
      | "APPROVED"
      | "APPLYING"
      | "APPLIED"
      | "RECONCILED"
      | "REJECTED"
      | "FAILED"
    >();
    expectTypeOf<ImportRowOutcome>().toEqualTypeOf<
      | "STAGED"
      | "VALID"
      | "IMPORTED"
      | "NO_OP_REPLAY"
      | "REJECTED"
      | "QUARANTINED"
      | "HIDDEN"
    >();
  });

  it("locks select types for protected values, timestamps, JSON, and nullable evidence", () => {
    expectTypeOf<
      Pick<
        MigrationSourceSelect,
        "sourceKind" | "sourceMode" | "ownerMembershipId" | "createdAt" | "version"
      >
    >().toEqualTypeOf<{
      sourceKind: SourceKind;
      sourceMode: SourceMode;
      ownerMembershipId: string;
      createdAt: Date;
      version: number;
    }>();
    expectTypeOf<
      Pick<
        ImportBatchSelect,
        | "sizeBytes"
        | "sourceSha256"
        | "capturedAt"
        | "validatedDryRunBatchId"
        | "status"
      >
    >().toEqualTypeOf<{
      sizeBytes: bigint;
      sourceSha256: Uint8Array;
      capturedAt: Date;
      validatedDryRunBatchId: string | null;
      status: ImportBatchStatus;
    }>();
    expectTypeOf<
      Pick<
        ImportRowSelect,
        | "rowNumber"
        | "rowSha256"
        | "normalizedSha256"
        | "errorMetadata"
        | "outcome"
        | "updatedAt"
      >
    >().toEqualTypeOf<{
      rowNumber: bigint | null;
      rowSha256: Uint8Array;
      normalizedSha256: Uint8Array | null;
      errorMetadata: Record<string, unknown>;
      outcome: ImportRowOutcome;
      updatedAt: Date;
    }>();
    expectTypeOf<
      Pick<
        ReconciliationResultSelect,
        | "sourceCount"
        | "targetCount"
        | "sourceAmount"
        | "targetAmount"
        | "sourceChecksum"
        | "evidenceMetadata"
        | "createdAt"
      >
    >().toEqualTypeOf<{
      sourceCount: bigint | null;
      targetCount: bigint | null;
      sourceAmount: string | null;
      targetAmount: string | null;
      sourceChecksum: Uint8Array | null;
      evidenceMetadata: Record<string, unknown>;
      createdAt: Date;
    }>();
    expectTypeOf<ReconciliationRunSelect["requiredChecks"]>().toEqualTypeOf<unknown[]>();
  });

  it("binds authority and source-scope columns to their locked vocabularies", () => {
    expectTypeOf<
      MigrationDomainAuthoritySelect["authorityState"]
    >().toEqualTypeOf<AuthorityState>();
    expectTypeOf<
      MigrationDomainAuthorityInsert["authorityState"]
    >().toEqualTypeOf<AuthorityState>();
    expectTypeOf<
      Pick<SourceAuthorityTransitionSelect, "fromState" | "toState">
    >().toEqualTypeOf<{ fromState: AuthorityState; toState: AuthorityState }>();
    expectTypeOf<
      Pick<SourceAuthorityTransitionInsert, "fromState" | "toState">
    >().toEqualTypeOf<{ fromState: AuthorityState; toState: AuthorityState }>();
    expectTypeOf<
      MigrationSourceScopeSelect["sourceStatus"]
    >().toEqualTypeOf<SourceScopeStatus>();
    expectTypeOf<Pick<MigrationSourceScopeInsert, "sourceStatus">>().toEqualTypeOf<{
      sourceStatus?: SourceScopeStatus | undefined;
    }>();
  });

  it("locks required inputs and default or nullable insert optionality", () => {
    expectTypeOf<
      Pick<
        MigrationSourceInsert,
        "sourceKind" | "sourceMode" | "ownerMembershipId" | "status" | "createdAt"
      >
    >().toEqualTypeOf<{
      sourceKind: SourceKind;
      sourceMode: SourceMode;
      ownerMembershipId: string;
      status?: "REGISTERED" | "ACTIVE" | "ARCHIVED_READ_ONLY" | undefined;
      createdAt?: Date | undefined;
    }>();
    expectTypeOf<
      Pick<
        ImportBatchInsert,
        | "organizationId"
        | "sizeBytes"
        | "sourceSha256"
        | "capturedAt"
        | "validatedDryRunBatchId"
        | "status"
        | "version"
      >
    >().toEqualTypeOf<{
      organizationId: string;
      sizeBytes: bigint;
      sourceSha256: Uint8Array;
      capturedAt: Date;
      validatedDryRunBatchId?: string | null | undefined;
      status?: ImportBatchStatus | undefined;
      version?: number | undefined;
    }>();
    expectTypeOf<
      Pick<
        ImportRowInsert,
        "rowNumber" | "rowSha256" | "normalizedSha256" | "errorMetadata" | "outcome"
      >
    >().toEqualTypeOf<{
      rowNumber?: bigint | null | undefined;
      rowSha256: Uint8Array;
      normalizedSha256?: Uint8Array | null | undefined;
      errorMetadata?: Record<string, unknown> | undefined;
      outcome?: ImportRowOutcome | undefined;
    }>();
    expectTypeOf<
      Pick<
        ReconciliationResultInsert,
        | "sourceCount"
        | "targetCount"
        | "sourceAmount"
        | "targetAmount"
        | "passed"
        | "evidenceMetadata"
      >
    >().toEqualTypeOf<{
      sourceCount?: bigint | null | undefined;
      targetCount?: bigint | null | undefined;
      sourceAmount?: string | null | undefined;
      targetAmount?: string | null | undefined;
      passed: boolean;
      evidenceMetadata?: Record<string, unknown> | undefined;
    }>();
  });

  it("keeps core queries and exposes every migration table through the merged database", () => {
    expectTypeOf<DatabaseQuery>().not.toBeAny();
    expectTypeOf<Exclude<CoreTableKeys, keyof DatabaseQuery>>().toEqualTypeOf<never>();
    expectTypeOf<DatabaseQuery>().toHaveProperty("organizations");
    expectTypeOf<DatabaseQuery>().toHaveProperty("leads");
    expectTypeOf<DatabaseQuery>().toHaveProperty("migrationSources");
    expectTypeOf<DatabaseQuery>().toHaveProperty("migrationSourceScopes");
    expectTypeOf<DatabaseQuery>().toHaveProperty("migrationDomainAuthorities");
    expectTypeOf<DatabaseQuery>().toHaveProperty("sourceAuthorityTransitionGroups");
    expectTypeOf<DatabaseQuery>().toHaveProperty("transformVersions");
    expectTypeOf<DatabaseQuery>().toHaveProperty("importBatches");
    expectTypeOf<DatabaseQuery>().toHaveProperty("sourceAuthorityTransitions");
    expectTypeOf<DatabaseQuery>().toHaveProperty("importRows");
    expectTypeOf<DatabaseQuery>().toHaveProperty("legacyObjectLinks");
    expectTypeOf<DatabaseQuery>().toHaveProperty("quarantineItems");
    expectTypeOf<DatabaseQuery>().toHaveProperty("reconciliationRuns");
    expectTypeOf<DatabaseQuery>().toHaveProperty("reconciliationResults");
  });
});

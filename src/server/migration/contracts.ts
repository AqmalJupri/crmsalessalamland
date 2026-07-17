import type {
  AuthorityState,
  SourceKind,
  SourceMode,
} from "@/server/db/migration-schema";

export interface RegisteredSourceArtifact {
  objectRef: string;
  sha256: Uint8Array;
  sizeBytes: bigint;
  capturedAt: Date;
  cutoffAt: Date;
  schemaVersion: string;
}

export interface SourceArtifactStore {
  open(ref: string): AsyncIterable<Uint8Array>;
}

export interface ReviewedTransformRelease {
  manifestRef: string;
  manifestSha256: Uint8Array;
  mappingArtifactRef: string;
  mappingSha256: Uint8Array;
  sourceSchemaVersion: string;
  releaseSha256: Uint8Array;
  gitCommitSha: string;
  signatureKeyId: string;
}

export interface ReviewedTransformReleaseRegistry {
  getReviewedRelease(manifestRef: string): Promise<ReviewedTransformRelease>;
}

export interface MigrationActor {
  userId: string;
  organizationId: string;
  activeMembershipId: string;
  businessUnitId: string;
  capabilities: readonly string[];
}

export interface RegisterMigrationSourceInput {
  businessUnitId: string;
  sourceKey: string;
  sourceKind: SourceKind;
  sourceMode: SourceMode;
  ownerMembershipId: string;
  domains: readonly {
    domainKey: string;
    canonicalTarget: string;
    transitionMode: "ONE_TIME_CUTOVER" | "RECURRING_EXTERNAL_SNAPSHOT";
    initialAuthorityState: "LEGACY_WRITABLE" | "EXTERNAL_SYSTEM_AUTHORITY";
  }[];
}

export interface RegisterTransformVersionInput {
  businessUnitId: string;
  migrationSourceId: string;
  versionNo: number;
  sourceSchemaVersion: string;
  mappingArtifactRef: string;
  expectedMappingSha256: Uint8Array;
  releaseManifestRef: string;
  expectedReleaseManifestSha256: Uint8Array;
  expectedReleaseSha256: Uint8Array;
  rationale: string;
  repairOfTransformId: string | null;
}

export interface AuthorityTransitionGroupMemberInput {
  domainAuthorityId: string;
  toState: AuthorityState;
  writeFrozenAt: Date | null;
  finalBatchId: string | null;
  expectedVersion: number;
}

export interface AuthorityTransitionGroupInput {
  cutoverGroupId: string;
  planArtifactRef: string;
  expectedPlanSha256: Uint8Array;
  members: readonly AuthorityTransitionGroupMemberInput[];
  approvalReason: string;
  idempotencyKey: string;
}

export interface VerifiedAuthorityTransitionPlan {
  artifactRef: string;
  planSha256: Uint8Array;
  organizationId: string;
  notBefore: Date;
  expiresAt: Date;
  requiredMembers: readonly {
    businessUnitId: string;
    domainAuthorityId: string;
    domainKey: string;
    toState: AuthorityState;
    writeFrozenAt: Date | null;
    finalBatchId: string | null;
  }[];
}

export interface AuthorityTransitionPlanVerifier {
  verify(
    artifactRef: string,
    expectedPlanSha256: Uint8Array,
  ): Promise<VerifiedAuthorityTransitionPlan>;
}

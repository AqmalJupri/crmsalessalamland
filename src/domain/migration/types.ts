import { DomainError, type DomainErrorCode } from "@/domain/shared/errors";

export type {
  AuthorityState,
  ImportBatchStatus,
  SourceMode,
} from "@/server/db/migration-schema";

export interface BatchValidationSummary {
  totalRows: number;
  validRows: number;
  rejectedRows: number;
  quarantinedRows: number;
  hiddenRows: number;
}

type MigrationPolicyErrorCode = Extract<
  DomainErrorCode,
  "INVALID_TRANSITION" | "VALIDATION_ERROR"
>;

export class MigrationPolicyError extends DomainError {
  constructor(
    code: MigrationPolicyErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(code, message, details);
    this.name = "MigrationPolicyError";
  }
}

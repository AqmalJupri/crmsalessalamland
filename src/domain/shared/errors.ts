export type DomainErrorCode =
  | "INVALID_TRANSITION"
  | "INVARIANT_VIOLATION"
  | "CONFLICT"
  | "VALIDATION_ERROR"
  | "FORBIDDEN";

export class DomainError extends Error {
  constructor(
    public readonly code: DomainErrorCode,
    message: string,
    public readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "DomainError";
  }
}

export type CleanupStep = () => unknown | Promise<unknown>;

export function runWithCleanup<Result>(
  primaryOperation: () => Result | Promise<Result>,
  cleanupSteps: readonly CleanupStep[],
): Promise<Result>;

export interface DocumentEvidence {
  language: string | null;
  title: string;
  metadata: Record<string, string | null>;
  bodyText: string;
}

export interface ExpectedDocumentEvidence {
  language: string;
  title: string;
  metadata: Readonly<Record<string, string>>;
  forbiddenBodyText?: readonly string[];
}

export function readDocumentEvidence(
  html: string,
  relevantMetadataNames?: readonly string[],
): DocumentEvidence;

export function requireDocumentEvidence(
  html: string,
  expected: ExpectedDocumentEvidence,
): DocumentEvidence;

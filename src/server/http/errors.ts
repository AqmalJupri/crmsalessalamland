import { DomainError } from "@/domain/shared/errors";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function safeErrorMetadata(error: unknown): { name: string; code?: string } {
  const rawName = error instanceof Error ? error.name : "UnknownError";
  const name = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(rawName) ? rawName : "UnknownError";
  const rawCode =
    typeof error === "object" && error && "code" in error ? error.code : undefined;
  const code =
    typeof rawCode === "string" && /^[A-Z0-9_:-]{1,64}$/.test(rawCode)
      ? rawCode
      : undefined;
  return { name, ...(code ? { code } : {}) };
}

export function toErrorResponse(error: unknown, requestId?: string): Response {
  if (error instanceof ApiError) {
    return Response.json(
      {
        error: { code: error.code, message: error.message, details: error.details },
        requestId,
      },
      { status: error.status, headers: { "Cache-Control": "no-store" } },
    );
  }

  if (error instanceof DomainError) {
    const status = error.code === "FORBIDDEN" ? 403 : error.code === "CONFLICT" ? 409 : 422;
    return Response.json(
      {
        error: { code: error.code, message: error.message, details: error.details },
        requestId,
      },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }

  console.error("Unhandled API error", { requestId, error: safeErrorMetadata(error) });
  return Response.json(
    { error: { code: "INTERNAL_ERROR", message: "Permintaan tidak dapat diproses." }, requestId },
    { status: 500, headers: { "Cache-Control": "no-store" } },
  );
}

export function requestIdFrom(request: Request): string {
  const supplied = request.headers.get("x-request-id");
  if (supplied && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(supplied)) {
    return supplied;
  }
  return crypto.randomUUID();
}

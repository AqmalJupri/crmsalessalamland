import { ApiError, requestIdFrom, toErrorResponse } from "@/server/http/errors";
import { JsonRequestBodyError, readJsonRequestBody } from "@/server/http/request-body";
import { assertTrustedOrigin } from "@/server/http/security";
import { requireApiViewer } from "@/server/auth/viewer";
import { createLead } from "@/server/leads/create-lead";
import { createLeadSchema } from "@/server/leads/schemas";

export const dynamic = "force-dynamic";

const MAX_DATABASE_ERROR_CAUSE_DEPTH = 8;
export const LEAD_CREATE_BODY_MAX_BYTES = 32 * 1024;

interface DatabaseErrorMetadata {
  code: string;
  constraintName: string;
}

function stringProperty(value: object, property: string): string | undefined {
  try {
    const candidate = (value as Record<string, unknown>)[property];
    return typeof candidate === "string" ? candidate : undefined;
  } catch {
    return undefined;
  }
}

function findDatabaseConstraintViolation(
  error: unknown,
  expectedCode: string,
  expectedConstraintName: string,
): DatabaseErrorMetadata | undefined {
  const visited = new Set<object>();
  let current = error;

  for (let depth = 0; depth < MAX_DATABASE_ERROR_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== "object" || current === null || visited.has(current)) return undefined;
    visited.add(current);

    const code = stringProperty(current, "code");
    const constraintName = stringProperty(current, "constraint_name");
    if (code === expectedCode && constraintName === expectedConstraintName) {
      return { code, constraintName };
    }

    try {
      current = (current as { cause?: unknown }).cause;
    } catch {
      return undefined;
    }
  }

  return undefined;
}

async function readLeadBody(request: Request): Promise<unknown> {
  try {
    return await readJsonRequestBody(request, LEAD_CREATE_BODY_MAX_BYTES);
  } catch (error) {
    if (!(error instanceof JsonRequestBodyError)) throw error;
    if (error.kind === "PAYLOAD_TOO_LARGE") {
      throw new ApiError(413, "PAYLOAD_TOO_LARGE", "Badan permintaan terlalu besar.");
    }
    if (error.kind === "INVALID_CONTENT_LENGTH") {
      throw new ApiError(
        400,
        "INVALID_CONTENT_LENGTH",
        "Panjang badan permintaan tidak sah.",
      );
    }
    return null;
  }
}

export async function POST(request: Request): Promise<Response> {
  const requestId = requestIdFrom(request);
  try {
    assertTrustedOrigin(request);
    const viewer = await requireApiViewer("lead.create");
    const idempotencyKey = request.headers.get("idempotency-key");
    if (!idempotencyKey || !/^[a-zA-Z0-9._:-]{8,200}$/.test(idempotencyKey)) {
      throw new ApiError(400, "IDEMPOTENCY_KEY_REQUIRED", "Kunci permintaan diperlukan.");
    }

    const parsed = createLeadSchema.safeParse(await readLeadBody(request));
    if (!parsed.success) {
      throw new ApiError(422, "INVALID_LEAD", "Semak maklumat lead.", {
        fields: parsed.error.flatten().fieldErrors,
      });
    }

    const result = await createLead(viewer, parsed.data, idempotencyKey, requestId);
    return Response.json(
      { data: result.lead, meta: { replayed: result.replayed }, requestId },
      { status: result.responseCode, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (
      findDatabaseConstraintViolation(error, "23505", "leads_provider_external_unique")
    ) {
      return toErrorResponse(
        new ApiError(409, "DUPLICATE_EXTERNAL_LEAD", "Lead provider ini telah direkodkan."),
        requestId,
      );
    }
    return toErrorResponse(error, requestId);
  }
}

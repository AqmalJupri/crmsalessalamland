import { requireApiViewerForBusinessUnit } from "@/server/auth/viewer";
import { ApiError, requestIdFrom, toErrorResponse } from "@/server/http/errors";
import { assertTrustedOrigin } from "@/server/http/security";
import { transitionLeadSchema } from "@/server/leads/schemas";
import { transitionLeadRecord } from "@/server/leads/transition-lead";
import { z } from "zod";
import { JsonRequestBodyError, readJsonRequestBody } from "@/server/http/request-body";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export const LEAD_TRANSITION_BODY_MAX_BYTES = 32 * 1024;

async function readTransitionBody(request: Request): Promise<unknown> {
  try {
    return await readJsonRequestBody(request, LEAD_TRANSITION_BODY_MAX_BYTES);
  } catch (error) {
    if (!(error instanceof JsonRequestBodyError)) throw error;
    if (error.kind === "PAYLOAD_TOO_LARGE") {
      throw new ApiError(413, "PAYLOAD_TOO_LARGE", "Badan permintaan terlalu besar.");
    }
    if (error.kind === "INVALID_CONTENT_LENGTH") {
      throw new ApiError(400, "INVALID_CONTENT_LENGTH", "Panjang badan permintaan tidak sah.");
    }
    return null;
  }
}

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  const requestId = requestIdFrom(request);
  try {
    assertTrustedOrigin(request);
    const { id } = await context.params;
    if (!z.uuid().safeParse(id).success) {
      throw new ApiError(400, "INVALID_LEAD_ID", "ID lead tidak sah.");
    }
    const idempotencyKey = request.headers.get("idempotency-key");
    if (!idempotencyKey || !/^[a-zA-Z0-9._:-]{8,200}$/.test(idempotencyKey)) {
      throw new ApiError(400, "IDEMPOTENCY_KEY_REQUIRED", "Kunci permintaan diperlukan.");
    }

    const parsed = transitionLeadSchema.safeParse(await readTransitionBody(request));
    if (!parsed.success) {
      throw new ApiError(422, "INVALID_TRANSITION", "Semak perubahan lead.", {
        fields: parsed.error.flatten().fieldErrors,
      });
    }

    const viewer = await requireApiViewerForBusinessUnit(
      "lead.update",
      parsed.data.businessUnitId,
    );

    const result = await transitionLeadRecord(
      viewer,
      id,
      parsed.data,
      requestId,
      idempotencyKey,
    );
    return Response.json(
      {
        data: result.lead,
        meta: { changed: result.changed, replayed: result.replayed },
        requestId,
      },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}

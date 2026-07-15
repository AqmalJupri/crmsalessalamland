import { requireApiViewer } from "@/server/auth/viewer";
import { ApiError, requestIdFrom, toErrorResponse } from "@/server/http/errors";
import { assertTrustedOrigin } from "@/server/http/security";
import { transitionLeadSchema } from "@/server/leads/schemas";
import { transitionLeadRecord } from "@/server/leads/transition-lead";
import { z } from "zod";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  const requestId = requestIdFrom(request);
  try {
    assertTrustedOrigin(request);
    const viewer = await requireApiViewer("lead.update");
    const { id } = await context.params;
    if (!z.uuid().safeParse(id).success) {
      throw new ApiError(400, "INVALID_LEAD_ID", "ID lead tidak sah.");
    }
    const idempotencyKey = request.headers.get("idempotency-key");
    if (!idempotencyKey || !/^[a-zA-Z0-9._:-]{8,200}$/.test(idempotencyKey)) {
      throw new ApiError(400, "IDEMPOTENCY_KEY_REQUIRED", "Kunci permintaan diperlukan.");
    }

    const parsed = transitionLeadSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      throw new ApiError(422, "INVALID_TRANSITION", "Semak perubahan lead.", {
        fields: parsed.error.flatten().fieldErrors,
      });
    }

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

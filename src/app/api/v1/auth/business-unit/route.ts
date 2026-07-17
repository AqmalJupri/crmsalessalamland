import { cookies } from "next/headers";
import { z } from "zod";
import { BUSINESS_UNIT_COOKIE } from "@/server/auth/constants";
import { updateActiveSessionBusinessUnit } from "@/server/auth/session";
import { requireApiViewer } from "@/server/auth/viewer";
import { getRuntimeConfig } from "@/server/env";
import { ApiError, requestIdFrom, toErrorResponse } from "@/server/http/errors";
import { JsonRequestBodyError, readJsonRequestBody } from "@/server/http/request-body";
import { assertTrustedOrigin } from "@/server/http/security";

export const dynamic = "force-dynamic";
export const BUSINESS_UNIT_PREFERENCE_BODY_MAX_BYTES = 1_024;

const preferenceSchema = z.object({ businessUnitId: z.uuid() }).strict();

async function readPreferenceBody(request: Request): Promise<unknown> {
  try {
    return await readJsonRequestBody(request, BUSINESS_UNIT_PREFERENCE_BODY_MAX_BYTES);
  } catch (error) {
    if (!(error instanceof JsonRequestBodyError)) throw error;
    if (error.kind === "PAYLOAD_TOO_LARGE") {
      throw new ApiError(413, "PAYLOAD_TOO_LARGE", "Badan permintaan terlalu besar.");
    }
    throw new ApiError(400, "INVALID_REQUEST_BODY", "Badan permintaan tidak sah.");
  }
}

export async function POST(request: Request): Promise<Response> {
  const requestId = requestIdFrom(request);
  try {
    assertTrustedOrigin(request);
    const viewer = await requireApiViewer();
    const parsed = preferenceSchema.safeParse(await readPreferenceBody(request));
    if (!parsed.success) {
      throw new ApiError(422, "INVALID_BUSINESS_UNIT", "Syarikat tidak sah.");
    }

    const config = getRuntimeConfig();
    const allowed = viewer.businessUnitAccess.find(
      (unit) =>
        unit.id === parsed.data.businessUnitId &&
        (config.productSurface !== "tasha" || unit.code === "salam-land"),
    );
    if (!allowed) {
      throw new ApiError(403, "BUSINESS_UNIT_FORBIDDEN", "Akses syarikat tidak dibenarkan.");
    }

    const expiresAt = await updateActiveSessionBusinessUnit(viewer, allowed.id);
    (await cookies()).set(BUSINESS_UNIT_COOKIE, allowed.id, {
      expires: expiresAt,
      httpOnly: true,
      path: "/",
      priority: "high",
      sameSite: "lax",
      secure: config.nodeEnv === "production",
    });

    return new Response(null, {
      status: 204,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}

import { revokeCurrentSession } from "@/server/auth/session";
import { requestIdFrom, toErrorResponse } from "@/server/http/errors";
import { assertTrustedOrigin } from "@/server/http/security";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const requestId = requestIdFrom(request);
  try {
    assertTrustedOrigin(request);
    await revokeCurrentSession();
    return Response.json(
      { ok: true, requestId },
      { status: 200, headers: { "Cache-Control": "no-store", "Clear-Site-Data": '"cache", "storage"' } },
    );
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}

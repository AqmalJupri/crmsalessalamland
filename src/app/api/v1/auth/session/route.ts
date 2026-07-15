import { getViewer } from "@/server/auth/viewer";
import { requestIdFrom, toErrorResponse } from "@/server/http/errors";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const requestId = requestIdFrom(request);
  try {
    const viewer = await getViewer();
    if (!viewer) {
      return Response.json(
        { authenticated: false, requestId },
        { status: 401, headers: { "Cache-Control": "no-store" } },
      );
    }
    return Response.json(
      { authenticated: true, viewer, requestId },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}

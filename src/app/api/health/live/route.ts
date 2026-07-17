import { getRuntimeSmokeInstanceHeaders } from "@/server/health/runtime-smoke-instance";

export const dynamic = "force-dynamic";

export function GET(): Response {
  return Response.json(
    { status: "ok", service: "crm-web", version: process.env.APP_VERSION ?? "development" },
    {
      headers: {
        "Cache-Control": "no-store",
        ...getRuntimeSmokeInstanceHeaders(),
      },
    },
  );
}

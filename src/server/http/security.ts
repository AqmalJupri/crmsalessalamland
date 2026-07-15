import { ApiError } from "./errors";
import { getRuntimeConfig } from "@/server/env";

export function noStoreRedirect(location: string | URL, status = 303): Response {
  const redirect = Response.redirect(location, status);
  const headers = new Headers(redirect.headers);
  headers.set("Cache-Control", "no-store");
  return new Response(null, { status: redirect.status, headers });
}

export function assertTrustedOrigin(request: Request): void {
  const method = request.method.toUpperCase();
  if (["GET", "HEAD", "OPTIONS"].includes(method)) return;

  const origin = request.headers.get("origin");
  const expectedOrigin = new URL(getRuntimeConfig().appUrl).origin;
  if (!origin || origin !== expectedOrigin) {
    throw new ApiError(403, "UNTRUSTED_ORIGIN", "Permintaan ditolak.");
  }
}

export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || request.headers.get("x-real-ip") || "unknown";
}

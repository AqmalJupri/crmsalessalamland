import { cookies } from "next/headers";
import {
  BUSINESS_UNIT_COOKIE,
  OIDC_TRANSACTION_COOKIE,
  ORGANIZATION_COOKIE,
} from "@/server/auth/constants";
import { completeOidc } from "@/server/auth/oidc";
import { safeReturnTo } from "@/server/auth/return-to";
import { establishOidcSession } from "@/server/auth/session";
import { getRuntimeConfig } from "@/server/env";
import { ApiError, requestIdFrom, toErrorResponse } from "@/server/http/errors";
import { clientIp, noStoreRedirect } from "@/server/http/security";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const requestId = requestIdFrom(request);
  const secureCookie = process.env.NODE_ENV === "production";
  const cookieStore = await cookies();
  const sealedTransaction = cookieStore.get(OIDC_TRANSACTION_COOKIE)?.value;
  const userAgent = request.headers.get("user-agent") ?? undefined;
  const authenticationContext = {
    correlationId: requestId,
    ipAddress: clientIp(request),
    ...(userAgent ? { userAgent } : {}),
  };
  try {
    if (!sealedTransaction) {
      throw new ApiError(400, "OIDC_TRANSACTION_MISSING", "Sesi log masuk tidak ditemui. Cuba semula.");
    }

    const { identity, returnTo } = await completeOidc(request.url, sealedTransaction);
    const preferredOrganizationId = cookieStore.get(ORGANIZATION_COOKIE)?.value;
    const preferredBusinessUnitId = cookieStore.get(BUSINESS_UNIT_COOKIE)?.value;
    await establishOidcSession(identity.authSubject, {
      ...authenticationContext,
      ...(preferredOrganizationId ? { organizationId: preferredOrganizationId } : {}),
      ...(preferredBusinessUnitId ? { businessUnitId: preferredBusinessUnitId } : {}),
    });

    cookieStore.set(OIDC_TRANSACTION_COOKIE, "", {
      httpOnly: true,
      secure: secureCookie,
      sameSite: "lax",
      path: "/api/v1/auth/oidc",
      expires: new Date(0),
    });
    return noStoreRedirect(new URL(safeReturnTo(returnTo), getRuntimeConfig().appUrl));
  } catch (error) {
    cookieStore.set(OIDC_TRANSACTION_COOKIE, "", {
      httpOnly: true,
      secure: secureCookie,
      sameSite: "lax",
      path: "/api/v1/auth/oidc",
      expires: new Date(0),
    });
    // Anonymous callback validation failures are attacker-controlled public noise and
    // must not grow the append-only login-attempt ledger. Once identity is resolved,
    // establishOidcSession records the authoritative success or denial transactionally.
    return toErrorResponse(error, requestId);
  }
}

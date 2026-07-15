import { cookies } from "next/headers";
import {
  OIDC_TRANSACTION_COOKIE,
  OIDC_TRANSACTION_MAX_AGE_SECONDS,
} from "@/server/auth/constants";
import { beginOidc } from "@/server/auth/oidc";
import { safeReturnTo } from "@/server/auth/return-to";
import { getRuntimeConfig } from "@/server/env";
import { requestIdFrom, toErrorResponse } from "@/server/http/errors";
import { noStoreRedirect } from "@/server/http/security";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const requestId = requestIdFrom(request);
  try {
    const config = getRuntimeConfig();
    const returnTo = safeReturnTo(new URL(request.url).searchParams.get("returnTo"));
    if (config.demoMode && config.nodeEnv !== "production") {
      return noStoreRedirect(new URL(returnTo, config.appUrl));
    }

    const { transaction, url } = await beginOidc(returnTo);
    (await cookies()).set(OIDC_TRANSACTION_COOKIE, transaction, {
      httpOnly: true,
      secure: config.nodeEnv === "production",
      sameSite: "lax",
      path: "/api/v1/auth/oidc",
      maxAge: OIDC_TRANSACTION_MAX_AGE_SECONDS,
      priority: "high",
    });
    return noStoreRedirect(url);
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}

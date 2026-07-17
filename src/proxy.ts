import { NextRequest, NextResponse } from "next/server";
import { PRODUCT_REQUEST_PATH_HEADER } from "@/config/product-navigation";
import {
  BUSINESS_SCOPE_QUERY_MAX_BYTES,
  BUSINESS_SCOPE_QUERY_PATTERN,
} from "@/domain/business-units/read-scope";

export function proxy(request: NextRequest) {
  const scopeValues = request.nextUrl.searchParams.getAll("bu");
  if (
    scopeValues.length > 1 ||
    (scopeValues.length === 1 && (
      new TextEncoder().encode(scopeValues[0]!).byteLength > BUSINESS_SCOPE_QUERY_MAX_BYTES ||
      !BUSINESS_SCOPE_QUERY_PATTERN.test(scopeValues[0]!)
    ))
  ) {
    return NextResponse.json(
      { error: { code: "INVALID_SCOPE", message: "Skop syarikat tidak sah." } },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const isDevelopment = process.env.NODE_ENV === "development";
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDevelopment ? " 'unsafe-eval'" : ""}`,
    `style-src 'self' ${isDevelopment ? "'unsafe-inline'" : `'nonce-${nonce}'`}`,
    "img-src 'self' blob: data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "worker-src 'self' blob:",
    ...(isDevelopment ? [] : ["upgrade-insecure-requests"]),
  ];
  const policy = directives.join("; ");
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(PRODUCT_REQUEST_PATH_HEADER, request.nextUrl.pathname);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", policy);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", policy);
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

export const config = {
  matcher: [
    {
      source: "/((?!api|_next/static|_next/image|favicon.ico).*)",
    },
  ],
};

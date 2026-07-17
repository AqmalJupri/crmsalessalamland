import {
  BUSINESS_SCOPE_QUERY_MAX_BYTES,
  BUSINESS_SCOPE_QUERY_PATTERN,
  BusinessScopeError,
} from "./read-scope";

export function parseBusinessScopeQuery(
  raw: string | readonly string[] | null | undefined,
): string | null {
  if (raw === null || raw === undefined) return null;
  if (
    Array.isArray(raw) ||
    typeof raw !== "string" ||
    new TextEncoder().encode(raw).byteLength > BUSINESS_SCOPE_QUERY_MAX_BYTES ||
    !BUSINESS_SCOPE_QUERY_PATTERN.test(raw)
  ) {
    throw new BusinessScopeError("INVALID_SCOPE", "Skop syarikat tidak sah.");
  }
  return raw;
}

export function scopedHref(href: string, scope: string): string {
  const parsedScope = parseBusinessScopeQuery(scope);
  if (!parsedScope) {
    throw new BusinessScopeError("INVALID_SCOPE", "Skop syarikat tidak sah.");
  }
  if (!href.startsWith("/") || href.startsWith("//")) {
    throw new BusinessScopeError("INVALID_SCOPE", "Destinasi tidak sah.");
  }
  const url = new URL(href, "https://scope.invalid");
  if (url.origin !== "https://scope.invalid") {
    throw new BusinessScopeError("INVALID_SCOPE", "Destinasi tidak sah.");
  }
  url.searchParams.set("bu", parsedScope);
  return `${url.pathname}${url.search}${url.hash}`;
}

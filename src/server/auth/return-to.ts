const DEFAULT_RETURN_TO = "/";
const FORBIDDEN_RAW_CHARACTERS = /[\\\u0000-\u001f\u007f]/;
const ENCODED_SEPARATOR_OR_CONTROL = /%(?:2f|5c|0[0-9a-f]|1[0-9a-f]|7f)/i;

function isUnsafePath(value: string): boolean {
  return (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    FORBIDDEN_RAW_CHARACTERS.test(value) ||
    ENCODED_SEPARATOR_OR_CONTROL.test(value)
  );
}

export function safeReturnTo(value: string | null | undefined): string {
  if (!value || isUnsafePath(value)) {
    return DEFAULT_RETURN_TO;
  }

  try {
    const parsed = new URL(value, "https://crm.invalid");
    if (parsed.origin !== "https://crm.invalid") return DEFAULT_RETURN_TO;
    const normalized = `${parsed.pathname}${parsed.search}${parsed.hash}`;
    return isUnsafePath(normalized) ? DEFAULT_RETURN_TO : normalized;
  } catch {
    return DEFAULT_RETURN_TO;
  }
}

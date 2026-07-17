import { ApiError } from "@/server/http/errors";

const POSTGRES_TIMESTAMP_WITH_EXPLICIT_OFFSET =
  /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|([+-])(\d{2})(?::?(\d{2}))?)$/;

function invalidDatabaseTimestamp(): never {
  throw new ApiError(
    500,
    "AUTHORITY_TRANSITION_FAILED",
    "The authority transition could not be completed.",
  );
}

export function parseAuthorityDatabaseTimestamp(value: unknown): Date {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) invalidDatabaseTimestamp();
    return new Date(value.getTime());
  }

  if (typeof value !== "string") invalidDatabaseTimestamp();

  const match = POSTGRES_TIMESTAMP_WITH_EXPLICIT_OFFSET.exec(value);
  if (!match) invalidDatabaseTimestamp();

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const millisecond = Number((match[7] ?? "").padEnd(3, "0").slice(0, 3));
  const offsetSign = match[9];
  const offsetHour = Number(match[10] ?? 0);
  const offsetMinute = Number(match[11] ?? 0);

  if (
    year === 0 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 15 ||
    offsetMinute > 59
  ) {
    invalidDatabaseTimestamp();
  }

  const localTimestamp = new Date(0);
  localTimestamp.setUTCHours(0, 0, 0, 0);
  localTimestamp.setUTCFullYear(year, month - 1, day);
  localTimestamp.setUTCHours(hour, minute, second, millisecond);

  if (
    localTimestamp.getUTCFullYear() !== year ||
    localTimestamp.getUTCMonth() !== month - 1 ||
    localTimestamp.getUTCDate() !== day ||
    localTimestamp.getUTCHours() !== hour ||
    localTimestamp.getUTCMinutes() !== minute ||
    localTimestamp.getUTCSeconds() !== second ||
    localTimestamp.getUTCMilliseconds() !== millisecond
  ) {
    invalidDatabaseTimestamp();
  }

  const signedOffsetMinutes =
    offsetSign === undefined
      ? 0
      : (offsetHour * 60 + offsetMinute) * (offsetSign === "+" ? 1 : -1);
  const parsed = new Date(localTimestamp.getTime() - signedOffsetMinutes * 60_000);

  if (!Number.isFinite(parsed.getTime())) invalidDatabaseTimestamp();
  return parsed;
}

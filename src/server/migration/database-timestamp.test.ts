import { describe, expect, it } from "vitest";
import { parseAuthorityDatabaseTimestamp } from "./database-timestamp";

describe("authority database timestamp decoding", () => {
  it("normalizes every supported explicit PostgreSQL timestamptz offset form", () => {
    for (const value of [
      "2026-07-17 15:00:00+08",
      "2026-07-17 15:00:00+0800",
      "2026-07-17 15:00:00+08:00",
      "2026-07-17T07:00:00Z",
    ]) {
      expect(parseAuthorityDatabaseTimestamp(value).toISOString(), value).toBe(
        "2026-07-17T07:00:00.000Z",
      );
    }
  });

  it("accepts PostgreSQL's maximum offset displacement and rejects the next minute", () => {
    for (const value of [
      "2026-07-17 22:59:00+15:59",
      "2026-07-16 15:01:00-15:59",
    ]) {
      expect(parseAuthorityDatabaseTimestamp(value).toISOString(), value).toBe(
        "2026-07-17T07:00:00.000Z",
      );
    }

    for (const value of [
      "2026-07-17 23:00:00+16:00",
      "2026-07-16 15:00:00-16:00",
    ]) {
      expect(() => parseAuthorityDatabaseTimestamp(value), value).toThrowError(
        expect.objectContaining({ code: "AUTHORITY_TRANSITION_FAILED", status: 500 }),
      );
    }
  });

  it("rejects offset-less and locale-dependent strings", () => {
    for (const value of [
      "2026-07-17 15:00:00",
      "2026-07-17T15:00:00",
      "07/17/2026 15:00:00 GMT+0800",
    ]) {
      expect(() => parseAuthorityDatabaseTimestamp(value), value).toThrowError(
        expect.objectContaining({ code: "AUTHORITY_TRANSITION_FAILED", status: 500 }),
      );
    }
  });

  it("rejects numeric and other non-string runtime values", () => {
    for (const value of [0, Date.now(), 1n, null, undefined, {}]) {
      expect(() => parseAuthorityDatabaseTimestamp(value), String(value)).toThrowError(
        expect.objectContaining({ code: "AUTHORITY_TRANSITION_FAILED", status: 500 }),
      );
    }
  });

  it("rejects invalid Date objects and impossible explicit-offset timestamps safely", () => {
    for (const value of [
      new Date(Number.NaN),
      "2026-02-30 12:00:00+00",
      "2026-07-17 25:00:00+08",
      "2026-07-17 15:00:00+2460",
    ]) {
      let failure: unknown;
      try {
        parseAuthorityDatabaseTimestamp(value);
      } catch (error: unknown) {
        failure = error;
      }
      expect(failure).toMatchObject({ code: "AUTHORITY_TRANSITION_FAILED", status: 500 });
      expect(`${String(failure)} ${JSON.stringify(failure)}`).not.toContain(String(value));
    }
  });
});

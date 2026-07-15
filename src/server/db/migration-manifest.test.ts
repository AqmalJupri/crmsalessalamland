import { describe, expect, it } from "vitest";
import {
  EXPECTED_MIGRATIONS,
  assertMigrationLedgerCurrent,
  assertMigrationSource,
  validateMigrationDirectoryEntries,
} from "./migration-manifest";

const expected = EXPECTED_MIGRATIONS[0]!;

describe("migration manifest", () => {
  it("accepts only the complete zero-padded migration plan", () => {
    expect(validateMigrationDirectoryEntries(["README.md", expected.filename])).toEqual([
      expected.filename,
    ]);
  });

  it.each([
    [["2_second.sql", expected.filename], /zero-padded/i],
    [[expected.filename, "0001_duplicate.sql"], /duplicate migration version/i],
    [["0002_unregistered.sql", expected.filename], /manifest/i],
    [[], /manifest/i],
  ])("rejects an unsafe migration directory: %j", (entries, error) => {
    expect(() => validateMigrationDirectoryEntries(entries)).toThrow(error);
  });

  it("rejects migration source that differs from the reviewed checksum", () => {
    expect(() => assertMigrationSource(expected.filename, "select 1;\n")).toThrow(
      /checksum/i,
    );
  });

  it("accepts only an exact migration ledger", () => {
    expect(() =>
      assertMigrationLedgerCurrent([
        { filename: expected.filename, checksum: expected.checksum },
      ]),
    ).not.toThrow();

    expect(() => assertMigrationLedgerCurrent([])).toThrow(/not current/i);
    expect(() =>
      assertMigrationLedgerCurrent([
        { filename: expected.filename, checksum: "0".repeat(64) },
      ]),
    ).toThrow(/not current/i);
    expect(() =>
      assertMigrationLedgerCurrent([
        { filename: expected.filename, checksum: expected.checksum },
        { filename: "9999_unknown.sql", checksum: "f".repeat(64) },
      ]),
    ).toThrow(/not current/i);
  });
});

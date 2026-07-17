import { describe, expect, it } from "vitest";
import {
  EXPECTED_MIGRATIONS,
  assertMigrationLedgerCurrent,
  assertMigrationSource,
  validateMigrationDirectoryEntries,
} from "./migration-manifest";

const expected = EXPECTED_MIGRATIONS[0]!;
const expectedFilenames = EXPECTED_MIGRATIONS.map(({ filename }) => filename);
const expectedLedger = EXPECTED_MIGRATIONS.map(({ filename, checksum }) => ({
  filename,
  checksum,
}));

describe("migration manifest", () => {
  it("freezes the reviewed manifest and every entry at runtime", () => {
    expect(Object.isFrozen(EXPECTED_MIGRATIONS)).toBe(true);
    expect(EXPECTED_MIGRATIONS.every((migration) => Object.isFrozen(migration))).toBe(true);

    expect(() => {
      const mutable = EXPECTED_MIGRATIONS as unknown as Array<{ filename: string }>;
      mutable[0]!.filename = "9999_mutated.sql";
    }).toThrow(TypeError);
    expect(EXPECTED_MIGRATIONS[0]?.filename).toBe("0001_foundation.sql");
  });

  it("locks the reviewed migration order", () => {
    expect(EXPECTED_MIGRATIONS.map(({ filename }) => filename)).toEqual([
      "0001_foundation.sql",
      "0002_migration_platform.sql",
    ]);
  });

  it("accepts only the complete zero-padded migration plan", () => {
    expect(validateMigrationDirectoryEntries(["README.md", ...expectedFilenames])).toEqual(
      expectedFilenames,
    );
  });

  it.each([
    [["2_second.sql", ...expectedFilenames], /zero-padded/i],
    [[...expectedFilenames, "0001_duplicate.sql"], /duplicate migration version/i],
    [[...expectedFilenames, "9999_unregistered.sql"], /manifest/i],
    [[], /manifest/i],
  ])("rejects an unsafe migration directory: %j", (entries, error) => {
    expect(() => validateMigrationDirectoryEntries(entries)).toThrow(error);
  });

  it("rejects migration source that differs from the reviewed checksum", () => {
    expect(() => assertMigrationSource(expected.filename, Buffer.alloc(expected.byteLength))).toThrow(
      /checksum/i,
    );
  });

  it("rejects migration bytes that differ from the reviewed byte length", () => {
    expect(() => assertMigrationSource(expected.filename, Buffer.from("select 1;\n"))).toThrow(
      /byte length/i,
    );
  });

  it("accepts only an exact migration ledger", () => {
    expect(() => assertMigrationLedgerCurrent(expectedLedger)).not.toThrow();

    expect(() => assertMigrationLedgerCurrent([])).toThrow(/not current/i);
    expect(() =>
      assertMigrationLedgerCurrent(
        expectedLedger.map((row, index) =>
          index === 0 ? { ...row, checksum: "0".repeat(64) } : row,
        ),
      ),
    ).toThrow(/not current/i);
    expect(() =>
      assertMigrationLedgerCurrent([
        ...expectedLedger,
        { filename: "9999_unknown.sql", checksum: "f".repeat(64) },
      ]),
    ).toThrow(/not current/i);
  });
});

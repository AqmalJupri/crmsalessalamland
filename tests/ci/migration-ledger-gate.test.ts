import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  EXPECTED_MIGRATIONS,
  type MigrationLedgerRow,
} from "../../src/server/db/migration-manifest";
import { assertCiMigrationLedgerCurrent } from "../../scripts/ci/verify-migration-ledger";

const expectedLedger = EXPECTED_MIGRATIONS.map(({ filename, checksum }) => ({
  filename,
  checksum,
}));

describe("CI migration ledger gate", () => {
  it("starts under the same CommonJS tsx mode used by CI", () => {
    const result = spawnSync(
      "pnpm",
      ["exec", "tsx", "scripts/ci/verify-migration-ledger.ts"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, DATABASE_URL: "" },
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/DATABASE_URL is required/i);
    expect(result.stderr).not.toMatch(/top-level await/i);
  });

  it("accepts the frozen manifest ledger exactly", () => {
    expect(() => assertCiMigrationLedgerCurrent(expectedLedger)).not.toThrow();
  });

  it.each(
    [
      ["missing", expectedLedger.slice(1)],
      [
        "extra",
        [
          ...expectedLedger,
          { filename: "9999_unreviewed.sql", checksum: "f".repeat(64) },
        ],
      ],
      [
        "divergent",
        expectedLedger.map((row, index) =>
          index === 0 ? { ...row, checksum: "0".repeat(64) } : row,
        ),
      ],
    ] satisfies ReadonlyArray<readonly [string, readonly MigrationLedgerRow[]]>,
  )(
    "rejects a %s database ledger",
    (_label, rows) => {
      expect(() => assertCiMigrationLedgerCurrent(rows)).toThrow(/not current/i);
    },
  );
});

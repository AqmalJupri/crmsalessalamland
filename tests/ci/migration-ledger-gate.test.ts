import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EXPECTED_MIGRATIONS,
  type MigrationLedgerRow,
} from "../../src/server/db/migration-manifest";
import {
  assertCiMigrationLedgerCurrent,
  writeMigrationLedgerEvidence,
} from "../../scripts/ci/verify-migration-ledger";

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

  it("writes canonical exact-ledger evidence without overwriting", async () => {
    const directory = mkdtempSync(join(tmpdir(), "crm-migration-ledger-"));
    const output = join(directory, "migration-ledger.json");
    try {
      await writeMigrationLedgerEvidence(expectedLedger, output);
      expect(readFileSync(output, "utf8")).toBe(
        `${JSON.stringify({ schemaVersion: 1, entries: expectedLedger }, null, 2)}\n`,
      );

      await expect(writeMigrationLedgerEvidence(expectedLedger, output)).rejects.toThrow(
        /already exists/i,
      );
      expect(readFileSync(output, "utf8")).toContain('"schemaVersion": 1');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("validates the ledger before creating output", async () => {
    const directory = mkdtempSync(join(tmpdir(), "crm-migration-ledger-invalid-"));
    const output = join(directory, "migration-ledger.json");
    try {
      writeFileSync(join(directory, "sentinel"), "safe\n", "utf8");
      await expect(
        writeMigrationLedgerEvidence(expectedLedger.slice(1), output),
      ).rejects.toThrow(/not current/i);
      expect(() => readFileSync(output)).toThrow(/ENOENT/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
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

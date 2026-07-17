import { existsSync, readFileSync } from "node:fs";
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
const frozenMigrationPath = new URL(
  "../../../db/migrations/0002_migration_platform.sql",
  import.meta.url,
);
const bytewiseMigrationPath = new URL(
  "../../../db/migrations/0003_reconciliation_bytewise_order.sql",
  import.meta.url,
);
const membershipIdentityMigrationPath = new URL(
  "../../../db/migrations/0004_membership_user_identity_guard.sql",
  import.meta.url,
);
const typedResultTruthMigrationPath = new URL(
  "../../../db/migrations/0005_reconciliation_typed_result_truth.sql",
  import.meta.url,
);
const finiteAmountMigrationPath = new URL(
  "../../../db/migrations/0006_reconciliation_finite_amounts.sql",
  import.meta.url,
);
const frozenMigrationSource = readFileSync(frozenMigrationPath, "utf8");
const bytewiseMigrationSource = existsSync(bytewiseMigrationPath)
  ? readFileSync(bytewiseMigrationPath, "utf8")
  : "";
const membershipIdentityMigrationSource = existsSync(membershipIdentityMigrationPath)
  ? readFileSync(membershipIdentityMigrationPath, "utf8")
  : "";
const typedResultTruthMigrationSource = existsSync(typedResultTruthMigrationPath)
  ? readFileSync(typedResultTruthMigrationPath, "utf8")
  : "";
const finiteAmountMigrationSource = existsSync(finiteAmountMigrationPath)
  ? readFileSync(finiteAmountMigrationPath, "utf8")
  : "";

function reconciliationRequirementGuard(source: string): string {
  const marker = "CREATE OR REPLACE FUNCTION crm_validate_reconciliation_requirements()";
  const start = source.indexOf(marker);
  const end = source.indexOf("\n$$;", start);
  if (start < 0 || end < 0) return "";
  return source.slice(start, end + 4);
}

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
      "0003_reconciliation_bytewise_order.sql",
      "0004_membership_user_identity_guard.sql",
      "0005_reconciliation_typed_result_truth.sql",
      "0006_reconciliation_finite_amounts.sql",
    ]);
  });

  it("replaces only the reconciliation requirement guard with bytewise ordering", () => {
    expect(bytewiseMigrationSource).toContain(
      "CREATE OR REPLACE FUNCTION crm_validate_reconciliation_requirements()",
    );
    expect(bytewiseMigrationSource.match(/COLLATE "C"/g)).toHaveLength(4);
    expect(bytewiseMigrationSource).toContain(
      "digest(convert_to(NEW.required_checks::text, 'UTF8'), 'sha256')",
    );
    expect(bytewiseMigrationSource).not.toMatch(/\b(?:CREATE|ALTER|DROP)\s+TABLE\b/i);
    expect(bytewiseMigrationSource).not.toContain("DROP FUNCTION");
  });

  it("preserves every frozen requirement guard rule except the reviewed ordering correction", () => {
    const localeOrder = `SELECT jsonb_agg(value ORDER BY
           value ->> 'check_kind',
           value ->> 'check_key',
           value ->> 'scope_key',
           value ->> 'measure_unit' NULLS FIRST,
           (value ->> 'decimal_scale')::numeric NULLS FIRST
         )`;
    const bytewiseOrder = `SELECT jsonb_agg(value ORDER BY
           (value ->> 'check_kind') COLLATE "C",
           (value ->> 'check_key') COLLATE "C",
           (value ->> 'scope_key') COLLATE "C",
           (value ->> 'measure_unit') COLLATE "C" NULLS FIRST,
           (value ->> 'decimal_scale')::numeric NULLS FIRST
         )`;
    const expectedReplacement = reconciliationRequirementGuard(frozenMigrationSource)
      .replace(localeOrder, bytewiseOrder)
      .replace("canonical sorted order", "canonical bytewise order");

    expect(reconciliationRequirementGuard(bytewiseMigrationSource)).toBe(expectedReplacement);
  });

  it("adds only the reviewed immutable membership-user identity guard", () => {
    expect(membershipIdentityMigrationSource).toContain(
      "CREATE OR REPLACE FUNCTION crm_guard_membership_user_identity()",
    );
    expect(membershipIdentityMigrationSource).toContain(
      "CREATE TRIGGER memberships_guard_user_identity",
    );
    expect(membershipIdentityMigrationSource).toContain("BEFORE UPDATE OF user_id ON memberships");
    expect(membershipIdentityMigrationSource).not.toMatch(/\b(?:CREATE|ALTER|DROP)\s+TABLE\b/i);
    expect(membershipIdentityMigrationSource).not.toContain("DROP FUNCTION");
  });

  it("adds only the reviewed typed-result truth constraint", () => {
    expect(typedResultTruthMigrationSource).toContain(
      "ADD CONSTRAINT reconciliation_results_derived_pass_truth",
    );
    expect(typedResultTruthMigrationSource).toContain(
      "VALIDATE CONSTRAINT reconciliation_results_derived_pass_truth",
    );
    expect(typedResultTruthMigrationSource).not.toMatch(/\b(?:CREATE|DROP)\s+TABLE\b/i);
    expect(typedResultTruthMigrationSource).not.toContain("DROP CONSTRAINT");
  });

  it("adds only the reviewed finite reconciliation amount constraint", () => {
    expect(finiteAmountMigrationSource).toContain(
      "ADD CONSTRAINT reconciliation_results_finite_amounts",
    );
    expect(finiteAmountMigrationSource).toContain(
      "VALIDATE CONSTRAINT reconciliation_results_finite_amounts",
    );
    expect(finiteAmountMigrationSource).toContain("'NaN', 'Infinity', '-Infinity'");
    expect(finiteAmountMigrationSource).not.toMatch(/\b(?:CREATE|DROP)\s+TABLE\b/i);
    expect(finiteAmountMigrationSource).not.toContain("DROP CONSTRAINT");
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

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

describe("migration CLI", () => {
  it("reports the intentional missing-DATABASE_URL error through the package command", () => {
    const environment = { ...process.env };
    delete environment.DATABASE_URL;

    const result = spawnSync("pnpm", ["db:migrate"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: environment,
      timeout: 10_000,
    });
    const output = `${result.stdout}${result.stderr}`;

    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(output).toContain("DATABASE_URL is required to run migrations.");
    expect(output).not.toMatch(/TransformError|Top-level await/i);
  });
});

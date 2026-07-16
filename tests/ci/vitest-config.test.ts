import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const configSource = readFileSync(`${repositoryRoot}vitest.config.ts`, "utf8");

describe("Vitest source discovery", () => {
  it("keeps UI contract tests in the default test suite", () => {
    const includeSource = configSource.match(/include:\s*\[([\s\S]*?)\]/)?.[1];

    expect(includeSource, "vitest.config.ts must define test.include").toBeDefined();
    expect(includeSource).toContain('"src/**/*.test.ts"');
    expect(includeSource).toContain('"tests/ci/**/*.test.ts"');
    expect(includeSource).toContain('"tests/ui/**/*.test.ts"');
  });
});

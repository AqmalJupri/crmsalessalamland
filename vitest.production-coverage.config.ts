import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "server-only": fileURLToPath(new URL("./tests/stubs/server-only.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: [
      "src/**/*.test.ts",
      "tests/integration/auth-routes.test.ts",
      "tests/integration/migration-platform-schema.test.ts",
      "tests/integration/migration-schema-parity.test.ts",
      "tests/integration/migration-runner.test.ts",
      "tests/integration/migration-source-registration.test.ts",
      "tests/integration/import-batch-service.test.ts",
      "tests/integration/import-row-service.test.ts",
      "tests/integration/import-validation-approval.test.ts",
      "tests/integration/import-apply-service.test.ts",
      "tests/integration/reconciliation-service.test.ts",
      "tests/integration/migration-cli.test.ts",
    ],
    fileParallelism: false,
    testTimeout: 15_000,
    hookTimeout: 30_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      reportsDirectory: "coverage/production",
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.test.{ts,tsx}", "src/**/*.d.ts"],
      thresholds: {
        lines: 62,
        functions: 69,
        branches: 58,
        statements: 62,
      },
    },
  },
});

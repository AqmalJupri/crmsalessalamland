import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: [
      "src/**/*.test.ts",
      "tests/ci/**/*.test.ts",
      "tests/production/**/*.test.mjs",
      "tests/ui/**/*.test.ts",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      reportsDirectory: "coverage/unit",
      // This high-confidence gate is intentionally scoped to code exercised by
      // fast unit/component tests. The separate production-source gate covers
      // every TypeScript production file, including request and DB boundaries.
      include: [
        "src/app/(crm)/layout.tsx",
        "src/app/(crm)/page.tsx",
        "src/app/(crm)/*/page.tsx",
        "src/app/api/v1/leads/route.ts",
        "src/app/api/v1/leads/[id]/route.ts",
        "src/components/**/*.{ts,tsx}",
        "src/domain/**/*.ts",
        "src/lib/demo-crm.ts",
        "src/server/env.ts",
        "src/server/auth/access-policy.ts",
        "src/server/auth/capability-policy.ts",
        "src/server/auth/constants.ts",
        "src/server/auth/crypto.ts",
        "src/server/auth/module-access.ts",
        "src/server/auth/page-access.ts",
        "src/server/auth/return-to.ts",
        "src/server/db/migration-manifest.ts",
        "src/server/db/schema.ts",
        "src/server/db/singleton-resource.ts",
        "src/server/health/readiness.ts",
        "src/server/http/errors.ts",
        "src/server/leads/assignment-policy.ts",
        "src/server/leads/identity-resolution.ts",
        "src/server/leads/schemas.ts",
        "src/server/leads/stage-policy.ts",
      ],
      // Viewer resolution is a request/DB boundary covered by the PostgreSQL
      // auth suite and production runtime smoke; unit coverage would measure
      // mocked framework/database plumbing instead of its authorization paths.
      exclude: ["src/**/*.test.{ts,tsx}", "src/server/auth/viewer.ts"],
      thresholds: {
        lines: 85,
        functions: 85,
        branches: 80,
        statements: 85,
      },
    },
  },
});

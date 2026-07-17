import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const crmRoot = resolve(process.cwd(), "src/components/crm");

describe("CRM component server-boundary contract", () => {
  it.each(["metric.tsx", "surface-home.tsx"])(
    "%s does not pull a server auth module into the component graph",
    (filename) => {
      const source = readFileSync(resolve(crmRoot, filename), "utf8");
      expect(source).not.toMatch(/from\s+["']@\/server\//);
    },
  );

  it.each(["leads-workspace.tsx", "pipeline-workspace.tsx"])(
    "%s accepts only the minimal client business scope",
    (filename) => {
      const source = readFileSync(resolve(crmRoot, filename), "utf8");
      expect(source).toContain("ClientBusinessScope");
      expect(source).not.toContain("BusinessUnitReadScope");
      expect(source).not.toMatch(/from\s+["']@\/server\//);
      expect(source).not.toMatch(/membershipIds|capabilityRecordScopes|recordScopes|\.capabilities/);
    },
  );
});

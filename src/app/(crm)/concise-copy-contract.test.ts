import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

const shellSource = [
  "src/components/crm/topbar.tsx",
  "src/components/crm/app-shell.tsx",
].map(source).join("\n");
const operationalSource = source("src/components/crm/operational-module.tsx");
const leadSource = source("src/components/crm/leads-workspace.tsx");
const dashboardSource = source("src/components/crm/surface-home.tsx");
const productCopySource = [
  dashboardSource,
  "finance", "inventory", "marketing", "orders", "reports", "settings", "tasks", "team",
].map((value) => value.includes("\n") ? value : source(`src/app/(crm)/${value}/page.tsx`)).join("\n");
const styleSource = [source("src/styles/theme.css"), source("src/styles/product.css")].join("\n");

describe("concise operational copy contract", () => {
  it("keeps the shell to one title without eyebrow or description APIs", () => {
    expect(shellSource).not.toMatch(/\beyebrow\b|topbarEyebrow|topbarDescription/);
  });

  it("rejects generic subtitles, notes, motivational copy, and empty labels", () => {
    expect(productCopySource).not.toMatch(
      /Belum ada data\.|ringkasan pantas|nota penting|selamat datang|tingkatkan prestasi|mari capai sasaran/i,
    );
  });

  it("rejects decorative emoji and gradients from the operational surface", () => {
    expect([shellSource, operationalSource, leadSource, dashboardSource].join("\n"))
      .not.toMatch(/\p{Extended_Pictographic}/u);
    expect(styleSource).not.toMatch(/(?:linear|radial|conic)-gradient\s*\(/i);
  });

  it("rejects a generic card whose only child surface is a table", () => {
    const genericTableWrapper = /<CardContent className="crm-card-content--flush">\s*<Table/;
    expect(operationalSource).not.toMatch(genericTableWrapper);
    expect(leadSource).not.toMatch(genericTableWrapper);
    expect(dashboardSource).not.toMatch(genericTableWrapper);
  });
});

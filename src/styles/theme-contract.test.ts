import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const stylesRoot = fileURLToPath(new URL("./", import.meta.url));
const themeSource = readFileSync(`${stylesRoot}theme.css`, "utf8");
const productSource = readFileSync(`${stylesRoot}product.css`, "utf8");

const primaryRoles = {
  "--crm-canvas": "#f8fafc",
  "--crm-surface": "#ffffff",
  "--crm-sidebar": "#0b172a",
  "--crm-sidebar-raised": "#1e293b",
  "--crm-text": "#1e293b",
  "--crm-muted": "#64748b",
  "--crm-divider": "#e2e8f0",
  "--crm-action": "#2563eb",
  "--crm-action-hover": "#1d4ed8",
  "--crm-brand-attention": "#f59e0b",
} as const;

const accessibilityRoles = {
  "--crm-control-border": "#64748b",
  "--crm-sidebar-text": "#f8fafc",
  "--crm-sidebar-muted": "#cbd5e1",
  "--crm-focus-ring": "#2563eb",
  "--crm-success": "#15803d",
  "--crm-success-surface": "#f0fdf4",
  "--crm-danger": "#b91c1c",
  "--crm-danger-surface": "#fef2f2",
  "--crm-warning-text": "#78350f",
  "--crm-warning-surface": "#fffbeb",
} as const;

function extractRoot(source: string) {
  const match = source.match(/^:root\s*\{([\s\S]*?)\n\}/);
  expect(match, "theme.css must start with a :root token declaration block").not.toBeNull();
  return { body: match?.[1] ?? "", full: match?.[0] ?? "" };
}

function declarations(block: string) {
  return new Map(
    [...block.matchAll(/^\s*(--[\w-]+)\s*:\s*([^;]+);/gm)].map((match) => [
      match[1] ?? "",
      (match[2] ?? "").trim().toLowerCase(),
    ]),
  );
}

function cssRule(source: string, selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  expect(match, `${selector} must exist`).not.toBeNull();
  return match?.[1] ?? "";
}

function atRule(source: string, header: string) {
  const start = source.indexOf(header);
  expect(start, `${header} must exist`).toBeGreaterThanOrEqual(0);
  const openingBrace = source.indexOf("{", start);
  expect(openingBrace, `${header} must open a block`).toBeGreaterThan(start);

  let depth = 0;
  for (let index = openingBrace; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(openingBrace + 1, index);
  }

  throw new Error(`${header} must close its block`);
}

function selectorsUsing(source: string, token: string) {
  return [...source.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((match) => match[2]?.includes(`var(${token})`))
    .map((match) => (match[1] ?? "").trim());
}

describe("CRM semantic theme contract", () => {
  const root = extractRoot(themeSource);
  const tokens = declarations(root.body);

  it("declares the exact approved primary and accessibility roles", () => {
    for (const [name, value] of Object.entries({ ...primaryRoles, ...accessibilityRoles })) {
      expect(tokens.get(name), name).toBe(value);
    }
  });

  it("keeps all color literals in the root token authority", () => {
    const implementationCss = `${themeSource.replace(root.full, "")}\n${productSource}`;

    expect(implementationCss).not.toMatch(/#[\da-f]{3,8}\b|rgba?\s*\(/i);
    expect(`${themeSource}\n${productSource}`).not.toMatch(
      /--crm-(?:amber|green|field|ink|line)(?:\b|-)/,
    );
  });

  it("uses action roles for primary controls and limits brand attention by purpose", () => {
    const primary = cssRule(themeSource, ".crm-button--primary");
    const primaryHover = cssRule(themeSource, ".crm-button--primary:hover:not(:disabled)");

    expect(primary).toMatch(/background:\s*var\(--crm-action\)/);
    expect(primary).toMatch(/color:\s*var\(--crm-on-action\)/);
    expect(primaryHover).toMatch(/background:\s*var\(--crm-action-hover\)/);

    const attentionSelectors = [
      ...selectorsUsing(themeSource.replace(root.full, ""), "--crm-brand-attention"),
      ...selectorsUsing(productSource, "--crm-brand-attention"),
    ];
    expect(attentionSelectors.length).toBeGreaterThan(0);
    for (const selector of attentionSelectors) {
      expect(selector, "brand attention is reserved for brand or warning affordances").toMatch(
        /brand|warning|priority|login-card__mark/,
      );
    }
  });

  it("uses compact controls, an accessible coarse-pointer target, and bounded radii", () => {
    expect(tokens.get("--crm-control-sm")).toBe("2.25rem");
    expect(tokens.get("--crm-control")).toBe("2.375rem");
    expect(tokens.get("--crm-control-lg")).toBe("2.5rem");

    for (const name of ["--crm-radius", "--crm-radius-sm"] as const) {
      const radius = Number.parseFloat(tokens.get(name) ?? "0");
      expect(radius, name).toBeGreaterThanOrEqual(8);
      expect(radius, name).toBeLessThanOrEqual(12);
    }

    for (const [name, value] of tokens) {
      if (!name.startsWith("--crm-space-")) continue;
      const pixels = Number.parseFloat(value) * (value.endsWith("rem") ? 16 : 1);
      expect(pixels % 4, name).toBe(0);
    }

    const spacingDeclarations = `${themeSource}\n${productSource}`.matchAll(
      /^\s*(gap|padding(?:-[\w-]+)?|margin(?:-[\w-]+)?):\s*([^;]+);/gm,
    );
    for (const [, property = "spacing", value = ""] of spacingDeclarations) {
      for (const unit of value.matchAll(/(-?[\d.]+)(rem|px)/g)) {
        const numericValue = Number(unit[1]);
        if (numericValue === 0 || (numericValue === -1 && unit[2] === "px")) continue;
        const pixels = numericValue * (unit[2] === "rem" ? 16 : 1);
        expect(Math.round(pixels * 1000) % 4000, `${property}: ${value}`).toBe(0);
      }
    }

    const coarsePointer = atRule(themeSource, "@media (pointer: coarse)");
    expect(coarsePointer).toContain("min-height: 44px");
    expect(coarsePointer).toContain("width: 44px");
  });

  it("keeps numeric operational values aligned and removes the login grid", () => {
    for (const selector of [
      ".crm-table",
      ".crm-metric__value",
      ".crm-sidebar__nav-count",
      ".crm-cell-money",
    ]) {
      const source = selector === ".crm-cell-money" ? productSource : themeSource;
      expect(cssRule(source, selector)).toContain("font-variant-numeric: tabular-nums");
    }

    expect(cssRule(productSource, ".crm-login-page")).not.toMatch(/gradient/i);
  });

  it("eliminates animation and transition duration under reduced motion", () => {
    const reducedTheme = atRule(themeSource, "@media (prefers-reduced-motion: reduce)");
    const reducedProduct = atRule(productSource, "@media (prefers-reduced-motion: reduce)");

    expect(reducedTheme).toContain("animation: none !important");
    expect(reducedTheme).toContain("transition-duration: 0ms !important");
    expect(`${reducedTheme}\n${reducedProduct}`).not.toMatch(
      /animation-duration:\s*(?!0(?:ms|s)\b)[\d.]+(?:ms|s)/,
    );
  });
});

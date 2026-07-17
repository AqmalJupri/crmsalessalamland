import { readFileSync, readdirSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const stylesRoot = fileURLToPath(new URL("./", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const themeSource = readFileSync(`${stylesRoot}theme.css`, "utf8");
const productSource = readFileSync(`${stylesRoot}product.css`, "utf8");

type ProductionSource = {
  path: string;
  source: string;
};

const approvedBrowserMetadataColors = {
  themeColor: "#0B172A",
  theme_color: "#0B172A",
  background_color: "#F8FAFC",
} as const;

const approvedBrowserMetadataFiles = {
  themeColor: ["src/app/layout.tsx"],
  theme_color: ["src/app/manifest.ts"],
  background_color: ["src/app/manifest.ts"],
} as const;

const browserMetadataDeclaration = new RegExp(
  `\\b(${Object.keys(approvedBrowserMetadataColors).join("|")})\\s*:\\s*["'](#[\\dA-Fa-f]{6})["']`,
  "g",
);

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

function rulesUsing(source: string, token: string) {
  return [...source.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((match) => match[2]?.includes(`var(${token})`))
    .map((match) => ({
      body: match[2] ?? "",
      selector: (match[1] ?? "").trim(),
    }));
}

function productionSources(directory: string): ProductionSource[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__") return [];
      return productionSources(path);
    }
    if (/\.(?:test|spec)\./.test(entry.name)) return [];
    if (![".css", ".ts", ".tsx"].includes(extname(entry.name))) return [];
    return [
      {
        path: relative(repositoryRoot, path).replaceAll("\\", "/"),
        source: readFileSync(path, "utf8"),
      },
    ];
  });
}

function bracedRange(source: string, marker: string) {
  const start = source.indexOf(marker);
  expect(start, `${marker} must exist`).toBeGreaterThanOrEqual(0);
  const openingBrace = source.indexOf("{", start);
  expect(openingBrace, `${marker} must open a block`).toBeGreaterThan(start);

  let depth = 0;
  for (let index = openingBrace; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return { start: openingBrace, end: index };
  }

  throw new Error(`${marker} must close its block`);
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isSatisfiesExpression(expression)
  ) {
    return unwrapExpression(expression.expression);
  }
  return expression;
}

function propertyNameText(name: ts.PropertyName | undefined) {
  if (name && (ts.isIdentifier(name) || ts.isStringLiteral(name))) return name.text;
  return undefined;
}

function manifestMetadataPropertyRanges(file: ProductionSource) {
  const sourceFile = ts.createSourceFile(
    file.path,
    file.source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const manifestFunction = sourceFile.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === "manifest" &&
      (statement.modifiers?.some(({ kind }) => kind === ts.SyntaxKind.ExportKeyword) ?? false) &&
      (statement.modifiers?.some(({ kind }) => kind === ts.SyntaxKind.DefaultKeyword) ?? false),
  );

  expect(manifestFunction, `${file.path} must default-export function manifest`).toBeDefined();
  expect(manifestFunction?.body, `${file.path} manifest must have a function body`).toBeDefined();
  const returnStatements = manifestFunction?.body?.statements.filter(ts.isReturnStatement) ?? [];
  expect(returnStatements, `${file.path} manifest must directly return one object`).toHaveLength(1);
  const returnedExpression = returnStatements[0]?.expression;
  expect(returnedExpression, `${file.path} manifest must return a value`).toBeDefined();
  const returnedObject = returnedExpression ? unwrapExpression(returnedExpression) : undefined;
  expect(
    returnedObject && ts.isObjectLiteralExpression(returnedObject),
    `${file.path} manifest must directly return an object literal`,
  ).toBe(true);
  if (!returnedObject || !ts.isObjectLiteralExpression(returnedObject)) return [];

  const ranges: Array<{
    end: number;
    field: "theme_color" | "background_color";
    start: number;
  }> = [];
  const seen = new Set<string>();
  for (const property of returnedObject.properties) {
    const name = propertyNameText("name" in property ? property.name : undefined);
    if (name !== "theme_color" && name !== "background_color") continue;

    expect(
      ts.isPropertyAssignment(property),
      `${file.path} ${name} must be a direct property assignment`,
    ).toBe(true);
    if (!ts.isPropertyAssignment(property)) continue;
    const initializer = unwrapExpression(property.initializer);
    expect(
      ts.isStringLiteralLike(initializer),
      `${file.path} ${name} must use an exact string literal`,
    ).toBe(true);
    if (!ts.isStringLiteralLike(initializer)) continue;
    expect(initializer.text, `${file.path} ${name} must equal its exact PRD token`).toBe(
      approvedBrowserMetadataColors[name],
    );
    expect(seen.has(name), `${file.path} must not duplicate ${name}`).toBe(false);
    seen.add(name);
    ranges.push({
      end: property.getEnd(),
      field: name,
      start: property.getStart(sourceFile),
    });
  }

  return ranges;
}

function withoutApprovedBrowserMetadataColors(file: ProductionSource) {
  const declarations = [...file.source.matchAll(browserMetadataDeclaration)];
  const viewportRange =
    file.path === "src/app/layout.tsx"
      ? bracedRange(file.source, "export const viewport")
      : undefined;
  const manifestProperties =
    file.path === "src/app/manifest.ts" ? manifestMetadataPropertyRanges(file) : [];

  for (const declaration of declarations) {
    const field = declaration[1] as keyof typeof approvedBrowserMetadataColors;
    const value = declaration[2] ?? "";
    const allowedFiles: readonly string[] = approvedBrowserMetadataFiles[field];
    expect(allowedFiles, `${file.path}: ${field} is metadata-only`).toContain(file.path);
    if (viewportRange) {
      expect(declaration.index, `${file.path}: ${field} must stay inside Viewport metadata`).toBeGreaterThan(
        viewportRange.start,
      );
      expect(declaration.index, `${file.path}: ${field} must stay inside Viewport metadata`).toBeLessThan(
        viewportRange.end,
      );
    }
    if (file.path === "src/app/manifest.ts") {
      const property = manifestProperties.find(
        ({ end, field: propertyField, start }) =>
          propertyField === field &&
          (declaration.index ?? -1) >= start &&
          (declaration.index ?? -1) < end,
      );
      expect(
        property,
        `${file.path}: ${field} must be a direct property of manifest's returned object`,
      ).toBeDefined();
    }
    expect(value, `${file.path}: ${field} must equal its exact PRD token`).toBe(
      approvedBrowserMetadataColors[field],
    );
  }

  return file.source.replace(browserMetadataDeclaration, (declaration, _field, value) =>
    declaration.replace(value, "approved-browser-metadata-token"),
  );
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
    const sources = productionSources(`${repositoryRoot}src`);
    expect(sources.map(({ path }) => path)).toEqual(
      expect.arrayContaining([
        "src/app/layout.tsx",
        "src/proxy.ts",
        "src/styles/product.css",
      ]),
    );

    for (const file of sources) {
      const sourceWithoutAuthority =
        file.path === "src/styles/theme.css"
          ? file.source.replace(root.full, "")
          : withoutApprovedBrowserMetadataColors(file);

      expect(sourceWithoutAuthority, file.path).not.toMatch(/#[\da-f]{3,8}\b|rgba?\s*\(/i);
      expect(file.source, file.path).not.toMatch(
        /--crm-(?:amber|green|field|ink|line)(?:\b|-)/,
      );
    }
  });

  it("keeps browser metadata color exceptions exact and out of style contexts", () => {
    const layout = productionSources(`${repositoryRoot}src`).find(
      ({ path }) => path === "src/app/layout.tsx",
    );
    expect(layout).toBeDefined();
    expect(withoutApprovedBrowserMetadataColors(layout as ProductionSource)).not.toMatch(
      /#[\da-f]{3,8}\b|rgba?\s*\(/i,
    );

    const manifest = {
      path: "src/app/manifest.ts",
      source: `export default function manifest() {
  return {
    theme_color: "#0B172A",
    background_color: "#F8FAFC",
  };
}`,
    } satisfies ProductionSource;
    expect(withoutApprovedBrowserMetadataColors(manifest)).not.toMatch(
      /#[\da-f]{3,8}\b|rgba?\s*\(/i,
    );

    for (const file of [
      {
        path: "src/components/rogue.tsx",
        source: 'const rogue = <div style={{ themeColor: "#0B172A" }} />;',
      },
      {
        path: "src/styles/rogue.css",
        source: '.rogue { themeColor: "#0B172A"; }',
      },
      {
        path: "src/app/layout.tsx",
        source:
          'export const viewport = { background_color: "#F8FAFC" }; export default null;',
      },
      {
        path: "src/app/manifest.ts",
        source: `const rogue = { theme_color: "#0B172A" };
export default function manifest() {
  return { background_color: "#F8FAFC" };
}`,
      },
      {
        path: "src/app/manifest.ts",
        source: `const note = 'theme_color: "#0B172A"';
export default function manifest() {
  return { background_color: "#F8FAFC" };
}`,
      },
      {
        path: "src/app/manifest.ts",
        source: `export default function manifest() {
  return {
    appearance: { theme_color: "#0B172A" },
    background_color: "#F8FAFC",
  };
}`,
      },
      {
        path: "src/app/manifest.ts",
        source: 'export default { theme_color: "#0b172a" };',
      },
    ] satisfies ProductionSource[]) {
      expect(() => withoutApprovedBrowserMetadataColors(file), file.path).toThrow();
    }
  });

  it("uses action roles for primary controls and limits brand attention by purpose", () => {
    const primary = cssRule(themeSource, ".crm-button--primary");
    const primaryHover = cssRule(themeSource, ".crm-button--primary:hover:not(:disabled)");

    expect(primary).toMatch(/background:\s*var\(--crm-action\)/);
    expect(primary).toMatch(/color:\s*var\(--crm-on-action\)/);
    expect(primaryHover).toMatch(/background:\s*var\(--crm-action-hover\)/);

    const attentionRules = [
      ...rulesUsing(themeSource.replace(root.full, ""), "--crm-brand-attention"),
      ...rulesUsing(productSource, "--crm-brand-attention"),
    ];
    expect(attentionRules.length).toBeGreaterThan(0);
    for (const { body, selector } of attentionRules) {
      expect(selector, "brand attention is reserved for brand or warning affordances").toMatch(
        /brand|warning|priority|login-card__mark/,
      );
      expect(body, `${selector} must use attention as its background`).toMatch(
        /background:\s*var\(--crm-brand-attention\)/,
      );
      expect(body, `${selector} must pair attention with its dark foreground`).toMatch(
        /color:\s*var\(--crm-warning-text\)/,
      );
    }
  });

  it("keeps inherited form typography from overriding component foreground roles", () => {
    const inheritedFormControl = cssRule(
      themeSource,
      ".crm-theme :where(button, input, select, textarea)",
    );

    expect(inheritedFormControl).toMatch(/color:\s*inherit/);
    expect(inheritedFormControl).toMatch(/font:\s*inherit/);
    expect(themeSource).not.toMatch(
      /\.crm-theme button,\s*\.crm-theme input,\s*\.crm-theme select,\s*\.crm-theme textarea\s*\{[^}]*color:\s*inherit/,
    );
  });

  it("binds action blue to selection and keeps informational badges neutral", () => {
    const selectedTab = cssRule(productSource, '.crm-tab[aria-selected="true"]');
    const currentNavigation = cssRule(
      themeSource,
      '.crm-sidebar__nav-link[aria-current="page"]',
    );
    const informationalBadge = cssRule(themeSource, ".crm-badge--info");

    for (const rule of [selectedTab, currentNavigation]) {
      expect(rule).toMatch(/background:\s*var\(--crm-action\)/);
      expect(rule).toMatch(/color:\s*var\(--crm-on-action\)/);
    }

    expect(informationalBadge).toMatch(/border-color:\s*var\(--crm-divider\)/);
    expect(informationalBadge).toMatch(/background:\s*var\(--crm-surface-subtle\)/);
    expect(informationalBadge).toMatch(/color:\s*var\(--crm-text\)/);
    expect(informationalBadge).not.toMatch(/--crm-(?:action|focus|info)(?:\b|-)/);
    for (const token of ["--crm-info", "--crm-info-surface", "--crm-info-border"]) {
      expect(tokens.has(token), `${token} must not create a second blue role`).toBe(false);
    }
  });

  it("keeps generic empty-state icons neutral instead of implying success", () => {
    const emptyStateIcon = cssRule(productSource, ".crm-empty-action svg");

    expect(emptyStateIcon).toMatch(/color:\s*var\(--crm-muted\)/);
    expect(emptyStateIcon).not.toMatch(
      /--crm-(?:success|action|danger|brand-attention|warning)(?:\b|-)/,
    );
  });

  it("gives the record button a compact desktop height and a 44px coarse target", () => {
    const recordLink = cssRule(productSource, ".crm-record-link");
    const coarsePointer = atRule(themeSource, "@media (pointer: coarse)");

    expect(recordLink).toMatch(/display:\s*inline-flex/);
    expect(recordLink).toMatch(/min-height:\s*var\(--crm-control-sm\)/);
    expect(coarsePointer).toContain(".crm-record-link");
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

  it("anchors the company listbox and keeps KPI provenance compact but visible", () => {
    const switcher = cssRule(themeSource, ".crm-business-unit-switcher");
    const menu = cssRule(themeSource, ".crm-business-unit-switcher__menu");
    const option = cssRule(themeSource, ".crm-business-unit-switcher__menu button");
    const metricScope = cssRule(themeSource, ".crm-metric__scope");
    const metricLink = cssRule(themeSource, ".crm-metric__value a");

    expect(switcher).toContain("position: relative");
    expect(menu).toContain("position: absolute");
    expect(menu).toMatch(/background:\s*var\(--crm-sidebar-raised\)/);
    expect(menu).toMatch(/box-shadow:\s*var\(--crm-shadow-overlay\)/);
    expect(menu).toContain("overscroll-behavior: contain");
    expect(option).toContain("display: flex");
    expect(metricScope).toMatch(/border-top:\s*1px solid var\(--crm-divider\)/);
    expect(metricScope).toMatch(/font-size:\s*0\.6875rem/);
    expect(metricLink).toContain("color: inherit");

    const coarsePointer = atRule(themeSource, "@media (pointer: coarse)");
    expect(coarsePointer).toContain(".crm-business-unit-switcher__menu button");
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

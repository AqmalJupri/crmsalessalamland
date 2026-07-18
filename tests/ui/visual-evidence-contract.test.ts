import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  computeVisualReferenceLock,
  computeVisualComparisonBinding,
  computeVisualSourceBinding,
  type VisualSourceBinding,
} from "../../scripts/ci/visual-baseline-binding";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const snapshotsRoot = join(repositoryRoot, "tests/e2e/__snapshots__");
const provenancePath = join(snapshotsRoot, "provenance.json");
const visualSpecPath = join(repositoryRoot, "tests/e2e/ui-visual.spec.ts");
const visualStylePath = join(repositoryRoot, "tests/e2e/visual-snapshot.css");
const provenanceWriterPath = join(
  repositoryRoot,
  "scripts/ci/write-visual-baseline-provenance.ts",
);
const screenReaderPath = join(
  repositoryRoot,
  "docs/design/evidence/ui-foundation-screen-reader.md",
);
const workflowPath = join(repositoryRoot, ".github/workflows/quality.yml");

const screenshotProjects = {
  "mobile-chromium-320x800": 320,
  "mobile-chromium-390x844": 390,
  "desktop-chromium-768x1024": 768,
  "desktop-chromium-1024x768": 1024,
  "desktop-chromium-1440x900": 1440,
} as const;

const scenes = {
  crm: [
    "login",
    "crm-dashboard",
    "crm-leads",
    "crm-pipeline",
    "company-switcher",
    "crm-integrations-unknown",
    "operation-states",
  ],
  tasha: [
    "login",
    "tasha-home",
    "tasha-inventory",
    "company-switcher",
    "operation-states",
  ],
} as const;

interface VisualProvenance {
  schemaVersion: number;
  sourceCommit: string;
  sourceBinding: VisualSourceBinding;
  comparisonBinding: VisualSourceBinding;
  syntheticOnly: boolean;
  dynamicData: string;
  capture: {
    os: string;
    runnerImage: string;
    runnerArch: string;
    playwrightVersion: string;
    browserName: string;
    browserVersion: string;
  };
  review: {
    status: string;
    referenceLock: string;
    reviewer: string;
  };
  assets: Record<string, string>;
}

function readRequired(path: string): string {
  expect(existsSync(path), `${relative(repositoryRoot, path)} must exist`).toBe(true);
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function filesRecursively(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesRecursively(path) : [path];
  });
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function pngDimensions(path: string): { width: number; height: number } {
  const bytes = readFileSync(path);
  expect(bytes.subarray(0, 8).toString("hex"), path).toBe("89504e470d0a1a0a");
  expect(bytes.subarray(12, 16).toString("ascii"), path).toBe("IHDR");
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  };
}

function expectedAssets(): string[] {
  return Object.entries(scenes).flatMap(([surface, surfaceScenes]) =>
    Object.keys(screenshotProjects).flatMap((project) =>
      surfaceScenes.map(
        (scene) => `${surface}/ui-visual.spec.ts/${project}/${scene}.png`,
      ),
    ),
  ).sort();
}

function screenshotStringOptionEvidence(
  source: string,
  optionName: string,
): { callCount: number; unresolved: boolean; values: string[] } {
  const sourceFile = ts.createSourceFile(
    "ui-visual.spec.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  let callCount = 0;
  let unresolved = false;
  const values: string[] = [];

  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "toHaveScreenshot"
    ) {
      callCount += 1;
      const options = node.arguments.at(-1);
      if (!options || !ts.isObjectLiteralExpression(options)) {
        unresolved = true;
      } else {
        for (const property of options.properties) {
          if (ts.isSpreadAssignment(property)) {
            unresolved = true;
            continue;
          }
          if (ts.isComputedPropertyName(property.name)) {
            unresolved = true;
            continue;
          }
          const name = property.name.text;
          if (name !== optionName) continue;
          if (!ts.isPropertyAssignment(property)) {
            unresolved = true;
            continue;
          }
          if (!ts.isStringLiteralLike(property.initializer)) {
            unresolved = true;
            continue;
          }
          values.push(property.initializer.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return { callCount, unresolved, values };
}

describe("UI visual evidence contract", () => {
  it("parses quoted screenshot option keys and fails closed on unresolved spreads", () => {
    expect(
      screenshotStringOptionEvidence(
        'expect(page).toHaveScreenshot("scene.png", { "caret": "hide" });',
        "caret",
      ),
    ).toEqual({ callCount: 1, unresolved: false, values: ["hide"] });
    expect(
      screenshotStringOptionEvidence(
        'expect(page).toHaveScreenshot("scene.png", { ...options, caret: "initial" });',
        "caret",
      ),
    ).toEqual({ callCount: 1, unresolved: true, values: ["initial"] });
    expect(
      screenshotStringOptionEvidence(
        'expect(page).toHaveScreenshot("scene.png", { caret: "initial", get caret() { return "hide"; } });',
        "caret",
      ),
    ).toEqual({ callCount: 1, unresolved: true, values: ["initial"] });
  });

  it("loads the provenance writer through the repository TSX CommonJS contract", () => {
    const result = spawnSync("pnpm", ["exec", "tsx", provenanceWriterPath], {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_SHA: "",
        ImageOS: "",
        RUNNER_ARCH: "",
        VISUAL_BASELINE_CAPTURE: "",
      },
    });
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).not.toMatch(/top-level await|transform failed/i);
    expect(output).toContain(
      process.platform === "linux"
        ? "VISUAL_BASELINE_CAPTURE must be exactly reviewed-linux."
        : "Visual baseline provenance can only be produced by Linux.",
    );
  });

  it("loads the executable visual spec in Playwright's CommonJS transform mode", () => {
    const result = spawnSync(
      "pnpm",
      ["exec", "playwright", "test", "tests/e2e/ui-visual.spec.ts", "--list"],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          APP_URL: "http://127.0.0.1:3201",
          DATABASE_URL:
            "postgresql://crm:crm_local_only@127.0.0.1:5432/crm_salam_codex_ui",
          DEPLOYMENT_ENVIRONMENT: "local",
          E2E_PORT: "3201",
          E2E_PRODUCT_SURFACE: "crm",
          PRODUCT_SURFACE: "crm",
        },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/Total: [1-9]\d* tests? in 1 file/);
    expect(result.stderr).not.toMatch(/import\.meta|failed to load the ES module/i);
  });

  it("defines only reviewed five-width scenes with explicit antialiasing tolerance", () => {
    const source = readRequired(visualSpecPath);
    const style = readRequired(visualStylePath);

    expect(source).toContain('process.platform !== "linux"');
    expect(source).toContain('test.use({ serviceWorkers: "block" })');
    for (const project of Object.keys(screenshotProjects)) expect(source).toContain(project);
    expect(source).not.toContain("mobile-chromium-375x812");
    expect(source).not.toContain("desktop-chromium-1280x800");
    for (const surfaceScenes of Object.values(scenes)) {
      for (const scene of surfaceScenes) expect(source).toContain(`"${scene}"`);
    }
    expect(source).toContain("toHaveScreenshot");
    expect(source).toMatch(/animations:\s*"disabled"/);
    expect(screenshotStringOptionEvidence(source, "caret")).toEqual({
      callCount: 1,
      unresolved: false,
      values: ["initial"],
    });
    expect(source).toContain('page.on("console"');
    expect(source).toContain("hydrationMismatchCount");
    expect(source).toContain("hydration-mismatch");
    expect(source).toContain("server rendered html didn't match");
    expect(source).toMatch(/maxDiffPixels:\s*100/);
    expect(source).toMatch(/threshold:\s*0\.1/);
    expect(source).toMatch(/fullPage:\s*true/);
    expect(source).toContain("visual-snapshot.css");
    expect(source).toContain("computeVisualSourceBinding");
    expect(source).toContain("computeVisualReferenceLock");
    expect(source).toContain("computeVisualComparisonBinding");
    expect(source).toContain("browser.version()");
    expect(style).toContain("nextjs-portal");
    expect(style).toMatch(/caret-color:\s*transparent\s*!important/);
  });

  it("keeps baseline capture manual, Linux-only, synthetic, and separate from normal comparison", () => {
    const workflow = readRequired(workflowPath);

    expect(workflow).toMatch(/workflow_dispatch:[\s\S]*capture_visual_baselines:/);
    expect(workflow).toContain("Capture reviewed Linux visual baselines");
    expect(workflow).toContain("VISUAL_BASELINE_CAPTURE: reviewed-linux");
    expect(workflow).toContain("tests/e2e/ui-visual.spec.ts --update-snapshots");
    expect(workflow).toContain("visual-baseline-candidates-${{ github.sha }}");
    expect(workflow).toContain("retention-days: 1");

    const normalStep = workflow.slice(
      workflow.indexOf("- name: Run isolated CRM and Tasha browser evidence"),
      workflow.indexOf("- name: Capture reviewed Linux visual baselines"),
    );
    expect(normalStep).toContain("pnpm test:e2e");
    expect(normalStep).not.toContain("--update-snapshots");
  });

  it("requires the named human screen-reader sheet to remain explicitly unsigned", () => {
    const evidence = readRequired(screenReaderPath);

    expect(evidence).toContain("Status: PENDING HUMAN SIGN-OFF");
    for (const journey of [
      "Log masuk",
      "Navigasi",
      "Skop syarikat",
      "Lead: cipta, ralat dan buang perubahan",
      "Pengumuman status operasi",
      "Menu pengguna",
      "Log keluar",
    ]) {
      expect(evidence).toContain(journey);
    }
    for (const field of [
      "Reviewer manusia",
      "Tarikh",
      "OS",
      "Browser",
      "Screen reader dan versi",
    ]) {
      expect(evidence).toContain(field);
    }
    expect(evidence).toContain("Automasi Axe tidak menggantikan semakan ini");
  });

  it.skipIf(process.env.VISUAL_CAPTURE_REQUESTED === "true")(
    "registers exactly the reviewed Linux PNGs by digest and viewport width",
    () => {
      const raw = readRequired(provenancePath);
      const provenance = JSON.parse(raw) as VisualProvenance;
      const expected = expectedAssets();
      const pngs = filesRecursively(snapshotsRoot)
        .filter((path) => extname(path) === ".png")
        .map((path) => relative(snapshotsRoot, path).replaceAll("\\", "/"))
        .sort();

      expect(provenance).toMatchObject({
        schemaVersion: 3,
        syntheticOnly: true,
        dynamicData: "none-present",
        capture: {
          os: "Linux",
          runnerImage: "ubuntu24",
          runnerArch: "X64",
          browserName: "chromium",
          playwrightVersion: "1.61.1",
          browserVersion: "149.0.7827.55",
        },
        review: {
          status: "reviewed",
        },
      });
      expect(provenance.sourceCommit).toMatch(/^[0-9a-f]{40}$/);
      expect(provenance.review.referenceLock).toBe(
        computeVisualReferenceLock(repositoryRoot),
      );
      expect(provenance.sourceBinding).toEqual(
        computeVisualSourceBinding(repositoryRoot),
      );
      expect(provenance.comparisonBinding).toEqual(
        computeVisualComparisonBinding(repositoryRoot),
      );
      expect(provenance.sourceBinding.fileCount).toBeGreaterThan(0);
      expect(provenance.review.reviewer.trim().length).toBeGreaterThan(0);
      expect(Object.keys(provenance.assets).sort()).toEqual(expected);
      expect(pngs).toEqual(expected);

      for (const asset of expected) {
        const path = join(snapshotsRoot, asset);
        expect(provenance.assets[asset], asset).toBe(sha256(path));
        const project = asset.split("/")[2] as keyof typeof screenshotProjects;
        const dimensions = pngDimensions(path);
        expect(dimensions.width, asset).toBe(screenshotProjects[project]);
        expect(dimensions.height, asset).toBeGreaterThanOrEqual(700);
      }
    },
  );
});

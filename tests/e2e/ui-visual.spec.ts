import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { assertReviewedVisualBaselineAuthority } from "../../scripts/ci/visual-baseline-authority";
import {
  computeVisualComparisonBinding,
  computeVisualReferenceLock,
  computeVisualSourceBinding,
} from "../../scripts/ci/visual-baseline-binding";

type ProductSurface = "crm" | "tasha";

interface VisualScene {
  name: string;
  path: string;
  prepare?: (page: Page) => Promise<void>;
}

function requireSurface(): ProductSurface {
  const value = process.env.E2E_PRODUCT_SURFACE;
  if (value !== "crm" && value !== "tasha") {
    throw new Error("E2E_PRODUCT_SURFACE must be exactly crm or tasha.");
  }
  return value;
}

const surface = requireSurface();
const captureMode = process.env.VISUAL_BASELINE_CAPTURE === "reviewed-linux";
const snapshotRoot = resolve(process.cwd(), "tests/e2e/__snapshots__");
const provenancePath = resolve(snapshotRoot, "provenance.json");
const stylePath = resolve(process.cwd(), "tests/e2e/visual-snapshot.css");
const screenshotProjects = new Set([
  "mobile-chromium-320x800",
  "mobile-chromium-390x844",
  "desktop-chromium-768x1024",
  "desktop-chromium-1024x768",
  "desktop-chromium-1440x900",
]);
const require = createRequire(resolve(process.cwd(), "package.json"));

test.use({ serviceWorkers: "block" });

async function openCompanySwitcher(page: Page): Promise<void> {
  const menuButton = page.getByRole("button", { name: "Buka menu navigasi" });
  const usesDrawer = await menuButton.isVisible();
  const container = usesDrawer
    ? page.getByRole("dialog", { name: "Navigasi utama" })
    : page.locator(".crm-shell__desktop-sidebar");

  if (usesDrawer) {
    await menuButton.focus();
    await page.keyboard.press("Enter");
    await expect(container).toBeVisible();
  }
  const switcher = container.getByRole("button", { name: /Tukar syarikat/ });
  await switcher.focus();
  await page.keyboard.press("Enter");
  await expect(container.getByRole("listbox", { name: "Syarikat" })).toBeVisible();
}

const commonScenes: VisualScene[] = [
  { name: "login", path: "/login" },
  {
    name: "company-switcher",
    path: "/?bu=salam-land",
    prepare: openCompanySwitcher,
  },
  { name: "operation-states", path: "/__ui-test__/states" },
];

const surfaceScenes = {
  crm: [
    { name: "crm-dashboard", path: "/?bu=salam-land" },
    { name: "crm-leads", path: "/leads?bu=salam-land" },
    { name: "crm-pipeline", path: "/pipeline?bu=salam-land" },
    { name: "crm-integrations-unknown", path: "/settings?bu=salam-land" },
  ],
  tasha: [
    { name: "tasha-home", path: "/?bu=salam-land" },
    { name: "tasha-inventory", path: "/inventory?bu=salam-land" },
  ],
} as const satisfies Record<ProductSurface, readonly VisualScene[]>;

async function verifyReviewedBaselineAuthority(page: Page): Promise<void> {
  const provenance: unknown = JSON.parse(readFileSync(provenancePath, "utf8"));
  const sourceBinding = computeVisualSourceBinding(process.cwd());
  const browser = page.context().browser();
  const runnerImage = process.env.ImageOS;
  const runnerArch = process.env.RUNNER_ARCH;
  const packagePath = require.resolve("@playwright/test/package.json");
  const packageJson = JSON.parse(readFileSync(packagePath, "utf8")) as {
    version?: unknown;
  };

  if (!runnerImage || !runnerArch) {
    throw new Error(
      "Visual baseline comparison requires explicit ImageOS and RUNNER_ARCH bindings.",
    );
  }
  if (!browser) {
    throw new Error("Visual baseline comparison requires a live browser runtime.");
  }
  if (packageJson.version !== "1.61.1") {
    throw new Error("Visual baseline comparison requires Playwright 1.61.1.");
  }
  assertReviewedVisualBaselineAuthority(provenance, {
    sourceBinding,
    comparisonBinding: computeVisualComparisonBinding(process.cwd()),
    referenceLock: computeVisualReferenceLock(process.cwd()),
    runtime: {
      os: "Linux",
      runnerImage,
      runnerArch,
      playwrightVersion: packageJson.version,
      browserName: browser.browserType().name(),
      browserVersion: browser.version(),
    },
  });
}

let authorityVerification: Promise<void> | undefined;

function assertReviewedBaselineAuthority(page: Page): Promise<void> {
  if (captureMode) return Promise.resolve();
  authorityVerification ??= verifyReviewedBaselineAuthority(page);
  return authorityVerification;
}

const activeScenes: readonly VisualScene[] = [
  ...commonScenes,
  ...surfaceScenes[surface],
];

for (const scene of activeScenes) {
  test(`${surface} visual: ${scene.name}`, async ({ page }, testInfo) => {
    test.skip(process.platform !== "linux", "Linux Playwright is the only snapshot authority.");
    test.skip(
      !screenshotProjects.has(testInfo.project.name),
      "Screenshots are reviewed only at 320, 390, 768, 1024, and 1440 pixels.",
    );
    await assertReviewedBaselineAuthority(page);

    let hydrationMismatchCount = 0;
    page.on("console", (message) => {
      const diagnostic = message.text().toLowerCase();
      if (
        diagnostic.includes("hydration-mismatch") ||
        diagnostic.includes("hydration failed") ||
        diagnostic.includes("server rendered html didn't match")
      ) {
        hydrationMismatchCount += 1;
      }
    });

    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await page.goto(scene.path, { waitUntil: "domcontentloaded" });
    await page.evaluate(async () => {
      await document.fonts.ready;
    });
    await expect(page.locator("body")).toBeVisible();
    await scene.prepare?.(page);

    await expect(page).toHaveScreenshot(`${scene.name}.png`, {
      animations: "disabled",
      caret: "initial",
      fullPage: true,
      maxDiffPixels: 100,
      scale: "css",
      stylePath,
      threshold: 0.1,
    });
    expect(hydrationMismatchCount, "React hydration mismatch during visual capture").toBe(0);
  });
}

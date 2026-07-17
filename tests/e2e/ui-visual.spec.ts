import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";

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

function assertReviewedBaselineAuthority(): void {
  if (captureMode) return;
  const provenance = JSON.parse(readFileSync(provenancePath, "utf8")) as {
    review?: { status?: string };
  };
  if (provenance.review?.status !== "reviewed") {
    throw new Error("Visual baselines must be explicitly reviewed before comparison.");
  }
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
    assertReviewedBaselineAuthority();

    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await page.goto(scene.path, { waitUntil: "domcontentloaded" });
    await page.evaluate(async () => {
      await document.fonts.ready;
    });
    await expect(page.locator("body")).toBeVisible();
    await scene.prepare?.(page);

    await expect(page).toHaveScreenshot(`${scene.name}.png`, {
      animations: "disabled",
      caret: "hide",
      fullPage: true,
      maxDiffPixels: 100,
      scale: "css",
      stylePath,
      threshold: 0.1,
    });
  });
}

import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const stateKinds = [
  "loading",
  "empty",
  "filtered-empty",
  "stale",
  "syncing",
  "queued",
  "partial",
  "success",
  "failed",
  "conflict",
  "offline",
  "forbidden",
  "unknown",
] as const;

test("synthetic gallery exposes the complete accessible state vocabulary", async ({ page }) => {
  await page.goto("/__ui-test__/states");

  await expect(page.getByRole("heading", { level: 1, name: "Status operasi" })).toBeVisible();
  const gallery = page.getByRole("main");
  await expect(gallery.locator("[data-state-kind]")).toHaveCount(stateKinds.length);
  for (const kind of stateKinds) {
    const state = gallery.locator(`[data-state-kind="${kind}"]`);
    await expect(state).toHaveCount(1);
    await expect(state.locator("svg")).toHaveAttribute("aria-hidden", "true");
  }
  await expect(gallery.locator('[data-state-kind="failed"]')).toHaveAccessibleName(
    "Bayaran Pesanan SL-TEST-001 gagal",
  );

  await expect(gallery.getByRole("status")).toHaveCount(5);
  await expect(gallery.getByRole("alert")).toHaveCount(4);
  await expect(gallery.getByRole("region")).toHaveCount(4);
  await expect(page.getByRole("navigation")).toHaveCount(0);
  await expect(page.locator("form, input, textarea, select")).toHaveCount(0);

  const dimensions = await page.evaluate(() => ({
    contentWidth: document.documentElement.scrollWidth,
    viewportWidth: document.documentElement.clientWidth,
  }));
  expect(dimensions.contentWidth).toBeLessThanOrEqual(dimensions.viewportWidth);

  const results = await new AxeBuilder({ page }).analyze();
  expect(
    results.violations.filter((violation) =>
      ["critical", "serious"].includes(violation.impact ?? ""),
    ),
  ).toEqual([]);
});

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

test.skip(
  process.env.E2E_PRODUCT_SURFACE !== "crm",
  "Legacy CRM coverage runs only on the CRM product surface.",
);

test.use({ serviceWorkers: "block" });

async function expectNoCriticalOrSeriousAxeViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  expect(
    results.violations.filter((violation) =>
      ["critical", "serious"].includes(violation.impact ?? ""),
    ),
  ).toEqual([]);
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const dimensions = await page.evaluate(() => ({
    content: document.documentElement.scrollWidth,
    viewport: document.documentElement.clientWidth,
  }));
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport);
}

test("dirty Lead changes require an explicit discard and restore focus", async ({ page }) => {
  await page.goto("/leads?bu=salam-land");

  const openCreate = page.getByRole("button", { name: "Lead baharu" });
  await openCreate.click();

  const createDialog = page.getByRole("dialog", { name: "Lead baharu" });
  const name = createDialog.getByLabel("Nama");
  const cancelCreate = createDialog.getByRole("button", { name: "Batal" });
  await name.fill("Lead belum siap");

  await cancelCreate.click();
  let discardDialog = page.getByRole("dialog", { name: "Buang perubahan?" });
  const keepChanges = discardDialog.getByRole("button", { name: "Kekalkan perubahan" });
  const discardChanges = discardDialog.getByRole("button", { name: "Buang perubahan" });
  await expect(keepChanges).toBeFocused();

  await page.keyboard.press("Shift+Tab");
  await expect(discardChanges).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(keepChanges).toBeFocused();
  await keepChanges.click();
  await expect(discardDialog).toBeHidden();
  await expect(createDialog).toBeVisible();
  await expect(page.locator('input[name="name"]')).toHaveValue("Lead belum siap");
  await expect(cancelCreate).toBeFocused();

  await name.focus();
  await page.keyboard.press("Escape");
  discardDialog = page.getByRole("dialog", { name: "Buang perubahan?" });
  await expect(discardDialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(discardDialog).toBeHidden();
  await expect(name).toHaveValue("Lead belum siap");
  await expect(name).toBeFocused();

  await cancelCreate.click();
  discardDialog = page.getByRole("dialog", { name: "Buang perubahan?" });
  await expect(discardDialog).toBeVisible();
  const backdrop = page.locator("[data-unsaved-changes-backdrop]");
  const backdropBox = await backdrop.boundingBox();
  expect(backdropBox).not.toBeNull();
  await page.mouse.click(backdropBox!.x + 2, backdropBox!.y + 2);
  await expect(discardDialog).toBeVisible();
  await expect(page.locator('input[name="name"]')).toHaveValue("Lead belum siap");

  await discardDialog.getByRole("button", { name: "Buang perubahan" }).click();
  await expect(discardDialog).toBeHidden();
  await expect(createDialog).toBeHidden();
  await expect(openCreate).toBeFocused();
});

test("Lead 422 errors map to fields and focus the first invalid control", async ({ page }) => {
  let submittedBody: Record<string, unknown> | undefined;
  await page.route("**/api/v1/leads", async (route) => {
    submittedBody = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      contentType: "application/json",
      status: 422,
      body: JSON.stringify({
        error: {
          code: "VALIDATION_ERROR",
          message: "Semak medan yang ditandakan.",
          details: {
            fields: {
              phone: ["Telefon telah digunakan."],
              name: ["Nama telah digunakan."],
            },
          },
        },
      }),
    });
  });

  await page.goto("/leads?bu=salam-land");
  await page.getByRole("button", { name: "Lead baharu" }).click();
  const dialog = page.getByRole("dialog", { name: "Lead baharu" });
  const name = dialog.getByLabel("Nama");
  const phone = dialog.getByLabel("Telefon");
  await name.fill("Lead E2E validation");
  await phone.fill("0123456789");
  await dialog.getByLabel("Minat produk").fill("Lot E2E-422");
  await dialog.getByRole("button", { name: "Simpan" }).click();

  await expect(dialog.getByText("Nama telah digunakan.")).toBeVisible();
  await expect(dialog.getByText("Telefon telah digunakan.")).toBeVisible();
  await expect(name).toHaveAttribute("aria-invalid", "true");
  await expect(phone).toHaveAttribute("aria-invalid", "true");
  await expect(name).toHaveAttribute("aria-describedby", /-error$/);
  await expect(phone).toHaveAttribute("aria-describedby", /-error$/);
  await expect(name).toBeFocused();
  await expect(dialog.locator(".crm-form-error")).toHaveCount(0);
  expect(submittedBody).toMatchObject({
    businessUnitId: "00000000-0000-4000-8000-000000000101",
    name: "Lead E2E validation",
    phone: "+60123456789",
  });
});

test("failed logout keeps the current screen and user menu available", async ({ page }) => {
  await page.route("**/api/v1/auth/logout", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      status: 503,
      body: JSON.stringify({
        error: { message: "Log keluar tidak dapat diproses sekarang." },
      }),
    });
  });

  await page.goto("/leads?bu=salam-land");
  const initialUrl = page.url();
  const userMenuTrigger = page.getByRole("button", { name: /^Menu pengguna / });
  await userMenuTrigger.click();
  const menu = page.getByRole("menu");
  await menu.getByRole("menuitem", { name: "Log keluar" }).click();

  await expect(menu).toBeVisible();
  await expect(menu.getByRole("alert")).toHaveText("Log keluar tidak dapat diproses sekarang.");
  await expect(menu.getByRole("menuitem", { name: "Log keluar" })).toBeEnabled();
  await expect(page.getByRole("heading", { name: "Lead", level: 1 })).toBeVisible();
  expect(page.url()).toBe(initialUrl);

  await page.keyboard.press("Tab");
  await expect(menu).toBeHidden();
  await expect(page.getByRole("textbox", { name: "Cari lead" })).toBeFocused();

  await userMenuTrigger.click();
  await page.keyboard.press("Shift+Tab");
  await expect(menu).toBeHidden();
  await expect(userMenuTrigger).toBeFocused();
});

test("data tables keep captions, compact mobile dividers, and accessible output", async ({ page }, testInfo) => {
  if (testInfo.project.name.startsWith("desktop")) {
    await page.setViewportSize({ width: 700, height: 900 });
  }
  await page.goto("/leads?bu=salam-land");
  const leadTable = page.getByRole("table", { name: "Senarai lead" });
  await expect(leadTable).toBeVisible();
  const leadTableRegion = page.getByRole("region", { name: "Senarai lead" });
  await expect(leadTableRegion).toHaveAttribute("tabindex", "0");

  if (testInfo.project.name.startsWith("desktop")) {
    const dimensions = await leadTableRegion.evaluate((region) => ({
      clientWidth: region.clientWidth,
      scrollWidth: region.scrollWidth,
    }));
    expect(dimensions.scrollWidth).toBeGreaterThan(dimensions.clientWidth);
    await leadTableRegion.focus();
    await expect(leadTableRegion).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect.poll(() => leadTableRegion.evaluate((region) => region.scrollLeft)).toBeGreaterThan(0);
  }

  if (testInfo.project.name.startsWith("mobile")) {
    const firstRow = leadTable.locator("tbody tr").first();
    const mobileStyle = await firstRow.evaluate((row) => {
      const style = getComputedStyle(row);
      return {
        borderBottomStyle: style.borderBottomStyle,
        borderBottomWidth: style.borderBottomWidth,
        borderRadius: style.borderRadius,
        display: style.display,
      };
    });
    expect(mobileStyle).toMatchObject({
      borderBottomStyle: "solid",
      borderBottomWidth: "1px",
      borderRadius: "0px",
      display: "block",
    });
  }

  await expectNoHorizontalOverflow(page);
  await expectNoCriticalOrSeriousAxeViolations(page);

  await page.goto("/?bu=salam-land");
  await expect(page.getByRole("table", { name: "Aktiviti terkini" })).toBeVisible();

  await page.goto("/tasks?bu=salam-land");
  await expect(page.getByRole("table", { name: "Senarai tugasan" })).toBeVisible();
});

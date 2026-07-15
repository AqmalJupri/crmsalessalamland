import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

async function expectNoHorizontalOverflow(page: import("@playwright/test").Page): Promise<void> {
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
  }));
  expect(dimensions.content, `content ${dimensions.content}px exceeds viewport ${dimensions.viewport}px`).toBeLessThanOrEqual(
    dimensions.viewport,
  );
}

test("dashboard is concise and accessible", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Utama", level: 1 })).toBeVisible();
  await expect(page.getByText("Nilai pipeline")).toBeVisible();
  await expect(page.getByText("Revenue Operations")).toHaveCount(0);
  await expect(page.getByText("Pentadbir", { exact: true })).toHaveCount(0);
  await expectNoHorizontalOverflow(page);

  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations.filter((violation) => ["critical", "serious"].includes(violation.impact ?? ""))).toEqual([]);
});

test("lead can be created once", async ({ page }) => {
  await page.goto("/leads");
  const leadTable = page.getByRole("table");
  await expect(leadTable.getByRole("columnheader", { name: "Nilai" })).toHaveCount(0);

  await page.getByRole("button", { name: "Nur Aisyah" }).click();
  const existingLeadDialog = page.getByRole("dialog", { name: "Nur Aisyah" });
  await expect(existingLeadDialog.getByText("Nilai", { exact: true })).toHaveCount(0);
  await expect(existingLeadDialog.getByText("Minat produk", { exact: true })).toBeVisible();
  await existingLeadDialog.getByRole("button", { name: "Tutup" }).click();

  await page.getByRole("button", { name: "Lead baharu" }).click();
  await page.getByLabel("Nama").fill("Lead E2E");
  await page.getByLabel("Telefon").fill("0123456789");
  await page.getByLabel("Minat produk").fill("Lot E2E-01");
  await page.getByRole("button", { name: "Simpan" }).click();

  await expect(page.getByRole("status")).toHaveText("Lead E2E ditambah.");
  await expect(page.getByRole("button", { name: "Lead E2E" })).toHaveCount(1);
  await page.getByRole("button", { name: "Lead E2E" }).click();
  const createdLeadDialog = page.getByRole("dialog", { name: "Lead E2E" });
  await expect(createdLeadDialog.getByText("Meta", { exact: true })).toBeVisible();
  await expect(createdLeadDialog.getByText("Nilai", { exact: true })).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
});

test("pipeline totals follow cards when an opportunity moves", async ({ page }) => {
  await page.goto("/pipeline");
  const qualification = page.getByRole("listitem", { name: "Kelayakan", exact: true });
  const proposal = page.getByRole("listitem", { name: "Tawaran", exact: true });
  await expect(qualification).toContainText(/RM\s*505K/i);
  await expect(proposal).toContainText(/RM\s*366K/i);

  await page.getByRole("button", { name: /Nur Aisyah/ }).click();
  const opportunityDialog = page.getByRole("dialog", { name: "Nur Aisyah" });
  await opportunityDialog.getByRole("button", { name: "Seterusnya" }).click();
  await expect(opportunityDialog).toContainText("Tawaran");
  await opportunityDialog.getByRole("button", { name: "Tutup" }).click();
  await expect(opportunityDialog).toBeHidden();

  await expect(qualification).toContainText(/RM\s*320K/i);
  await expect(proposal).toContainText(/RM\s*551K/i);
});

test("mobile navigation opens and remains within viewport", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith("mobile"), "Mobile-only assertion");
  await page.goto("/pipeline");
  await page.getByRole("button", { name: "Buka menu navigasi" }).click();
  await expect(page.getByRole("dialog", { name: "Navigasi utama" })).toBeVisible();
  await expect(page.getByRole("link", { name: /Lead/ }).last()).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

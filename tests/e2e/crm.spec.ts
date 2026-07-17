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
  await expect(proposal).toContainText(/RM\s*190K/i);

  await page.getByRole("button", { name: /Nur Aisyah/ }).click();
  const opportunityDialog = page.getByRole("dialog", { name: "Nur Aisyah" });
  await opportunityDialog.getByRole("button", { name: "Seterusnya" }).click();
  await expect(opportunityDialog).toContainText("Tawaran");
  await opportunityDialog.getByRole("button", { name: "Tutup" }).click();
  await expect(opportunityDialog).toBeHidden();

  await expect(qualification).toContainText(/RM\s*320K/i);
  await expect(proposal).toContainText(/RM\s*375K/i);
});

test("company scope survives deep links and browser history", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith("desktop"), "Desktop switcher flow");

  await page.goto("/leads?campaign=retarget");
  await expect(page).toHaveURL((url) =>
    url.pathname === "/leads" &&
    url.searchParams.get("campaign") === "retarget" &&
    url.searchParams.get("bu") === "salam-land",
  );
  await expect(page.getByRole("button", { name: /Semasa: Salam Land/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Nur Aisyah" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Izzati Salleh" })).toHaveCount(0);

  await page.getByRole("button", { name: /Tukar syarikat/ }).click();
  await page.getByRole("option", { name: "Bumi Hayat Printing" }).click();
  await expect(page).toHaveURL((url) =>
    url.pathname === "/leads" &&
    url.searchParams.get("campaign") === "retarget" &&
    url.searchParams.get("bu") === "bumi-hayat",
  );
  await expect(page.getByRole("button", { name: "Izzati Salleh" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Nur Aisyah" })).toHaveCount(0);

  await page.getByRole("button", { name: /Tukar syarikat/ }).click();
  await page.getByRole("listbox", { name: "Syarikat" })
    .getByRole("option", { name: "Semua", exact: true }).click();
  await expect(page).toHaveURL((url) => url.searchParams.get("bu") === "all");
  await expect(page.getByRole("columnheader", { name: "Syarikat" })).toBeVisible();
  await expect(page.getByText("Salam Land", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Bumi Hayat Printing", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Barakah Emas", { exact: true }).first()).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL((url) => url.searchParams.get("bu") === "bumi-hayat");
  await expect(page.getByRole("button", { name: "Izzati Salleh" })).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL((url) => url.searchParams.get("bu") === "all");

  await page.goto("/leads?bu=barakah-emas");
  await expect(page.getByRole("button", { name: "Aina Sofea" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Izzati Salleh" })).toHaveCount(0);
});

test("invalid and unauthorised company scopes fail closed", async ({ page }) => {
  const duplicate = await page.goto("/leads?bu=salam-land&bu=bumi-hayat");
  expect(duplicate?.status()).toBe(400);
  await expect(page.getByText("Skop syarikat tidak sah.")).toBeVisible();

  const forbidden = await page.goto("/leads?bu=syarikat-tidak-dibenarkan");
  expect(forbidden?.status()).toBe(403);
  await expect(page.getByRole("heading", { name: "Akses ditolak" })).toBeVisible();
});

test("dashboard KPI values open exact filtered records and definitions", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith("desktop"), "Desktop KPI drill-down flow");

  await page.goto("/?bu=bumi-hayat");
  const leadMetric = page.locator("article.crm-metric").filter({ hasText: "Lead baharu" });
  await expect(leadMetric.locator(".crm-metric__value")).toHaveText("1");
  await leadMetric.locator(".crm-metric__value a").click();
  await expect(page).toHaveURL((url) =>
    url.pathname === "/leads" &&
    url.searchParams.get("stage") === "new" &&
    url.searchParams.get("bu") === "bumi-hayat",
  );
  await expect(page.getByLabel("Tapis status")).toHaveValue("new");
  await expect(page.getByRole("button", { name: "Izzati Salleh" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Daniel Wong" })).toHaveCount(0);

  await page.goto("/?bu=bumi-hayat");
  await page.locator("article.crm-metric").filter({ hasText: "Lead baharu" })
    .getByRole("link", { name: "Lihat definisi Lead baharu" }).click();
  await expect(page.getByRole("heading", { name: "Definisi Lead baharu" })).toBeVisible();

  await page.goto("/?bu=salam-land");
  await page.locator("article.crm-metric").filter({ hasText: "Susulan lewat" })
    .locator(".crm-metric__value a").click();
  await expect(page).toHaveURL((url) =>
    url.pathname === "/tasks" &&
    url.searchParams.get("metric") === "overdue" &&
    url.searchParams.get("bu") === "salam-land",
  );
  await expect(page.getByText("Tapis: Susulan lewat · 1 rekod")).toBeVisible();
  await expect(page.getByText("Hubungi pelanggan", { exact: true })).toBeVisible();
  await expect(page.getByText("Hantar sebut harga Lot C-031", { exact: true })).toHaveCount(0);

  await page.goto("/?bu=salam-land");
  await page.locator("article.crm-metric").filter({ hasText: "Nilai pipeline" })
    .locator(".crm-metric__value a").click();
  await expect(page).toHaveURL((url) =>
    url.pathname === "/pipeline" &&
    url.searchParams.get("metric") === "active" &&
    url.searchParams.get("bu") === "salam-land",
  );
  await expect(page.getByText("Tapis: Pipeline aktif · 4 rekod")).toBeVisible();
  await expect(page.getByRole("listitem", { name: "Menang", exact: true })).toHaveCount(0);

  await page.goto("/?bu=salam-land");
  await page.locator("article.crm-metric").filter({ hasText: "Kutipan" })
    .locator(".crm-metric__value a").click();
  await expect(page).toHaveURL((url) =>
    url.pathname === "/finance" &&
    url.searchParams.get("metric") === "collections" &&
    url.searchParams.get("bu") === "salam-land",
  );
  await expect(page.getByText("Tapis: Semua kutipan · 1 rekod")).toBeVisible();
  await expect(page.getByText("RC-2026-1208", { exact: true })).toBeVisible();
  await expect(page.getByText("RC-2026-1207", { exact: true })).toHaveCount(0);
});

test("mobile navigation opens and remains within viewport", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith("mobile"), "Mobile-only assertion");
  await page.goto("/pipeline");
  await page.getByRole("button", { name: "Buka menu navigasi" }).click();
  await expect(page.getByRole("dialog", { name: "Navigasi utama" })).toBeVisible();
  const drawer = page.getByRole("dialog", { name: "Navigasi utama" });
  await expect(drawer.getByRole("link", { name: /Lead/ })).toBeVisible();
  await drawer.getByRole("button", { name: /Tukar syarikat/ }).click();
  await drawer.getByRole("option", { name: "Bumi Hayat Printing" }).click();
  await expect(drawer).toBeHidden();
  await expect(page).toHaveURL((url) =>
    url.pathname === "/pipeline" && url.searchParams.get("bu") === "bumi-hayat",
  );
  await expectNoHorizontalOverflow(page);
});

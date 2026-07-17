import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

type E2eSurface = "crm" | "tasha";

interface ModuleContract {
  path: string;
  title: string;
  contentHeading?: string;
}

interface SurfaceContract {
  productName: "Salam CRM" | "Tasha";
  navigationLabels: readonly string[];
  modules: readonly ModuleContract[];
}

function requireSurface(): E2eSurface {
  const value = process.env.E2E_PRODUCT_SURFACE;
  if (value !== "crm" && value !== "tasha") {
    throw new Error("E2E_PRODUCT_SURFACE must be exactly crm or tasha.");
  }
  return value;
}

const surface = requireSurface();
const contracts = {
  crm: {
    productName: "Salam CRM",
    navigationLabels: [
      "Utama",
      "Lead",
      "Pipeline",
      "Tugasan",
      "Pesanan",
      "Inventori",
      "Kewangan",
      "Pemasaran",
      "Laporan",
      "Pasukan",
      "Tetapan",
    ],
    modules: [
      { path: "/leads?bu=salam-land", title: "Lead" },
      { path: "/pipeline?bu=salam-land", title: "Pipeline" },
      { path: "/settings?bu=salam-land", title: "Tetapan", contentHeading: "Integrasi" },
    ],
  },
  tasha: {
    productName: "Tasha",
    navigationLabels: ["Utama", "Inventori", "Pesanan", "Kewangan", "Tugasan", "Laporan"],
    modules: [
      { path: "/inventory?bu=salam-land", title: "Inventori" },
      { path: "/orders?bu=salam-land", title: "Pesanan" },
      { path: "/finance?bu=salam-land", title: "Kewangan" },
      { path: "/tasks?bu=salam-land", title: "Tugasan" },
      { path: "/reports?bu=salam-land", title: "Laporan" },
    ],
  },
} as const satisfies Record<E2eSurface, SurfaceContract>;
const contract: SurfaceContract = contracts[surface];

test.use({ serviceWorkers: "block" });

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const dimensions = await page.evaluate(() => ({
    content: document.documentElement.scrollWidth,
    viewport: document.documentElement.clientWidth,
  }));
  expect(
    dimensions.content,
    `content ${dimensions.content}px exceeds viewport ${dimensions.viewport}px at ${page.url()}`,
  ).toBeLessThanOrEqual(dimensions.viewport);
}

async function expectNoCriticalOrSeriousAxeViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  const violations = results.violations.filter((violation) =>
    ["critical", "serious"].includes(violation.impact ?? ""),
  );
  expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
}

async function expectNavigationLabels(page: Page): Promise<void> {
  const labels = await page
    .locator(".crm-shell__desktop-sidebar .crm-sidebar__nav-label")
    .allTextContents();
  expect(labels).toEqual(contract.navigationLabels);
}

async function visitAndAudit(
  page: Page,
  input: {
    path: string;
    title: string;
    heading?: string;
    status?: number;
    shell?: boolean;
  },
): Promise<void> {
  const response = await page.goto(input.path);
  expect(response?.status()).toBe(input.status ?? 200);
  await expect(page.locator("html")).toHaveAttribute("lang", "ms");
  await expect(page).toHaveTitle(`${input.title} · ${contract.productName}`);
  if (input.heading) {
    await expect(page.getByRole("heading", { level: 1, name: input.heading })).toHaveCount(1);
  }
  if (input.shell) await expectNavigationLabels(page);
  await expectNoHorizontalOverflow(page);
  await expectNoCriticalOrSeriousAxeViolations(page);
}

test("login and root expose surface-specific Malay identity and metadata", async ({ page }) => {
  await visitAndAudit(page, {
    path: "/login",
    title: "Log masuk",
    heading: "Log masuk",
  });
  await expect(
    page.locator(".crm-login-card").getByText(contract.productName, { exact: true }),
  ).toBeVisible();

  await visitAndAudit(page, {
    path: "/?bu=salam-land",
    title: "Utama",
    heading: "Utama",
    shell: true,
  });
  await expect(page.getByRole("button", { name: "Menu pengguna Pengguna Demo" })).toBeVisible();
});

test("manifest keeps the surface name, root start URL, and explicit icons", async ({ request }) => {
  const response = await request.get("/manifest.webmanifest");
  expect(response.status()).toBe(200);
  const manifest = await response.json() as {
    name?: string;
    short_name?: string;
    lang?: string;
    start_url?: string;
    scope?: string;
    display?: string;
    icons?: unknown;
  };

  expect(manifest).toMatchObject({
    name: contract.productName,
    short_name: contract.productName,
    lang: "ms",
    start_url: "/",
    scope: "/",
    display: "standalone",
  });
  expect(manifest.icons).toEqual([
    {
      src: `/icons/${surface}-192.png`,
      sizes: "192x192",
      type: "image/png",
      purpose: "any",
    },
    {
      src: `/icons/${surface}-512.png`,
      sizes: "512x512",
      type: "image/png",
      purpose: "any",
    },
    {
      src: `/icons/${surface}-maskable-512.png`,
      sizes: "512x512",
      type: "image/png",
      purpose: "maskable",
    },
  ]);
});

for (const moduleContract of contract.modules) {
  test(`${surface} ${moduleContract.title} module is visited and audited`, async ({ page }) => {
    await visitAndAudit(page, {
      path: moduleContract.path,
      title: moduleContract.title,
      heading: moduleContract.title,
      shell: true,
    });
    if (moduleContract.contentHeading) {
      await expect(
        page.getByRole("heading", { level: 2, name: moduleContract.contentHeading }),
      ).toBeVisible();
    }

    if (surface === "crm" && moduleContract.path.startsWith("/settings")) {
      await expect(page.getByText("Tidak diketahui", { exact: true }).first()).toBeVisible();
      await expect(page.getByText("Sihat", { exact: true })).toHaveCount(0);
      await expect(page.getByText(/^(?:2|4|18) min$/)).toHaveCount(0);
      await expect(page.getByRole("link", { name: "Lihat rekod Status tidak diketahui" }))
        .toBeVisible();
      await expect(page.getByRole("link", { name: "Lihat definisi Status tidak diketahui" }))
        .toBeVisible();
    }
  });
}

test("navigation excludes labels owned by the other surface", async ({ page }) => {
  await page.goto("/?bu=salam-land");
  await expectNavigationLabels(page);

  if (surface === "tasha") {
    await expect(page.getByText("Lead", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Pipeline", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Tetapan", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Integrasi", { exact: true })).toHaveCount(0);
  }
});

test("custom forbidden and not-found pages keep surface-safe recovery metadata", async ({ page }) => {
  await visitAndAudit(page, {
    path: "/?bu=syarikat-tidak-dibenarkan",
    title: "Akses ditolak",
    heading: "Akses ditolak",
    status: 403,
  });
  await expect(
    page.locator(".crm-login-card").getByText(contract.productName, { exact: true }),
  ).toBeVisible();

  await visitAndAudit(page, {
    path: "/halaman-tidak-wujud",
    title: "Halaman tidak ditemui",
    heading: "Halaman tidak ditemui",
    status: 404,
  });
  await expect(
    page.locator(".crm-login-card").getByText(contract.productName, { exact: true }),
  ).toBeVisible();
});

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";

type ProductSurface = "crm" | "tasha";

function requireSurface(): ProductSurface {
  const value = process.env.E2E_PRODUCT_SURFACE;
  if (value !== "crm" && value !== "tasha") {
    throw new Error("E2E_PRODUCT_SURFACE must be exactly crm or tasha.");
  }
  return value;
}

const surface = requireSurface();
const expectedColors = {
  action: "rgb(37, 99, 235)",
  canvas: "rgb(248, 250, 252)",
  focusRing: "rgb(37, 99, 235)",
  sidebar: "rgb(11, 23, 42)",
  surface: "rgb(255, 255, 255)",
  text: "rgb(30, 41, 59)",
} as const;

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

async function expectContained(page: Page, locator: Locator): Promise<void> {
  await expect(locator).toBeVisible();
  await expect.poll(async () => {
    const [box, viewport] = await Promise.all([
      locator.boundingBox(),
      page.evaluate(() => ({ height: window.innerHeight, width: window.innerWidth })),
    ]);
    if (!box) return Number.POSITIVE_INFINITY;
    return Math.max(
      0,
      -box.x,
      -box.y,
      box.x + box.width - viewport.width,
      box.y + box.height - viewport.height,
    );
  }, {
    message: `wait for ${await locator.getAttribute("class")} to settle inside the viewport`,
    timeout: 2_000,
  }).toBeLessThanOrEqual(0.5);
  await expect(locator).toBeInViewport({ ratio: 1 });
}

async function expectContainedInVisualViewport(
  page: Page,
  locator: Locator,
): Promise<void> {
  await expect(locator).toBeVisible();
  await expect.poll(async () => locator.evaluate((element) => {
    const viewport = window.visualViewport;
    if (!viewport) return Number.POSITIVE_INFINITY;
    const box = element.getBoundingClientRect();
    return Math.max(
      0,
      viewport.offsetLeft - box.left,
      viewport.offsetTop - box.top,
      box.right - (viewport.offsetLeft + viewport.width),
      box.bottom - (viewport.offsetTop + viewport.height),
    );
  }), {
    message: "wait for the control to settle inside the 200% visual viewport",
    timeout: 2_000,
  }).toBeLessThanOrEqual(0.5);
}

async function expectNoCriticalOrSeriousAxeViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  const violations = results.violations.filter((violation) =>
    violation.impact === "critical" || violation.impact === "serious",
  );
  expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
}

async function expectFocusVisible(locator: Locator): Promise<void> {
  await expect(locator).toBeFocused();
  const evidence = await locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      focusVisible: element.matches(":focus-visible"),
      outlineColor: style.outlineColor,
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
    };
  });
  expect(evidence).toEqual({
    focusVisible: true,
    outlineColor: expectedColors.focusRing,
    outlineStyle: "solid",
    outlineWidth: "2px",
  });
}

async function expectCoarseTargets(page: Page): Promise<void> {
  expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
  const undersized = await page.evaluate(() => {
    const selector = [
      "a[href]",
      "button:not(:disabled)",
      "input:not(:disabled)",
      "select:not(:disabled)",
      "textarea:not(:disabled)",
      "[role='option']:not([aria-disabled='true'])",
    ].join(",");
    const seen = new Set<Element>();
    return Array.from(document.querySelectorAll<HTMLElement>(selector)).flatMap((element) => {
      if (seen.has(element)) return [];
      seen.add(element);
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      const visible = style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number(style.opacity) > 0 &&
        box.width > 0 &&
        box.height > 0 &&
        !element.closest("[inert]") &&
        element.getAttribute("aria-hidden") !== "true";
      if (!visible || (box.width >= 44 && box.height >= 44)) return [];
      return [{
        height: Math.round(box.height * 100) / 100,
        label: element.getAttribute("aria-label") ?? element.textContent?.trim().slice(0, 80) ?? "",
        selector: `${element.tagName.toLowerCase()}.${element.className}`,
        width: Math.round(box.width * 100) / 100,
      }];
    });
  });
  expect(undersized, JSON.stringify(undersized, null, 2)).toEqual([]);
}

test("computed product tokens and root accessibility match the locked reference", async ({ page }) => {
  await page.goto("/?bu=salam-land");
  const menuButton = page.getByRole("button", { name: "Buka menu navigasi" });
  const usesDrawer = await menuButton.isVisible();
  const sidebarSelector = usesDrawer
    ? ".crm-drawer__panel .crm-sidebar"
    : ".crm-shell__desktop-sidebar .crm-sidebar";

  if (usesDrawer) {
    await menuButton.click();
  }
  const visibleSidebar = page.locator(sidebarSelector);
  const visibleAction = visibleSidebar.locator("[aria-current='page']");
  await expect(visibleSidebar).toBeVisible();
  await expect(visibleAction).toBeVisible();

  const colors = await page.evaluate((selectors) => {
    const required = (selector: string): HTMLElement => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) throw new Error(`Missing token probe ${selector}`);
      return element;
    };
    return {
      action: getComputedStyle(required(selectors.action))
        .backgroundColor,
      canvas: getComputedStyle(document.body).backgroundColor,
      sidebar: getComputedStyle(required(selectors.sidebar))
        .backgroundColor,
      surface: getComputedStyle(required(".crm-metric, .crm-card, .crm-operation-state"))
        .backgroundColor,
      text: getComputedStyle(required(".crm-theme")).color,
    };
  }, {
    action: `${sidebarSelector} [aria-current='page']`,
    sidebar: sidebarSelector,
  });
  expect(colors).toEqual({
    action: expectedColors.action,
    canvas: expectedColors.canvas,
    sidebar: expectedColors.sidebar,
    surface: expectedColors.surface,
    text: expectedColors.text,
  });
  if (usesDrawer) {
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Navigasi utama" })).toBeHidden();
  }
  await expectNoHorizontalOverflow(page);
  await expectNoCriticalOrSeriousAxeViolations(page);
});

test("shell menus are contained and restore visible keyboard focus", async ({ page }) => {
  await page.goto("/?bu=salam-land");
  const menuButton = page.getByRole("button", { name: "Buka menu navigasi" });
  const usesDrawer = await menuButton.isVisible();
  let switcher: Locator;

  if (usesDrawer) {
    await menuButton.focus();
    await page.keyboard.press("Enter");
    const drawer = page.getByRole("dialog", { name: "Navigasi utama" });
    await expectContained(page, drawer);
    await expect(drawer.getByRole("button", { name: "Tutup menu navigasi" })).toHaveCount(1);
    if (await page.evaluate(() => matchMedia("(pointer: coarse)").matches)) {
      await expectCoarseTargets(page);
    }
    await expectNoCriticalOrSeriousAxeViolations(page);
    switcher = drawer.getByRole("button", { name: /Tukar syarikat/ });
  } else {
    switcher = page.locator(".crm-shell__desktop-sidebar")
      .getByRole("button", { name: /Tukar syarikat/ });
  }

  await switcher.focus();
  await page.keyboard.press("Enter");
  const listbox = page.getByRole("listbox", { name: "Syarikat" });
  await expectContained(page, listbox);
  if (await page.evaluate(() => matchMedia("(pointer: coarse)").matches)) {
    await expectCoarseTargets(page);
  }
  await expectNoCriticalOrSeriousAxeViolations(page);
  await expect(page.getByRole("option", { name: "Salam Land" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(listbox).toBeHidden();
  await expectFocusVisible(switcher);

  if (usesDrawer) {
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Navigasi utama" })).toBeHidden();
    await expectFocusVisible(menuButton);
  }

  const userTrigger = page.getByRole("button", { name: "Menu pengguna Pengguna Demo" });
  await userTrigger.focus();
  await page.keyboard.press("Enter");
  const userMenu = page.getByRole("menu", { name: "Akaun Pengguna Demo" });
  await expectContained(page, userMenu);
  await expect(userMenu.getByRole("menuitem", { name: "Log keluar" })).toBeFocused();
  if (await page.evaluate(() => matchMedia("(pointer: coarse)").matches)) {
    await expectCoarseTargets(page);
  }
  await expectNoCriticalOrSeriousAxeViolations(page);
  await page.keyboard.press("Escape");
  await expect(userMenu).toBeHidden();
  await expectFocusVisible(userTrigger);
  await expectNoHorizontalOverflow(page);
});

test("coarse-pointer root actions meet the 44px target contract", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith("mobile-"), "Touch projects only");
  await page.goto("/?bu=salam-land");
  await expectCoarseTargets(page);
});

test("CRM Lead dialogs are contained and return keyboard focus", async ({ page }) => {
  test.skip(surface !== "crm", "CRM-only Lead workflow");
  await page.goto("/leads?bu=salam-land");

  const createTrigger = page.getByRole("button", { name: "Lead baharu" });
  await createTrigger.focus();
  await page.keyboard.press("Enter");
  const createDialog = page.getByRole("dialog", { name: "Lead baharu" });
  await expectContained(page, createDialog);
  await expect(createDialog.getByRole("button", { name: "Tutup" })).toHaveCount(1);
  await expect(createDialog.getByLabel("Nama")).toBeFocused();
  if (await page.evaluate(() => matchMedia("(pointer: coarse)").matches)) {
    await expectCoarseTargets(page);
  }
  await expectNoCriticalOrSeriousAxeViolations(page);
  const name = createDialog.getByLabel("Nama");
  await name.fill("Lead belum siap B2");
  await page.keyboard.press("Escape");
  let discardDialog = page.getByRole("dialog", { name: "Buang perubahan?" });
  await expectContained(page, discardDialog);
  const keepChanges = discardDialog.getByRole("button", { name: "Kekalkan perubahan" });
  const discardChanges = discardDialog.getByRole("button", { name: "Buang perubahan" });
  await expect(keepChanges).toBeFocused();
  if (await page.evaluate(() => matchMedia("(pointer: coarse)").matches)) {
    await expectCoarseTargets(page);
  }
  await expectNoCriticalOrSeriousAxeViolations(page);
  await page.keyboard.press("Shift+Tab");
  await expect(discardChanges).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(keepChanges).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(discardDialog).toBeHidden();
  await expect(name).toBeFocused();

  await page.keyboard.press("Escape");
  discardDialog = page.getByRole("dialog", { name: "Buang perubahan?" });
  await expectContained(page, discardDialog);
  await page.keyboard.press("Shift+Tab");
  await expect(discardDialog.getByRole("button", { name: "Buang perubahan" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(discardDialog).toBeHidden();
  await expect(createDialog).toBeHidden();
  await expectFocusVisible(createTrigger);

  const detailTrigger = page.getByRole("button", { name: "Nur Aisyah" });
  await detailTrigger.focus();
  await page.keyboard.press("Enter");
  const detailDialog = page.getByRole("dialog", { name: "Nur Aisyah" });
  await expectContained(page, detailDialog);
  await expect(detailDialog.getByRole("button", { name: "Tutup" })).toBeFocused();
  if (await page.evaluate(() => matchMedia("(pointer: coarse)").matches)) {
    await expectCoarseTargets(page);
  }
  await expectNoCriticalOrSeriousAxeViolations(page);
  await page.keyboard.press("Escape");
  await expect(detailDialog).toBeHidden();
  await expectFocusVisible(detailTrigger);

  await page.goto("/pipeline?bu=salam-land");
  const opportunityTrigger = page.getByRole("button", { name: /Nur Aisyah/ });
  await opportunityTrigger.focus();
  await page.keyboard.press("Enter");
  const opportunityDialog = page.getByRole("dialog", { name: "Nur Aisyah" });
  await expectContained(page, opportunityDialog);
  await expect(opportunityDialog.getByRole("button", { name: "Tutup" })).toBeFocused();
  if (await page.evaluate(() => matchMedia("(pointer: coarse)").matches)) {
    await expectCoarseTargets(page);
  }
  await expectNoCriticalOrSeriousAxeViolations(page);
  await page.keyboard.press("Escape");
  await expect(opportunityDialog).toBeHidden();
  await expectFocusVisible(opportunityTrigger);
  await expectNoHorizontalOverflow(page);
});

test("1280px runtime proves 200% visual scale and separately audits equivalent 640px reflow", async ({ page }, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium-1280x800",
    "One deterministic 200% evidence project per surface",
  );
  await page.goto("/?bu=salam-land");

  const session = await page.context().newCDPSession(page);
  await session.send("Emulation.setPageScaleFactor", { pageScaleFactor: 2 });
  await expect.poll(() => page.evaluate(() => window.visualViewport?.scale ?? 1)).toBe(2);
  const zoomEvidence = await page.evaluate(() => ({
    layoutHeight: document.documentElement.clientHeight,
    layoutWidth: document.documentElement.clientWidth,
    visualHeight: window.visualViewport?.height ?? 0,
    visualWidth: window.visualViewport?.width ?? 0,
  }));
  expect(zoomEvidence.layoutWidth).toBe(1280);
  expect(zoomEvidence.layoutHeight).toBe(800);
  expect(zoomEvidence.visualWidth).toBeCloseTo(640, 0);
  expect(zoomEvidence.visualHeight).toBeCloseTo(400, 0);

  const zoomSwitcher = page.locator(".crm-shell__desktop-sidebar")
    .getByRole("button", { name: /Tukar syarikat/ });
  await zoomSwitcher.focus();
  await page.keyboard.press("Enter");
  const zoomListbox = page.getByRole("listbox", { name: "Syarikat" });
  await expectContainedInVisualViewport(page, zoomListbox);
  await expectNoCriticalOrSeriousAxeViolations(page);
  await page.keyboard.press("Escape");
  await expect(zoomListbox).toBeHidden();
  await expectFocusVisible(zoomSwitcher);

  await session.send("Emulation.resetPageScaleFactor");
  await session.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1 });
  await expect.poll(() => page.evaluate(() => window.visualViewport?.scale ?? 1)).toBe(1);

  await page.setViewportSize({ height: 800, width: 640 });
  expect(await page.evaluate(() => document.documentElement.clientWidth)).toBe(640);
  expect(await page.evaluate(() => matchMedia("(max-width: 900px)").matches)).toBe(true);
  await expectNoHorizontalOverflow(page);

  const menuButton = page.getByRole("button", { name: "Buka menu navigasi" });
  await menuButton.focus();
  await page.keyboard.press("Enter");
  await expectContained(page, page.getByRole("dialog", { name: "Navigasi utama" }));
  await expectNoCriticalOrSeriousAxeViolations(page);
});

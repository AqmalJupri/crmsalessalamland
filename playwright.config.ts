import { defineConfig, devices } from "@playwright/test";

type E2eSurface = "crm" | "tasha";

const surfacePorts = {
  crm: 3201,
  tasha: 3202,
} as const satisfies Record<E2eSurface, number>;

function requireSurface(): E2eSurface {
  const value = process.env.E2E_PRODUCT_SURFACE;
  if (value !== "crm" && value !== "tasha") {
    throw new Error("E2E_PRODUCT_SURFACE must be exactly crm or tasha.");
  }
  return value;
}

function requirePort(surface: E2eSurface): number {
  const raw = process.env.E2E_PORT;
  if (!raw || !/^\d+$/.test(raw)) {
    throw new Error("E2E_PORT must be an explicit decimal port.");
  }
  const port = Number(raw);
  if (port !== surfacePorts[surface]) {
    throw new Error(
      `E2E_PORT for ${surface} must be ${surfacePorts[surface]}.`,
    );
  }
  return port;
}

const surface = requireSurface();
const port = requirePort(surface);
const baseURL = `http://127.0.0.1:${port}`;

if (process.env.PRODUCT_SURFACE !== surface) {
  throw new Error("PRODUCT_SURFACE must match E2E_PRODUCT_SURFACE.");
}
if (process.env.APP_URL !== baseURL) {
  throw new Error(`APP_URL must match the isolated ${surface} URL ${baseURL}.`);
}

function chromiumProject(
  name: string,
  width: number,
  height: number,
  mobile: boolean,
) {
  return {
    name,
    use: {
      ...devices["Desktop Chrome"],
      browserName: "chromium" as const,
      deviceScaleFactor: 1,
      hasTouch: mobile,
      isMobile: mobile,
      screen: { width, height },
      viewport: { width, height },
    },
  };
}

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  outputDir: `.playwright/${surface}/test-results`,
  preserveOutput: "failures-only",
  retries: process.env.CI ? 2 : 0,
  reporter: [
    [process.env.CI ? "github" : "list"],
    [
      "html",
      {
        open: "never",
        outputFolder: `.playwright/${surface}/report`,
      },
    ],
  ],
  snapshotPathTemplate:
    `tests/e2e/__snapshots__/${surface}/{testFilePath}/{projectName}/{arg}{ext}`,
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    chromiumProject("mobile-chromium-320x800", 320, 800, true),
    chromiumProject("mobile-chromium-375x812", 375, 812, true),
    chromiumProject("mobile-chromium-390x844", 390, 844, true),
    chromiumProject("desktop-chromium-768x1024", 768, 1024, false),
    chromiumProject("desktop-chromium-1024x768", 1024, 768, false),
    chromiumProject("desktop-chromium-1280x800", 1280, 800, false),
    chromiumProject("desktop-chromium-1440x900", 1440, 900, false),
  ],
  webServer: {
    command: `pnpm exec next dev --hostname 127.0.0.1 --port ${port}`,
    url: `${baseURL}/api/health/live`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});

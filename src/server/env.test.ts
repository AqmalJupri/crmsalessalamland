import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getRuntimeConfig, resetRuntimeConfigForTests } from "./env";

const originalEnvironment = { ...process.env };

const canonicalHosts = {
  crm: "crm.salamland.my",
  tasha: "tasha.salamland.my",
} as const;

function readExampleEnvironment() {
  return Object.fromEntries(
    readFileSync(new URL("../../.env.example", import.meta.url), "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

function useProductionEnvironment(surface: keyof typeof canonicalHosts = "crm") {
  const origin = `https://${canonicalHosts[surface]}`;
  process.env = {
    ...process.env,
    NODE_ENV: "production",
    PRODUCT_SURFACE: surface,
    DEPLOYMENT_ENVIRONMENT: "production",
    CRM_DEMO_MODE: "false",
    APP_URL: origin,
    AUTH_HASH_KEY: "production-auth-hash-key-at-least-32-characters",
    OIDC_ISSUER: "https://identity.example.test/tenant",
    OIDC_CLIENT_ID: `${surface}-web`,
    OIDC_CLIENT_SECRET: "production-client-secret-at-least-16",
    OIDC_REDIRECT_URI: `${origin}/api/v1/auth/oidc/callback`,
  };
}

beforeEach(() => {
  process.env = {
    ...originalEnvironment,
    NODE_ENV: "test",
    PRODUCT_SURFACE: "crm",
    DEPLOYMENT_ENVIRONMENT: "ci",
    DATABASE_URL: "postgresql://crm:crm@127.0.0.1:5432/crm_salam_test_env",
    APP_URL: "http://127.0.0.1:3000",
    CRM_DEMO_MODE: "true",
    AUTH_HASH_KEY: "test-auth-hash-key-at-least-32-characters",
  };
  delete process.env.DATABASE_POOL_MAX;
  delete process.env.OIDC_ISSUER;
  delete process.env.OIDC_CLIENT_ID;
  delete process.env.OIDC_CLIENT_SECRET;
  delete process.env.OIDC_REDIRECT_URI;
  resetRuntimeConfigForTests();
});

describe("product deployment configuration", () => {
  it.each(["crm", "tasha"] as const)("parses the %s product surface", (surface) => {
    process.env.PRODUCT_SURFACE = surface;

    expect(getRuntimeConfig()).toMatchObject({ productSurface: surface });
  });

  it.each(["local", "ci", "staging"] as const)(
    "parses the %s deployment environment",
    (deploymentEnvironment) => {
      process.env.DEPLOYMENT_ENVIRONMENT = deploymentEnvironment;

      expect(getRuntimeConfig()).toMatchObject({ deploymentEnvironment });
    },
  );

  it("rejects an invalid product surface", () => {
    process.env.PRODUCT_SURFACE = "backoffice";

    expect(() => getRuntimeConfig()).toThrow(/PRODUCT_SURFACE/);
  });

  it("rejects an invalid deployment environment", () => {
    process.env.DEPLOYMENT_ENVIRONMENT = "preview";

    expect(() => getRuntimeConfig()).toThrow(/DEPLOYMENT_ENVIRONMENT/);
  });

  it.each(["PRODUCT_SURFACE", "DEPLOYMENT_ENVIRONMENT"] as const)(
    "requires explicit %s in production",
    (field) => {
      useProductionEnvironment();
      delete process.env[field];

      expect(() => getRuntimeConfig()).toThrow(new RegExp(field));
    },
  );

  it("requires NODE_ENV=production for a production deployment", () => {
    process.env.DEPLOYMENT_ENVIRONMENT = "production";
    process.env.APP_URL = "https://crm.salamland.my";

    expect(() => getRuntimeConfig()).toThrow(/DEPLOYMENT_ENVIRONMENT.*NODE_ENV.*production/i);
  });

  it("forbids a local deployment when NODE_ENV=production", () => {
    useProductionEnvironment();
    process.env.DEPLOYMENT_ENVIRONMENT = "local";

    expect(() => getRuntimeConfig()).toThrow(/NODE_ENV.*production.*DEPLOYMENT_ENVIRONMENT.*local/i);
  });

  it.each(["crm", "tasha"] as const)(
    "accepts the exact canonical production origin for %s",
    (surface) => {
      useProductionEnvironment(surface);

      expect(getRuntimeConfig()).toMatchObject({
        nodeEnv: "production",
        productSurface: surface,
        deploymentEnvironment: "production",
        appUrl: `https://${canonicalHosts[surface]}`,
      });
    },
  );

  it.each([
    [
      "another surface host",
      "https://tasha.salamland.my",
      "https://tasha.salamland.my/api/v1/auth/oidc/callback",
    ],
    [
      "an explicit canonical port",
      "https://crm.salamland.my:443",
      "https://crm.salamland.my:443/api/v1/auth/oidc/callback",
    ],
    [
      "an empty explicit canonical port",
      "https://crm.salamland.my:",
      "https://crm.salamland.my:/api/v1/auth/oidc/callback",
    ],
  ])("rejects %s for the CRM production origin", (_label, appUrl, redirectUri) => {
    useProductionEnvironment("crm");
    process.env.APP_URL = appUrl;
    process.env.OIDC_REDIRECT_URI = redirectUri;

    expect(() => getRuntimeConfig()).toThrow(/APP_URL.*canonical.*crm\.salamland\.my/i);
  });

  it("enforces redirect-origin coherence when optional OIDC settings are present", () => {
    process.env.DEPLOYMENT_ENVIRONMENT = "local";
    process.env.OIDC_REDIRECT_URI =
      "http://other.example.test/api/v1/auth/oidc/callback";

    expect(() => getRuntimeConfig()).toThrow(/OIDC_REDIRECT_URI.*origin/i);
  });

  it("keeps the local example environment internally coherent", () => {
    process.env = {
      ...process.env,
      ...readExampleEnvironment(),
      NODE_ENV: "development",
    };

    expect(getRuntimeConfig()).toMatchObject({
      productSurface: "crm",
      deploymentEnvironment: "local",
      appUrl: "http://localhost:3000",
    });
  });
});

afterEach(() => {
  process.env = { ...originalEnvironment };
  resetRuntimeConfigForTests();
});

describe("database pool configuration", () => {
  it("uses a conservative per-process default", () => {
    expect(getRuntimeConfig().databasePoolMax).toBe(10);
  });

  it("accepts an explicit connection budget", () => {
    process.env.DATABASE_POOL_MAX = "7";
    expect(getRuntimeConfig().databasePoolMax).toBe(7);
  });

  it("rejects a connection budget outside the safe range", () => {
    process.env.DATABASE_POOL_MAX = "101";
    expect(() => getRuntimeConfig()).toThrow(/DATABASE_POOL_MAX/);
  });
});

describe("runtime authentication configuration", () => {
  it("caches a validated configuration for the process lifetime", () => {
    const first = getRuntimeConfig();
    process.env.DATABASE_POOL_MAX = "7";

    expect(getRuntimeConfig()).toBe(first);
    expect(getRuntimeConfig().databasePoolMax).toBe(10);
  });

  it("rejects demo mode in production", () => {
    process.env = { ...process.env, NODE_ENV: "production" };

    expect(() => getRuntimeConfig()).toThrow(/demo_mode must be disabled in production/i);
  });

  it("requires the complete OIDC configuration outside demo mode", () => {
    delete process.env.CRM_DEMO_MODE;

    expect(() => getRuntimeConfig()).toThrow(/OIDC_ISSUER.*required/i);
  });

  it("exposes a complete OIDC configuration outside demo mode", () => {
    delete process.env.CRM_DEMO_MODE;
    process.env.APP_URL = "https://crm.example.test";
    process.env.OIDC_ISSUER = "https://identity.example.test";
    process.env.OIDC_CLIENT_ID = "crm-web";
    process.env.OIDC_CLIENT_SECRET = "oidc-client-secret-at-least-16";
    process.env.OIDC_REDIRECT_URI = "https://crm.example.test/api/v1/auth/oidc/callback";

    expect(getRuntimeConfig()).toMatchObject({
      demoMode: false,
      oidc: {
        issuer: "https://identity.example.test",
        clientId: "crm-web",
        clientSecret: "oidc-client-secret-at-least-16",
        redirectUri: "https://crm.example.test/api/v1/auth/oidc/callback",
      },
    });
  });

  it("rejects a non-PostgreSQL database URL", () => {
    process.env.DATABASE_URL = "https://database.example.test/crm";

    expect(() => getRuntimeConfig()).toThrow(/DATABASE_URL.*PostgreSQL/i);
  });

  it.each([
    ["insecure app origin", { APP_URL: "http://crm.example.test" }, /APP_URL.*HTTPS/i],
    ["issuer protocol", { OIDC_ISSUER: "ftp://identity.example.test" }, /OIDC_ISSUER.*HTTPS/i],
    [
      "redirect origin",
      { OIDC_REDIRECT_URI: "https://other.example.test/api/v1/auth/oidc/callback" },
      /OIDC_REDIRECT_URI.*origin/i,
    ],
    [
      "redirect path",
      { OIDC_REDIRECT_URI: "https://crm.example.test/callback" },
      /OIDC_REDIRECT_URI.*path/i,
    ],
    ["app query", { APP_URL: "https://crm.example.test?debug=1" }, /APP_URL.*query/i],
    [
      "placeholder hash key",
      { AUTH_HASH_KEY: "replace-with-at-least-32-random-characters" },
      /AUTH_HASH_KEY.*placeholder/i,
    ],
    [
      "placeholder client secret",
      { OIDC_CLIENT_SECRET: "replace-from-secret-manager" },
      /OIDC_CLIENT_SECRET.*placeholder/i,
    ],
  ])("rejects incoherent production configuration: %s", (_label, override, expected) => {
    process.env = {
      ...process.env,
      NODE_ENV: "production",
      CRM_DEMO_MODE: "false",
      APP_URL: "https://crm.example.test",
      OIDC_ISSUER: "https://identity.example.test/tenant",
      OIDC_CLIENT_ID: "crm-web",
      OIDC_CLIENT_SECRET: "production-client-secret-at-least-16",
      OIDC_REDIRECT_URI: "https://crm.example.test/api/v1/auth/oidc/callback",
      ...override,
    };

    expect(() => getRuntimeConfig()).toThrow(expected);
  });

  it("accepts coherent HTTPS production origins", () => {
    process.env = {
      ...process.env,
      NODE_ENV: "production",
      CRM_DEMO_MODE: "false",
      APP_URL: "https://crm.example.test",
      OIDC_ISSUER: "https://identity.example.test/tenant",
      OIDC_CLIENT_ID: "crm-web",
      OIDC_CLIENT_SECRET: "production-client-secret-at-least-16",
      OIDC_REDIRECT_URI: "https://crm.example.test/api/v1/auth/oidc/callback",
    };

    expect(getRuntimeConfig()).toMatchObject({
      nodeEnv: "production",
      demoMode: false,
      appUrl: "https://crm.example.test",
    });
  });
});

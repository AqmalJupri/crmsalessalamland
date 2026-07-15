import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getRuntimeConfig, resetRuntimeConfigForTests } from "./env";

const originalEnvironment = { ...process.env };

beforeEach(() => {
  process.env = {
    ...originalEnvironment,
    NODE_ENV: "test",
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

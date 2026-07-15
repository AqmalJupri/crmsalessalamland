import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runtimeConfig: vi.fn(),
  beginOidc: vi.fn(),
  completeOidc: vi.fn(),
  establishOidcSession: vi.fn(),
  cookieValues: new Map<string, string>(),
  cookieWrites: [] as Array<{ name: string; value: string; options: Record<string, unknown> }>,
}));

vi.mock("@/server/env", () => ({ getRuntimeConfig: mocks.runtimeConfig }));
vi.mock("@/server/auth/oidc", () => ({
  beginOidc: mocks.beginOidc,
  completeOidc: mocks.completeOidc,
}));
vi.mock("@/server/auth/session", () => ({
  establishOidcSession: mocks.establishOidcSession,
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = mocks.cookieValues.get(name);
      return value === undefined ? undefined : { name, value };
    },
    set: (name: string, value: string, options: Record<string, unknown>) => {
      mocks.cookieValues.set(name, value);
      mocks.cookieWrites.push({ name, value, options });
    },
  }),
}));

import { GET as oidcStart } from "@/app/api/v1/auth/oidc/start/route";
import { GET as oidcCallback } from "@/app/api/v1/auth/oidc/callback/route";

beforeEach(() => {
  process.env = { ...process.env, NODE_ENV: "test" };
  vi.clearAllMocks();
  mocks.cookieValues.clear();
  mocks.cookieWrites.length = 0;
  mocks.runtimeConfig.mockReturnValue({
    nodeEnv: "development",
    demoMode: true,
    appUrl: "http://127.0.0.1:3000",
  });
});

describe("OIDC route boundaries", () => {
  it.each([
    "//evil.example",
    "/\\evil.example",
    "/%5cevil.example",
    "/..//evil.example/path",
    "/%2e%2e//evil.example/path",
    "https://evil.example",
  ])(
    "keeps unsafe demo returnTo on the configured application origin: %s",
    async (returnTo) => {
      const request = new Request(
        `http://127.0.0.1:3000/api/v1/auth/oidc/start?returnTo=${encodeURIComponent(returnTo)}`,
      );
      const response = await oidcStart(request);
      const location = new URL(response.headers.get("location")!);

      expect(response.status).toBe(303);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(location.origin).toBe("http://127.0.0.1:3000");
      expect(location.pathname).toBe("/");
      expect(mocks.beginOidc).not.toHaveBeenCalled();
    },
  );

  it("preserves a valid relative destination in demo mode", async () => {
    const returnTo = "/leads?owner=me#today";
    const response = await oidcStart(
      new Request(
        `http://127.0.0.1:3000/api/v1/auth/oidc/start?returnTo=${encodeURIComponent(returnTo)}`,
      ),
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("location")).toBe("http://127.0.0.1:3000/leads?owner=me#today");
  });

  it("marks the identity-provider redirect as non-cacheable", async () => {
    mocks.runtimeConfig.mockReturnValue({
      nodeEnv: "production",
      demoMode: false,
      appUrl: "https://crm.example.test",
    });
    mocks.beginOidc.mockResolvedValue({
      transaction: "sealed-transaction",
      url: new URL("https://identity.example.test/authorize?state=opaque"),
    });

    const response = await oidcStart(
      new Request("https://crm.example.test/api/v1/auth/oidc/start?returnTo=%2Fleads"),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("location")).toBe(
      "https://identity.example.test/authorize?state=opaque",
    );
  });

  it("deletes the transaction cookie without persisting an anonymous callback failure", async () => {
    const response = await oidcCallback(
      new Request("http://127.0.0.1:3000/api/v1/auth/oidc/callback?code=invalid&state=invalid"),
    );

    expect(response.status).toBe(400);
    expect(mocks.cookieWrites).toContainEqual(
      expect.objectContaining({
        name: "crm_oidc_transaction",
        value: "",
        options: expect.objectContaining({ expires: new Date(0) }),
      }),
    );
    expect(mocks.completeOidc).not.toHaveBeenCalled();
    expect(mocks.establishOidcSession).not.toHaveBeenCalled();
  });

  it("bounds repeated missing-cookie callbacks to zero durable login-attempt writes", async () => {
    const responses = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      responses.push(
        await oidcCallback(
          new Request(
            `http://127.0.0.1:3000/api/v1/auth/oidc/callback?code=invalid-${attempt}&state=invalid-${attempt}`,
          ),
        ),
      );
    }

    expect(responses.map((response) => response.status)).toEqual([400, 400, 400]);
    expect(responses.map((response) => response.headers.get("cache-control"))).toEqual([
      "no-store",
      "no-store",
      "no-store",
    ]);
    expect(mocks.completeOidc).not.toHaveBeenCalled();
    expect(mocks.establishOidcSession).not.toHaveBeenCalled();
  });

  it("uses the hardened destination and deletes the transaction cookie on callback success", async () => {
    process.env = { ...process.env, NODE_ENV: "production" };
    mocks.runtimeConfig.mockReturnValue({
      nodeEnv: "production",
      demoMode: false,
      appUrl: "https://crm.example.test",
    });
    mocks.cookieValues.set("crm_oidc_transaction", "sealed-transaction");
    mocks.completeOidc.mockResolvedValue({
      identity: { authSubject: "https://identity.example.test#agent" },
      returnTo: "/\\evil.example",
    });
    mocks.establishOidcSession.mockResolvedValue(undefined);

    const response = await oidcCallback(
      new Request("https://crm.example.test/api/v1/auth/oidc/callback?code=valid&state=valid"),
    );
    const location = new URL(response.headers.get("location")!);

    expect(response.status).toBe(303);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(location.href).toBe("https://crm.example.test/");
    expect(mocks.establishOidcSession).toHaveBeenCalledOnce();
    expect(mocks.cookieWrites.at(-1)).toMatchObject({
      name: "crm_oidc_transaction",
      value: "",
      options: { secure: true, sameSite: "lax", path: "/api/v1/auth/oidc" },
    });
  });
});

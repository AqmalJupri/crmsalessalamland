import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  config: vi.fn(),
  cookieWrites: [] as Array<{ name: string; value: string; options: Record<string, unknown> }>,
  requireApiViewer: vi.fn(),
  updateActiveSessionBusinessUnit: vi.fn(),
}));

vi.mock("@/server/env", () => ({ getRuntimeConfig: mocks.config }));
vi.mock("@/server/auth/viewer", () => ({ requireApiViewer: mocks.requireApiViewer }));
vi.mock("@/server/auth/session", () => ({
  updateActiveSessionBusinessUnit: mocks.updateActiveSessionBusinessUnit,
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    set: (name: string, value: string, options: Record<string, unknown>) => {
      mocks.cookieWrites.push({ name, value, options });
    },
  }),
}));

import { BUSINESS_UNIT_PREFERENCE_BODY_MAX_BYTES, POST } from "./route";
import { ApiError } from "@/server/http/errors";

const salamId = "00000000-0000-4000-8000-000000000101";
const unknownId = "00000000-0000-4000-8000-000000000199";
const bumiId = "00000000-0000-4000-8000-000000000102";
const expiresAt = new Date("2026-07-17T12:00:00.000Z");
const viewer = {
  businessUnitAccess: [
    {
      id: salamId,
      code: "salam-land",
      name: "Salam Land",
      capabilities: [],
      membershipIds: ["membership-salam"],
      capabilityRecordScopes: {},
    },
    {
      id: bumiId,
      code: "bumi-hayat",
      name: "Bumi Hayat",
      capabilities: [],
      membershipIds: ["membership-bumi"],
      capabilityRecordScopes: {},
    },
  ],
};

function request(
  body: string = JSON.stringify({ businessUnitId: salamId }),
  headers: Record<string, string> = {},
): Request {
  return new Request("https://crm.salamland.my/api/v1/auth/business-unit", {
    method: "POST",
    headers: {
      origin: "https://crm.salamland.my",
      "content-type": "application/json",
      ...headers,
    },
    body,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.cookieWrites.length = 0;
  mocks.config.mockReturnValue({
    appUrl: "https://crm.salamland.my",
    nodeEnv: "production",
    productSurface: "crm",
  });
  mocks.requireApiViewer.mockResolvedValue(viewer);
  mocks.updateActiveSessionBusinessUnit.mockResolvedValue(expiresAt);
});

describe("POST /api/v1/auth/business-unit", () => {
  it("updates one allowed preference and sets an HttpOnly session-bounded cookie", async () => {
    const response = await POST(request());

    expect(response.status).toBe(204);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.requireApiViewer).toHaveBeenCalledWith();
    expect(mocks.updateActiveSessionBusinessUnit).toHaveBeenCalledWith(viewer, salamId);
    expect(mocks.cookieWrites).toEqual([
      {
        name: "crm_bu",
        value: salamId,
        options: {
          expires: expiresAt,
          httpOnly: true,
          path: "/",
          priority: "high",
          sameSite: "lax",
          secure: true,
        },
      },
    ]);
  });

  it("uses non-Secure cookies outside production", async () => {
    mocks.config.mockReturnValue({
      appUrl: "http://127.0.0.1:3000",
      nodeEnv: "development",
      productSurface: "crm",
    });
    const response = await POST(new Request("http://127.0.0.1:3000/api/v1/auth/business-unit", {
      method: "POST",
      headers: { origin: "http://127.0.0.1:3000", "content-type": "application/json" },
      body: JSON.stringify({ businessUnitId: salamId }),
    }));
    expect(response.status).toBe(204);
    expect(mocks.cookieWrites[0]?.options).toMatchObject({ secure: false, httpOnly: true });
  });

  it.each([
    { origin: undefined, label: "missing" },
    { origin: "https://evil.example", label: "cross-origin" },
  ])("rejects $label Origin as CSRF before auth or mutation", async ({ origin }) => {
    const headers = origin === undefined ? { origin: "" } : { origin };
    const response = await POST(request(undefined, headers));

    expect(response.status).toBe(403);
    expect(mocks.requireApiViewer).not.toHaveBeenCalled();
    expect(mocks.updateActiveSessionBusinessUnit).not.toHaveBeenCalled();
    expect(mocks.cookieWrites).toEqual([]);
  });

  it("rejects an unknown unit without updating the session or cookie", async () => {
    const response = await POST(request(JSON.stringify({ businessUnitId: unknownId })));
    expect(response.status).toBe(403);
    expect(mocks.updateActiveSessionBusinessUnit).not.toHaveBeenCalled();
    expect(mocks.cookieWrites).toEqual([]);
  });

  it("requires an authenticated viewer", async () => {
    mocks.requireApiViewer.mockRejectedValueOnce(
      new ApiError(401, "UNAUTHENTICATED", "Log masuk diperlukan."),
    );
    const response = await POST(request());
    expect(response.status).toBe(401);
    expect(mocks.updateActiveSessionBusinessUnit).not.toHaveBeenCalled();
    expect(mocks.cookieWrites).toEqual([]);
  });

  it.each([
    ["malformed JSON", "{not-json", 400],
    [
      "valid JSON with an extra key",
      JSON.stringify({ businessUnitId: salamId, role: "admin" }),
      422,
    ],
    [
      "actual streamed bytes over the limit",
      JSON.stringify({
        businessUnitId: salamId,
        padding: "x".repeat(BUSINESS_UNIT_PREFERENCE_BODY_MAX_BYTES),
      }),
      413,
    ],
  ])("rejects %s with exact status", async (_label, candidate, expectedStatus) => {
    const response = await POST(request(candidate));
    expect(response.status).toBe(expectedStatus);
    expect(mocks.updateActiveSessionBusinessUnit).not.toHaveBeenCalled();
    expect(mocks.cookieWrites).toEqual([]);
  });

  it("does not set a cookie when the durable session update fails", async () => {
    mocks.updateActiveSessionBusinessUnit.mockRejectedValueOnce(
      new ApiError(401, "SESSION_EXPIRED", "Sesi telah tamat. Log masuk semula."),
    );
    const response = await POST(request());
    expect(response.status).toBe(401);
    expect(mocks.cookieWrites).toEqual([]);
  });

  it("rejects a non-Salam preference on Tasha without session or cookie mutation", async () => {
    mocks.config.mockReturnValue({
      appUrl: "https://tasha.salamland.my",
      nodeEnv: "production",
      productSurface: "tasha",
    });
    const response = await POST(new Request(
      "https://tasha.salamland.my/api/v1/auth/business-unit",
      {
        method: "POST",
        headers: {
          origin: "https://tasha.salamland.my",
          "content-type": "application/json",
        },
        body: JSON.stringify({ businessUnitId: bumiId }),
      },
    ));
    expect(response.status).toBe(403);
    expect(mocks.updateActiveSessionBusinessUnit).not.toHaveBeenCalled();
    expect(mocks.cookieWrites).toEqual([]);
  });
});

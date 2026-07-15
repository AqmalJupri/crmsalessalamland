import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertTrustedOrigin: vi.fn(),
  createLead: vi.fn(),
  requireApiViewer: vi.fn(),
}));

vi.mock("@/server/http/security", () => ({
  assertTrustedOrigin: mocks.assertTrustedOrigin,
}));
vi.mock("@/server/auth/viewer", () => ({
  requireApiViewer: mocks.requireApiViewer,
}));
vi.mock("@/server/leads/create-lead", () => ({
  createLead: mocks.createLead,
}));

import { LEAD_CREATE_BODY_MAX_BYTES, POST } from "./route";

const requestId = "0195f4f8-8e36-7dd1-8f14-c31f0edb30d6";

const validLeadBody = {
  businessUnitId: "00000000-0000-4000-8000-000000000101",
  name: "Duplicate Lead",
  phone: "0123456789",
  source: "website",
};

function leadRequest({
  body = JSON.stringify(validLeadBody),
  contentLength,
}: {
  body?: string;
  contentLength?: string;
} = {}): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "idempotency-key": "route-duplicate-lead-001",
    "x-request-id": requestId,
  };
  if (contentLength !== undefined) headers["content-length"] = contentLength;

  return new Request("http://localhost/api/v1/leads", {
    method: "POST",
    headers,
    body,
  });
}

describe("POST /api/v1/leads duplicate mapping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireApiViewer.mockResolvedValue({
      businessUnitId: "00000000-0000-4000-8000-000000000101",
    });
  });

  it.each([
    [
      "top-level",
      Object.assign(new Error("unique violation"), {
        code: "23505",
        constraint_name: "leads_provider_external_unique",
      }),
    ],
    [
      "Drizzle-wrapped",
      new Error("Failed query: insert into leads", {
        cause: Object.assign(new Error("duplicate key value"), {
          code: "23505",
          constraint_name: "leads_provider_external_unique",
        }),
      }),
    ],
  ])("maps a %s PostgreSQL duplicate to the public conflict contract", async (_label, error) => {
    mocks.createLead.mockRejectedValueOnce(error);

    const response = await POST(leadRequest());

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: {
        code: "DUPLICATE_EXTERNAL_LEAD",
        message: "Lead provider ini telah direkodkan.",
      },
      requestId,
    });
  });

  it("does not map a nonmatching wrapped database error", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.createLead.mockRejectedValueOnce(
      new Error("sensitive query text", {
        cause: Object.assign(new Error("sensitive database detail"), {
          code: "23505",
          constraint_name: "another_unique_constraint",
        }),
      }),
    );

    const response = await POST(leadRequest());

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: { code: "INTERNAL_ERROR", message: "Permintaan tidak dapat diproses." },
      requestId,
    });
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain("sensitive");
  });

  it("rejects an oversized declared body before parsing or creating a lead", async () => {
    const response = await POST(
      leadRequest({ contentLength: String(LEAD_CREATE_BODY_MAX_BYTES + 1) }),
    );

    expect(response.status).toBe(413);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      error: {
        code: "PAYLOAD_TOO_LARGE",
        message: "Badan permintaan terlalu besar.",
      },
      requestId,
    });
    expect(mocks.createLead).not.toHaveBeenCalled();
  });

  it.each([
    ["without Content-Length", undefined],
    ["with a spoofed small Content-Length", "128"],
  ])("rejects actual streamed bytes over the limit %s", async (_label, contentLength) => {
    const oversizedBody = JSON.stringify({
      ...validLeadBody,
      attribution: { payload: "x".repeat(LEAD_CREATE_BODY_MAX_BYTES) },
    });

    const response = await POST(
      leadRequest({
        body: oversizedBody,
        ...(contentLength !== undefined ? { contentLength } : {}),
      }),
    );

    expect(response.status).toBe(413);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      error: {
        code: "PAYLOAD_TOO_LARGE",
        message: "Badan permintaan terlalu besar.",
      },
      requestId,
    });
    expect(mocks.createLead).not.toHaveBeenCalled();
  });

  it("measures actual UTF-8 bytes instead of JavaScript character count", async () => {
    const oversizedBody = JSON.stringify({
      ...validLeadBody,
      attribution: { payload: "🙂".repeat(9_000) },
    });
    expect(oversizedBody.length).toBeLessThan(LEAD_CREATE_BODY_MAX_BYTES);

    const response = await POST(leadRequest({ body: oversizedBody }));

    expect(response.status).toBe(413);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.createLead).not.toHaveBeenCalled();
  });

  it("accepts a valid JSON body at the exact byte boundary", async () => {
    const encodedBody = JSON.stringify(validLeadBody);
    const body = encodedBody.padEnd(LEAD_CREATE_BODY_MAX_BYTES, " ");
    mocks.createLead.mockResolvedValueOnce({
      lead: { id: "00000000-0000-4000-8000-000000000501" },
      replayed: false,
      responseCode: 201,
    });

    const response = await POST(
      leadRequest({ body, contentLength: String(LEAD_CREATE_BODY_MAX_BYTES) }),
    );

    expect(new TextEncoder().encode(body)).toHaveLength(LEAD_CREATE_BODY_MAX_BYTES);
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.createLead).toHaveBeenCalledOnce();
  });

  it.each(["", "-1", "+128", "12.5", "unknown", "1, 2"])(
    "rejects an invalid Content-Length value: %s",
    async (contentLength) => {
      const response = await POST(leadRequest({ contentLength }));

      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({
        error: {
          code: "INVALID_CONTENT_LENGTH",
          message: "Panjang badan permintaan tidak sah.",
        },
        requestId,
      });
      expect(mocks.createLead).not.toHaveBeenCalled();
    },
  );

  it("keeps malformed JSON on the existing lead-validation contract", async () => {
    const response = await POST(leadRequest({ body: "{not-json" }));

    expect(response.status).toBe(422);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      error: {
        code: "INVALID_LEAD",
        message: "Semak maklumat lead.",
        details: { fields: {} },
      },
      requestId,
    });
    expect(mocks.createLead).not.toHaveBeenCalled();
  });
});

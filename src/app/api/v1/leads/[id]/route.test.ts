import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertTrustedOrigin: vi.fn(),
  requireApiViewer: vi.fn(),
  transitionLeadRecord: vi.fn(),
}));

vi.mock("@/server/http/security", () => ({
  assertTrustedOrigin: mocks.assertTrustedOrigin,
}));
vi.mock("@/server/auth/viewer", () => ({
  requireApiViewer: mocks.requireApiViewer,
}));
vi.mock("@/server/leads/transition-lead", () => ({
  transitionLeadRecord: mocks.transitionLeadRecord,
}));

import { PATCH } from "./route";

const requestId = "0195f4f8-8e36-7dd1-8f14-c31f0edb30d6";

function request(idempotencyKey = "lead-transition-route-001"): Request {
  return new Request("https://crm.example.test/api/v1/leads/bad-id", {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
      "x-request-id": requestId,
    },
    body: JSON.stringify({ version: 1, stage: "assigned" }),
  });
}

describe("PATCH /api/v1/leads/:id", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireApiViewer.mockResolvedValue({ businessUnitId: crypto.randomUUID() });
  });

  it("rejects a UUID-shaped string that is not a valid UUID before calling the service", async () => {
    const response = await PATCH(request(), {
      params: Promise.resolve({ id: "------------------------------------" }),
    });

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      error: { code: "INVALID_LEAD_ID", message: "ID lead tidak sah." },
      requestId,
    });
    expect(mocks.transitionLeadRecord).not.toHaveBeenCalled();
  });

  it("passes a valid UUID and parsed transition to the service", async () => {
    const leadId = "10000000-0000-4000-8000-000000000001";
    mocks.transitionLeadRecord.mockResolvedValue({
      changed: true,
      lead: { id: leadId, stage: "assigned", version: 2 },
    });

    const response = await PATCH(request(), { params: Promise.resolve({ id: leadId }) });

    expect(response.status).toBe(200);
    expect(mocks.transitionLeadRecord).toHaveBeenCalledWith(
      expect.anything(),
      leadId,
      { version: 1, stage: "assigned" },
      requestId,
      "lead-transition-route-001",
    );
  });

  it("requires a stable idempotency key before parsing or calling the service", async () => {
    const leadId = "10000000-0000-4000-8000-000000000001";
    const response = await PATCH(request(""), { params: Promise.resolve({ id: leadId }) });

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      error: { code: "IDEMPOTENCY_KEY_REQUIRED", message: "Kunci permintaan diperlukan." },
      requestId,
    });
    expect(mocks.transitionLeadRecord).not.toHaveBeenCalled();
  });
});

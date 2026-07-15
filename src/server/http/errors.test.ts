import { afterEach, describe, expect, it, vi } from "vitest";
import { DomainError } from "@/domain/shared/errors";
import { ApiError, requestIdFrom, toErrorResponse } from "./errors";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("toErrorResponse", () => {
  it("preserves an explicit API error contract", async () => {
    const response = toErrorResponse(
      new ApiError(401, "UNAUTHENTICATED", "Sign in required.", { returnTo: "/leads" }),
      "request-1",
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      error: {
        code: "UNAUTHENTICATED",
        message: "Sign in required.",
        details: { returnTo: "/leads" },
      },
      requestId: "request-1",
    });
  });

  it.each([
    ["FORBIDDEN", 403],
    ["CONFLICT", 409],
    ["VALIDATION_ERROR", 422],
  ] as const)("maps the %s domain error to HTTP %i", async (code, status) => {
    const response = toErrorResponse(new DomainError(code, "Domain policy rejected the request."));

    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      error: {
        code,
        message: "Domain policy rejected the request.",
        details: {},
      },
    });
  });

  it("logs only stable metadata for an unhandled sensitive error", async () => {
    const requestId = "0195f4f8-8e36-7dd1-8f14-c31f0edb30d6";
    const error = Object.assign(new Error("raw-auth-subject-and-token"), {
      code: "23505",
      query: "select * from users where auth_subject = $1",
      parameters: ["raw-auth-subject"],
    });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = toErrorResponse(error, requestId);
    const logged = JSON.stringify(errorLog.mock.calls);

    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(errorLog).toHaveBeenCalledWith("Unhandled API error", {
      requestId,
      error: { name: "Error", code: "23505" },
    });
    expect(logged).not.toContain("raw-auth-subject");
    expect(logged).not.toContain("select *");
    expect(await response.json()).toEqual({
      error: { code: "INTERNAL_ERROR", message: "Permintaan tidak dapat diproses." },
      requestId,
    });
  });

  it("drops unsafe name and code metadata from non-Error values", () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    toErrorResponse({ name: "not trusted", code: "unsafe code", secret: "do-not-log" });

    expect(errorLog).toHaveBeenCalledWith("Unhandled API error", {
      requestId: undefined,
      error: { name: "UnknownError" },
    });
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain("do-not-log");
  });
});

describe("requestIdFrom", () => {
  it("accepts a well-formed caller request id", () => {
    const supplied = "0195f4f8-8e36-7dd1-8f14-c31f0edb30d6";

    expect(
      requestIdFrom(new Request("http://localhost", { headers: { "x-request-id": supplied } })),
    ).toBe(supplied);
  });

  it("generates request ids for absent and malformed headers", () => {
    const generatedForAbsent = "0195f4f8-8e36-7dd1-8f14-c31f0edb30d7";
    const generatedForMalformed = "0195f4f8-8e36-7dd1-8f14-c31f0edb30d8";
    const randomUuid = vi
      .spyOn(crypto, "randomUUID")
      .mockReturnValueOnce(generatedForAbsent)
      .mockReturnValueOnce(generatedForMalformed);

    expect(requestIdFrom(new Request("http://localhost"))).toBe(generatedForAbsent);
    expect(
      requestIdFrom(
        new Request("http://localhost", { headers: { "x-request-id": "not-a-valid-uuid" } }),
      ),
    ).toBe(generatedForMalformed);
    expect(randomUuid).toHaveBeenCalledTimes(2);
  });
});

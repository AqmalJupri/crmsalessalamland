import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { config, proxy } from "./proxy";

const trustedPathHeader = "x-salam-request-path";

function forwardedRequestHeader(response: Response, name: string): string | null {
  return response.headers.get(`x-middleware-request-${name}`);
}

describe("proxy trusted request path", () => {
  it.each([
    ["?bu=salam-land&bu=bumi-hayat", "multiple"],
    ["?bu=", "empty"],
    [`?bu=${"x".repeat(65)}`, "overlong"],
    ["?bu=Salam-Land", "uppercase"],
    ["?bu=salam--land", "malformed"],
  ])("rejects %s business scope before forwarding (%s)", (query) => {
    const response = proxy(new NextRequest(`https://crm.salamland.my/leads${query}`));

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(forwardedRequestHeader(response, trustedPathHeader)).toBeNull();
  });

  it.each(["all", "salam-land", "a1-b2"])(
    "forwards one canonical business scope: %s",
    (scope) => {
      const response = proxy(
        new NextRequest(`https://crm.salamland.my/leads?bu=${scope}`),
      );
      expect(response.status).toBe(200);
      expect(forwardedRequestHeader(response, trustedPathHeader)).toBe("/leads");
    },
  );

  it.each([
    ["https://crm.salamland.my/", "/"],
    ["https://crm.salamland.my/inventory/stock-123?tab=history", "/inventory/stock-123"],
  ])("forwards only the URL pathname for %s", (url, expectedPath) => {
    const response = proxy(new NextRequest(url));

    expect(forwardedRequestHeader(response, trustedPathHeader)).toBe(expectedPath);
    expect(
      response.headers.get("x-middleware-override-headers")?.split(","),
    ).toContain(trustedPathHeader);
  });

  it("overwrites a forged inbound trusted-path header", () => {
    const response = proxy(
      new NextRequest("https://tasha.salamland.my/leads", {
        headers: { [trustedPathHeader]: "/inventory" },
      }),
    );

    expect(forwardedRequestHeader(response, trustedPathHeader)).toBe("/leads");
  });

  it("runs for exact router-prefetch requests so valid requests never lose the trusted path", () => {
    expect(config).toEqual({
      matcher: [
        {
          source: "/((?!api|_next/static|_next/image|favicon.ico).*)",
        },
      ],
    });
  });
});

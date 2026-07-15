import { describe, expect, it, vi } from "vitest";
import { evaluateReadiness } from "./readiness";

describe("evaluateReadiness", () => {
  it("reports invalid configuration as unavailable instead of throwing", async () => {
    const result = await evaluateReadiness(
      () => {
        throw new Error("invalid configuration");
      },
      vi.fn(),
    );

    expect(result).toEqual({
      statusCode: 503,
      body: {
        status: "degraded",
        dependencies: { configuration: "invalid", database: "unknown" },
      },
    });
  });

  it("does not contact the database in local demo mode", async () => {
    const ping = vi.fn();
    const result = await evaluateReadiness(
      () => ({ demoMode: true, nodeEnv: "development" }),
      ping,
    );

    expect(ping).not.toHaveBeenCalled();
    expect(result.body).toMatchObject({ status: "ok", dependencies: { database: "bypassed" } });
  });

  it("reports a database failure without leaking its error", async () => {
    const result = await evaluateReadiness(
      () => ({ demoMode: false, nodeEnv: "production" }),
      async () => {
        throw new Error("password was exposed here");
      },
    );

    expect(result).toEqual({
      statusCode: 503,
      body: {
        status: "degraded",
        dependencies: { configuration: "valid", database: "unavailable" },
      },
    });
    expect(JSON.stringify(result)).not.toContain("password");
  });

  it("reports ready only after the complete database check succeeds", async () => {
    const checkDatabase = vi.fn().mockResolvedValue(undefined);

    const result = await evaluateReadiness(
      () => ({ demoMode: false, nodeEnv: "production" }),
      checkDatabase,
    );

    expect(checkDatabase).toHaveBeenCalledOnce();
    expect(result).toEqual({
      statusCode: 200,
      body: {
        status: "ok",
        dependencies: { configuration: "valid", database: "ready" },
      },
    });
  });
});

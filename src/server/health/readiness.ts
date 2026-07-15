interface ReadinessConfiguration {
  demoMode: boolean;
  nodeEnv: "development" | "test" | "production";
}

interface ReadinessResult {
  statusCode: 200 | 503;
  body: {
    status: "ok" | "degraded";
    mode?: "demo";
    dependencies: {
      configuration?: "valid" | "invalid";
      database: "bypassed" | "ready" | "unavailable" | "unknown";
    };
  };
}

export async function evaluateReadiness(
  loadConfiguration: () => ReadinessConfiguration,
  pingDatabase: () => Promise<unknown> | unknown,
): Promise<ReadinessResult> {
  let configuration: ReadinessConfiguration;
  try {
    configuration = loadConfiguration();
  } catch {
    return {
      statusCode: 503,
      body: {
        status: "degraded",
        dependencies: { configuration: "invalid", database: "unknown" },
      },
    };
  }

  if (configuration.demoMode && configuration.nodeEnv !== "production") {
    return {
      statusCode: 200,
      body: { status: "ok", mode: "demo", dependencies: { database: "bypassed" } },
    };
  }

  try {
    await pingDatabase();
    return {
      statusCode: 200,
      body: {
        status: "ok",
        dependencies: { configuration: "valid", database: "ready" },
      },
    };
  } catch {
    return {
      statusCode: 503,
      body: {
        status: "degraded",
        dependencies: { configuration: "valid", database: "unavailable" },
      },
    };
  }
}

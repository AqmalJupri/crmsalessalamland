import { z } from "zod";
import {
  getProductSurfaceSpec,
  type DeploymentEnvironment,
  type ProductSurface,
} from "@/config/product-surface";

const truthy = new Set(["1", "true", "yes", "on"]);

const runtimeSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PRODUCT_SURFACE: z.enum(["crm", "tasha"]),
  DEPLOYMENT_ENVIRONMENT: z.enum(["local", "ci", "staging", "production"]),
  DATABASE_URL: z.string().url(),
  APP_URL: z.string().url(),
  CRM_DEMO_MODE: z.string().optional(),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(12),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  AUTH_HASH_KEY: z.string().min(32),
  OIDC_ISSUER: z.string().url().optional(),
  OIDC_CLIENT_ID: z.string().min(1).optional(),
  OIDC_CLIENT_SECRET: z.string().min(16).optional(),
  OIDC_REDIRECT_URI: z.string().url().optional(),
});

type ParsedRuntime = z.infer<typeof runtimeSchema>;

const oidcCallbackPath = "/api/v1/auth/oidc/callback";
const placeholderSecretPattern = /^(?:replace|change[-_ ]?me|example)(?:\b|[-_])/i;

function invalidConfiguration(message: string): never {
  throw new Error(`Invalid runtime configuration: ${message}`);
}

function assertCleanPublicUrl(url: URL, field: string, allowPath: boolean): void {
  if (url.username || url.password) {
    invalidConfiguration(`${field} must not include credentials.`);
  }
  if (url.search) invalidConfiguration(`${field} must not include a query string.`);
  if (url.hash) invalidConfiguration(`${field} must not include a fragment.`);
  if (!allowPath && url.pathname !== "/") {
    invalidConfiguration(`${field} must be an origin without a path.`);
  }
}

function validateRuntimeConfiguration(data: ParsedRuntime, demoMode: boolean): void {
  const databaseUrl = new URL(data.DATABASE_URL);
  if (!new Set(["postgres:", "postgresql:"]).has(databaseUrl.protocol)) {
    invalidConfiguration("DATABASE_URL must use the PostgreSQL protocol.");
  }

  const appUrl = new URL(data.APP_URL);
  if (!new Set(["http:", "https:"]).has(appUrl.protocol)) {
    invalidConfiguration("APP_URL must use HTTP or HTTPS.");
  }
  assertCleanPublicUrl(appUrl, "APP_URL", false);
  if (data.NODE_ENV === "production" && appUrl.protocol !== "https:") {
    invalidConfiguration("APP_URL must use HTTPS in production.");
  }

  if (data.DEPLOYMENT_ENVIRONMENT === "production") {
    if (data.NODE_ENV !== "production") {
      invalidConfiguration("DEPLOYMENT_ENVIRONMENT=production requires NODE_ENV=production.");
    }
    const surface = getProductSurfaceSpec(data.PRODUCT_SURFACE);
    const canonicalOrigin = `https://${surface.canonicalHost}`;
    const allowedSpellings = new Set([canonicalOrigin, `${canonicalOrigin}/`]);
    if (!allowedSpellings.has(data.APP_URL)) {
      invalidConfiguration(
        `APP_URL must use the canonical ${canonicalOrigin} origin without an explicit port for PRODUCT_SURFACE=${surface.key}.`,
      );
    }
  }

  if (data.NODE_ENV === "production" && data.DEPLOYMENT_ENVIRONMENT === "local") {
    invalidConfiguration("NODE_ENV=production forbids DEPLOYMENT_ENVIRONMENT=local.");
  }

  if (data.OIDC_ISSUER) {
    const issuer = new URL(data.OIDC_ISSUER);
    if (!new Set(["http:", "https:"]).has(issuer.protocol)) {
      invalidConfiguration("OIDC_ISSUER must use HTTP or HTTPS.");
    }
    assertCleanPublicUrl(issuer, "OIDC_ISSUER", true);
    if (data.NODE_ENV === "production" && issuer.protocol !== "https:") {
      invalidConfiguration("OIDC_ISSUER must use HTTPS in production.");
    }
  }

  if (data.OIDC_REDIRECT_URI) {
    const redirect = new URL(data.OIDC_REDIRECT_URI);
    if (!new Set(["http:", "https:"]).has(redirect.protocol)) {
      invalidConfiguration("OIDC_REDIRECT_URI must use HTTP or HTTPS.");
    }
    assertCleanPublicUrl(redirect, "OIDC_REDIRECT_URI", true);
    if (data.NODE_ENV === "production" && redirect.protocol !== "https:") {
      invalidConfiguration("OIDC_REDIRECT_URI must use HTTPS in production.");
    }
    if (redirect.origin !== appUrl.origin) {
      invalidConfiguration("OIDC_REDIRECT_URI origin must match APP_URL.");
    }
    if (redirect.pathname !== oidcCallbackPath) {
      invalidConfiguration(`OIDC_REDIRECT_URI path must be ${oidcCallbackPath}.`);
    }
  }

  if (data.NODE_ENV === "production") {
    if (placeholderSecretPattern.test(data.AUTH_HASH_KEY)) {
      invalidConfiguration("AUTH_HASH_KEY must not be a known placeholder secret.");
    }
    if (
      !demoMode &&
      data.OIDC_CLIENT_SECRET &&
      placeholderSecretPattern.test(data.OIDC_CLIENT_SECRET)
    ) {
      invalidConfiguration("OIDC_CLIENT_SECRET must not be a known placeholder secret.");
    }
  }
}

export interface RuntimeConfig {
  nodeEnv: "development" | "test" | "production";
  productSurface: ProductSurface;
  deploymentEnvironment: DeploymentEnvironment;
  databaseUrl: string;
  appUrl: string;
  demoMode: boolean;
  sessionTtlHours: number;
  databasePoolMax: number;
  authHashKey: string;
  oidc?: {
    issuer: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
  };
}

let cached: RuntimeConfig | undefined;

export function getRuntimeConfig(): RuntimeConfig {
  if (cached) return cached;

  const parsed = runtimeSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(`Invalid runtime configuration: ${z.prettifyError(parsed.error)}`);
  }

  const demoMode = truthy.has(parsed.data.CRM_DEMO_MODE?.toLowerCase() ?? "false");
  if (parsed.data.NODE_ENV === "production" && demoMode) {
    throw new Error("CRM_DEMO_MODE must be disabled in production.");
  }

  const oidcValues = [
    parsed.data.OIDC_ISSUER,
    parsed.data.OIDC_CLIENT_ID,
    parsed.data.OIDC_CLIENT_SECRET,
    parsed.data.OIDC_REDIRECT_URI,
  ];
  if (!demoMode && oidcValues.some((value) => !value)) {
    throw new Error("OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, and OIDC_REDIRECT_URI are required.");
  }
  validateRuntimeConfiguration(parsed.data, demoMode);

  cached = {
    nodeEnv: parsed.data.NODE_ENV,
    productSurface: parsed.data.PRODUCT_SURFACE,
    deploymentEnvironment: parsed.data.DEPLOYMENT_ENVIRONMENT,
    databaseUrl: parsed.data.DATABASE_URL,
    appUrl: parsed.data.APP_URL,
    demoMode,
    sessionTtlHours: parsed.data.SESSION_TTL_HOURS,
    databasePoolMax: parsed.data.DATABASE_POOL_MAX,
    authHashKey: parsed.data.AUTH_HASH_KEY,
    ...(!demoMode
      ? {
          oidc: {
            issuer: parsed.data.OIDC_ISSUER!,
            clientId: parsed.data.OIDC_CLIENT_ID!,
            clientSecret: parsed.data.OIDC_CLIENT_SECRET!,
            redirectUri: parsed.data.OIDC_REDIRECT_URI!,
          },
        }
      : {}),
  };
  return cached;
}

export function resetRuntimeConfigForTests(): void {
  cached = undefined;
}

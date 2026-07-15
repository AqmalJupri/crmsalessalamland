import "server-only";

import * as client from "openid-client";
import { getRuntimeConfig } from "@/server/env";
import { ApiError } from "@/server/http/errors";
import { OIDC_TRANSACTION_MAX_AGE_SECONDS } from "./constants";
import { sealAuthState, unsealAuthState } from "./crypto";
import { safeReturnTo } from "./return-to";

const TRANSACTION_MAX_AGE_MS = OIDC_TRANSACTION_MAX_AGE_SECONDS * 1_000;
const CLOCK_SKEW_MS = 60 * 1_000;

interface OidcTransaction extends Record<string, unknown> {
  codeVerifier: string;
  state: string;
  nonce: string;
  returnTo: string;
  issuedAt: number;
}

export interface OidcIdentity {
  authSubject: string;
  displayName: string;
  emailHashInput?: string;
}

let cachedConfiguration: client.Configuration | undefined;

function oidcSettings() {
  const settings = getRuntimeConfig().oidc;
  if (!settings) throw new ApiError(503, "OIDC_NOT_CONFIGURED", "Log masuk belum dikonfigurasi.");
  return settings;
}

async function oidcConfiguration(): Promise<client.Configuration> {
  if (cachedConfiguration) return cachedConfiguration;
  const settings = oidcSettings();
  cachedConfiguration = await client.discovery(
    new URL(settings.issuer),
    settings.clientId,
    settings.clientSecret,
  );
  return cachedConfiguration;
}

export async function beginOidc(returnTo: string): Promise<{ url: URL; transaction: string }> {
  const configuration = await oidcConfiguration();
  const settings = oidcSettings();
  const codeVerifier = client.randomPKCECodeVerifier();
  const state = client.randomState();
  const nonce = client.randomNonce();
  const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
  const url = client.buildAuthorizationUrl(configuration, {
    redirect_uri: settings.redirectUri,
    scope: "openid profile email",
    response_type: "code",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
    nonce,
  });
  const transaction = sealAuthState({
    codeVerifier,
    state,
    nonce,
    returnTo: safeReturnTo(returnTo),
    issuedAt: Date.now(),
  });
  return { url, transaction };
}

function isOidcTransaction(value: unknown): value is OidcTransaction {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<OidcTransaction>;
  return (
    typeof candidate.codeVerifier === "string" &&
    typeof candidate.state === "string" &&
    typeof candidate.nonce === "string" &&
    typeof candidate.returnTo === "string" &&
    typeof candidate.issuedAt === "number"
  );
}

export async function completeOidc(
  callbackRequestUrl: string,
  sealedTransaction: string,
): Promise<{ identity: OidcIdentity; returnTo: string }> {
  let unpacked: unknown;
  try {
    unpacked = unsealAuthState<unknown>(sealedTransaction);
  } catch {
    throw new ApiError(400, "OIDC_TRANSACTION_INVALID", "Sesi log masuk tidak sah. Cuba semula.");
  }
  const transactionAge = isOidcTransaction(unpacked) ? Date.now() - unpacked.issuedAt : undefined;
  if (
    !isOidcTransaction(unpacked) ||
    transactionAge === undefined ||
    transactionAge > TRANSACTION_MAX_AGE_MS ||
    transactionAge < -CLOCK_SKEW_MS
  ) {
    throw new ApiError(400, "OIDC_TRANSACTION_EXPIRED", "Sesi log masuk tamat. Cuba semula.");
  }

  const configuration = await oidcConfiguration();
  const settings = oidcSettings();
  const incoming = new URL(callbackRequestUrl);
  const expected = new URL(settings.redirectUri);
  if (incoming.origin !== expected.origin || incoming.pathname !== expected.pathname) {
    throw new ApiError(400, "OIDC_CALLBACK_URI_MISMATCH", "Alamat balas log masuk tidak sah.");
  }
  expected.search = incoming.search;
  const tokens = await client.authorizationCodeGrant(configuration, expected, {
    pkceCodeVerifier: unpacked.codeVerifier,
    expectedState: unpacked.state,
    expectedNonce: unpacked.nonce,
    idTokenExpected: true,
  });
  const claims = tokens.claims();
  if (!claims?.sub) throw new ApiError(401, "OIDC_SUBJECT_MISSING", "Identiti tidak sah.");

  const issuer = configuration.serverMetadata().issuer;
  const nameClaim = claims.name ?? claims.preferred_username ?? claims.email;
  const displayName = typeof nameClaim === "string" && nameClaim.trim() ? nameClaim.trim() : "Pengguna CRM";
  const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : undefined;

  return {
    returnTo: safeReturnTo(unpacked.returnTo),
    identity: {
      authSubject: `${issuer}#${claims.sub}`,
      displayName,
      ...(email ? { emailHashInput: email } : {}),
    },
  };
}

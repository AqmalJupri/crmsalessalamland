import { createHash, createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { resetRuntimeConfigForTests } from "@/server/env";
import {
  hashSensitiveLookup,
  hashSessionToken,
  newSessionToken,
  sealAuthState,
  unsealAuthState,
} from "./crypto";

const originalEnvironment = { ...process.env };
const authHashKey = "unit-auth-hash-key-at-least-32-characters";

beforeEach(() => {
  process.env = {
    ...originalEnvironment,
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://crm:crm@127.0.0.1:5432/crm_salam_test_crypto",
    APP_URL: "http://127.0.0.1:3000",
    CRM_DEMO_MODE: "true",
    AUTH_HASH_KEY: authHashKey,
  };
  resetRuntimeConfigForTests();
});

afterEach(() => {
  process.env = { ...originalEnvironment };
  resetRuntimeConfigForTests();
});

describe("authentication cryptography", () => {
  it("creates independent high-entropy URL-safe session tokens", () => {
    const first = newSessionToken();
    const second = newSessionToken();

    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second).not.toBe(first);
  });

  it("hashes session tokens and sensitive lookups with their distinct contracts", () => {
    const value = "subject@example.test";

    expect(Buffer.from(hashSessionToken(value))).toEqual(
      createHash("sha256").update(value).digest(),
    );
    expect(Buffer.from(hashSensitiveLookup(value))).toEqual(
      createHmac("sha256", authHashKey).update(value).digest(),
    );
    expect(Buffer.from(hashSensitiveLookup(value))).not.toEqual(
      Buffer.from(hashSessionToken(value)),
    );
  });

  it("round-trips sealed state and rejects truncated or tampered ciphertext", () => {
    const state = { nonce: "oidc-nonce", returnTo: "/finance", issuedAt: 1234 };
    const sealed = sealAuthState(state);

    expect(unsealAuthState<typeof state>(sealed)).toEqual(state);
    expect(() => unsealAuthState("short")).toThrow(/invalid authentication state/i);

    const tampered = Buffer.from(sealed, "base64url");
    const lastIndex = tampered.length - 1;
    tampered[lastIndex] = tampered[lastIndex]! ^ 1;
    expect(() => unsealAuthState(tampered.toString("base64url"))).toThrow();
  });
});

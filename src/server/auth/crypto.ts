import "server-only";

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
} from "node:crypto";
import { getRuntimeConfig } from "@/server/env";

export function newSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSessionToken(token: string): Uint8Array {
  return createHash("sha256").update(token).digest();
}

export function hashSensitiveLookup(value: string): Uint8Array {
  return createHmac("sha256", getRuntimeConfig().authHashKey).update(value).digest();
}

function encryptionKey(): Buffer {
  return createHash("sha256").update(getRuntimeConfig().authHashKey).digest();
}

export function sealAuthState(value: Readonly<Record<string, unknown>>): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url");
}

export function unsealAuthState<T>(sealed: string): T {
  const value = Buffer.from(sealed, "base64url");
  if (value.length < 29) throw new Error("Invalid authentication state.");
  const iv = value.subarray(0, 12);
  const tag = value.subarray(12, 28);
  const ciphertext = value.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  return JSON.parse(plaintext) as T;
}

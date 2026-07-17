import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";
import { ApiError } from "@/server/http/errors";

const SHA256_BYTES = 32;
const MAX_PROTECTED_REF_LENGTH = 2_048;
const PLACEHOLDER_SEGMENT = /^(?:todo|tbd|placeholder|changeme|example)$/i;

class LocalArtifactChunkError extends ApiError {
  constructor() {
    super(
      422,
      "ARTIFACT_CHUNK_INVALID",
      "Protected artifact streams must yield byte chunks.",
    );
  }
}

export function assertSha256Digest(value: unknown, field: string): asserts value is Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength !== SHA256_BYTES) {
    throw new ApiError(422, "SHA256_DIGEST_INVALID", `${field} must be a 32-byte SHA-256 digest.`);
  }
}

export function digestsEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== SHA256_BYTES || right.byteLength !== SHA256_BYTES) return false;
  return timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

export function assertProtectedArtifactRef(value: unknown, field: string): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > MAX_PROTECTED_REF_LENGTH ||
    value !== value.trim() ||
    !/^[\x21-\x7e]+$/.test(value) ||
    /[\\%?#@]/.test(value) ||
    /^(?:https?|file):/i.test(value) ||
    value.startsWith("/") ||
    /^[A-Za-z]:/.test(value)
  ) {
    throw new ApiError(
      422,
      "PROTECTED_ARTIFACT_REF_INVALID",
      `${field} must be a protected provider reference.`,
    );
  }

  const pathPart = value.includes("://") ? value.slice(value.indexOf("://") + 3) : value;
  const segments = pathPart.split("/");
  if (
    segments.length === 0 ||
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        PLACEHOLDER_SEGMENT.test(segment),
    )
  ) {
    throw new ApiError(
      422,
      "PROTECTED_ARTIFACT_REF_INVALID",
      `${field} must be a canonical protected provider reference.`,
    );
  }
}

export async function computeSha256(
  source: AsyncIterable<Uint8Array>,
): Promise<{ sha256: Uint8Array; sizeBytes: bigint }> {
  const hash = createHash("sha256");
  let sizeBytes = 0n;
  try {
    for await (const chunk of source) {
      if (!(chunk instanceof Uint8Array)) {
        throw new LocalArtifactChunkError();
      }
      hash.update(chunk);
      sizeBytes += BigInt(chunk.byteLength);
    }
  } catch (error: unknown) {
    if (error instanceof LocalArtifactChunkError) throw error;
    throw new ApiError(
      422,
      "ARTIFACT_READ_FAILED",
      "Protected artifact stream could not be read.",
    );
  }
  return { sha256: hash.digest(), sizeBytes };
}

import "server-only";

import { isProxy, isUint8Array } from "node:util/types";
import { ApiError } from "@/server/http/errors";
import {
  assertProtectedArtifactRef,
  assertSha256Digest,
  digestsEqual,
} from "./artifact-checksum";

export interface VerifiedNormalizedEvidence {
  ref: string;
  sha256: Uint8Array;
}

export interface NormalizedEvidenceVerifier {
  verify(
    ref: string,
    expectedSha256: Uint8Array | null,
  ): Promise<VerifiedNormalizedEvidence>;
}

function verificationFailed(): never {
  throw new ApiError(
    422,
    "NORMALIZED_EVIDENCE_VERIFICATION_FAILED",
    "Normalized evidence could not be verified.",
  );
}

function bindingInvalid(): never {
  throw new ApiError(
    422,
    "NORMALIZED_EVIDENCE_BINDING_INVALID",
    "Verified normalized evidence did not bind the reviewed evidence.",
  );
}

function isOwnDataDescriptor(
  value: PropertyDescriptor | undefined,
): value is PropertyDescriptor & { value: unknown } {
  return value !== undefined && Object.prototype.hasOwnProperty.call(value, "value");
}

/**
 * Treats a verifier result as hostile input. Its own fields are described once,
 * copied immediately, and no verifier-owned object is consulted after validation.
 */
export async function verifyNormalizedEvidenceSnapshot(
  verifier: NormalizedEvidenceVerifier,
  reviewedRef: string,
  reviewedSha256: Uint8Array,
): Promise<VerifiedNormalizedEvidence> {
  let untrusted: unknown;
  try {
    untrusted = await verifier.verify(reviewedRef, new Uint8Array(reviewedSha256));
  } catch {
    verificationFailed();
  }

  try {
    if (untrusted === null || typeof untrusted !== "object" || isProxy(untrusted)) {
      bindingInvalid();
    }
    const prototype = Object.getPrototypeOf(untrusted);
    if (prototype !== Object.prototype && prototype !== null) bindingInvalid();

    const descriptors = Object.getOwnPropertyDescriptors(untrusted);
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.length !== 2 ||
      !keys.includes("ref") ||
      !keys.includes("sha256") ||
      !isOwnDataDescriptor(descriptors.ref) ||
      !isOwnDataDescriptor(descriptors.sha256)
    ) {
      bindingInvalid();
    }

    const refSnapshot = descriptors.ref.value;
    const digestValue = descriptors.sha256.value;
    if (
      typeof refSnapshot !== "string" ||
      digestValue === null ||
      typeof digestValue !== "object" ||
      isProxy(digestValue) ||
      !isUint8Array(digestValue)
    ) {
      bindingInvalid();
    }
    const digestSnapshot = new Uint8Array(digestValue);
    assertProtectedArtifactRef(refSnapshot, "normalizedEvidenceRef");
    assertSha256Digest(digestSnapshot, "normalizedSha256");
    assertProtectedArtifactRef(reviewedRef, "reviewedNormalizedEvidenceRef");
    assertSha256Digest(reviewedSha256, "reviewedNormalizedSha256");
    if (refSnapshot !== reviewedRef || !digestsEqual(digestSnapshot, reviewedSha256)) {
      bindingInvalid();
    }
    return { ref: refSnapshot, sha256: digestSnapshot };
  } catch {
    bindingInvalid();
  }
}

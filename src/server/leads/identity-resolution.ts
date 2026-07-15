export interface ContactIdentityCandidate {
  contactId: string;
  displayName: string;
  contactStatus: string;
  verificationStatus: string;
}

export type ContactIdentityDecision =
  | {
      kind: "REUSE_VERIFIED";
      contactId: string;
      reviewRequired: false;
    }
  | {
      kind: "CREATE_CONTACT";
      contactId: null;
      reviewRequired: boolean;
    };

/**
 * A phone match is only authoritative when it resolves to exactly one active,
 * verified contact. Any weaker or ambiguous match creates a separate contact
 * for review rather than silently merging identities.
 */
export function decideContactIdentity(
  candidates: readonly ContactIdentityCandidate[],
  incomingDisplayName: string,
): ContactIdentityDecision {
  const candidate = candidates.length === 1 ? candidates[0] : undefined;
  if (
    candidate &&
    candidate.contactStatus === "ACTIVE" &&
    candidate.verificationStatus === "VERIFIED" &&
    normalizeDisplayName(candidate.displayName) === normalizeDisplayName(incomingDisplayName)
  ) {
    return {
      kind: "REUSE_VERIFIED",
      contactId: candidate.contactId,
      reviewRequired: false,
    };
  }

  return {
    kind: "CREATE_CONTACT",
    contactId: null,
    reviewRequired: candidates.length > 0,
  };
}

function normalizeDisplayName(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("ms-MY").replace(/\s+/g, " ");
}

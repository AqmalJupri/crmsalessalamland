import { describe, expect, it } from "vitest";
import { decideContactIdentity } from "./identity-resolution";

describe("decideContactIdentity", () => {
  it("reuses exactly one active verified identity", () => {
    expect(
      decideContactIdentity([
        {
          contactId: "contact-1",
          displayName: "Aisyah Rahman",
          contactStatus: "ACTIVE",
          verificationStatus: "VERIFIED",
        },
      ], "  aisyah   rahman "),
    ).toEqual({
      kind: "REUSE_VERIFIED",
      contactId: "contact-1",
      reviewRequired: false,
    });
  });

  it("does not auto-link an unverified identity", () => {
    expect(
      decideContactIdentity([
        {
          contactId: "contact-1",
          displayName: "Aisyah Rahman",
          contactStatus: "ACTIVE",
          verificationStatus: "UNVERIFIED",
        },
      ], "Aisyah Rahman"),
    ).toEqual({
      kind: "CREATE_CONTACT",
      contactId: null,
      reviewRequired: true,
    });
  });

  it("does not auto-link ambiguous verified identities", () => {
    const decision = decideContactIdentity([
      {
        contactId: "contact-1",
        displayName: "Aisyah Rahman",
        contactStatus: "ACTIVE",
        verificationStatus: "VERIFIED",
      },
      {
        contactId: "contact-2",
        displayName: "Aisyah Rahman",
        contactStatus: "ACTIVE",
        verificationStatus: "VERIFIED",
      },
    ], "Aisyah Rahman");

    expect(decision.kind).toBe("CREATE_CONTACT");
    expect(decision.reviewRequired).toBe(true);
  });

  it("does not merge a shared verified phone when the person name differs", () => {
    expect(
      decideContactIdentity(
        [
          {
            contactId: "contact-1",
            displayName: "Aisyah Rahman",
            contactStatus: "ACTIVE",
            verificationStatus: "VERIFIED",
          },
        ],
        "Hakim Rahman",
      ),
    ).toEqual({
      kind: "CREATE_CONTACT",
      contactId: null,
      reviewRequired: true,
    });
  });
});

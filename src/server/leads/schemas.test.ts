import { describe, expect, it } from "vitest";
import {
  ATTRIBUTION_LIMITS,
  createLeadSchema,
  transitionLeadSchema,
  transitionReason,
} from "./schemas";

const businessUnitId = "00000000-0000-4000-8000-000000000101";

describe("lead request schemas", () => {
  it("keeps the existing create UI payload valid", () => {
    const result = createLeadSchema.safeParse({
      businessUnitId,
      name: "Nur Aisyah",
      phone: "0123456789",
      source: "Meta",
      productInterest: "Lot Banglo",
    });
    expect(result.success).toBe(true);
  });

  it("requires at least one source-provider alias", () => {
    const result = createLeadSchema.safeParse({
      businessUnitId,
      name: "Nur Aisyah",
      phone: "0123456789",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({ path: ["source"], message: "Sumber lead diperlukan." }),
      );
    }
  });

  it("rejects caller-controlled receivedAt instead of silently stripping it", () => {
    const result = createLeadSchema.safeParse({
      businessUnitId,
      name: "Nur Aisyah",
      phone: "0123456789",
      source: "Meta",
      receivedAt: "2026-07-15T12:00:00+08:00",
    });

    expect(result.success).toBe(false);
  });

  it("canonicalizes equivalent provider keys before comparing aliases", () => {
    const result = createLeadSchema.safeParse({
      businessUnitId,
      name: "Nur Aisyah",
      phone: "0123456789",
      source: " Meta ",
      sourceProvider: "meta",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.source).toBe("meta");
      expect(result.data.sourceProvider).toBe("meta");
    }
  });

  it("rejects conflicting source-provider aliases", () => {
    const result = createLeadSchema.safeParse({
      businessUnitId,
      name: "Nur Aisyah",
      phone: "0123456789",
      source: "meta",
      sourceProvider: "google-ads",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({
          path: ["sourceProvider"],
          message: "Sumber lead tidak sepadan.",
        }),
      );
    }
  });

  it("rejects conflicting external lead id aliases", () => {
    const result = createLeadSchema.safeParse({
      businessUnitId,
      name: "Nur Aisyah",
      phone: "0123456789",
      source: "meta",
      sourceExternalId: "meta-lead-1",
      externalLeadId: "meta-lead-2",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({
          path: ["externalLeadId"],
          message: "ID lead luar tidak sepadan.",
        }),
      );
    }
  });

  it("rejects provider keys outside the stable safe-key format", () => {
    const result = createLeadSchema.safeParse({
      businessUnitId,
      name: "Nur Aisyah",
      phone: "0123456789",
      source: "Meta Ads!",
    });

    expect(result.success).toBe(false);
  });

  it("accepts conventional canonical provider keys with dots and underscores", () => {
    const result = createLeadSchema.safeParse({
      businessUnitId,
      name: "Nur Aisyah",
      phone: "0123456789",
      sourceProvider: " Meta.Lead_Ads ",
    });

    expect(result).toMatchObject({
      success: true,
      data: { sourceProvider: "meta.lead_ads" },
    });
  });

  it("accepts bounded provider attribution with JSON scalar, object, and array values", () => {
    const result = createLeadSchema.safeParse({
      businessUnitId,
      name: "Nur Aisyah",
      phone: "0123456789",
      source: "meta.lead_ads",
      attribution: {
        campaign: {
          id: "campaign-1",
          utm: {
            source: "meta",
            tags: ["retargeting", 2, true, null],
          },
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it.each([
    [
      "object key count",
      Object.fromEntries(
        Array.from({ length: ATTRIBUTION_LIMITS.maxKeysPerObject + 1 }, (_, index) => [
          `key-${index}`,
          index,
        ]),
      ),
    ],
    ["key length", { ["k".repeat(ATTRIBUTION_LIMITS.maxKeyLength + 1)]: "value" }],
    ["string length", { value: "x".repeat(ATTRIBUTION_LIMITS.maxStringLength + 1) }],
    [
      "array length",
      { values: Array.from({ length: ATTRIBUTION_LIMITS.maxArrayLength + 1 }, (_, index) => index) },
    ],
    [
      "total node count",
      Object.fromEntries(
        Array.from({ length: ATTRIBUTION_LIMITS.maxKeysPerObject }, (_, index) => [
          `group-${index}`,
          [index, index, index],
        ]),
      ),
    ],
    [
      "container depth",
      { level1: { level2: { level3: { level4: { value: "too deep" } } } } },
    ],
    ["non-finite number", { value: Number.POSITIVE_INFINITY }],
    ["non-JSON value", { value: undefined }],
    ["non-plain object", { value: new Date("2026-07-15T00:00:00Z") }],
  ])("rejects attribution outside the %s limit", (_label, attribution) => {
    const result = createLeadSchema.safeParse({
      businessUnitId,
      name: "Nur Aisyah",
      phone: "0123456789",
      source: "meta.lead_ads",
      attribution,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({ path: expect.arrayContaining(["attribution"]) }),
      );
    }
  });

  it("rejects attribution over the global key budget even when each object is small", () => {
    const attribution = Object.fromEntries(
      Array.from({ length: ATTRIBUTION_LIMITS.maxKeysPerObject }, (_, group) => [
        `group-${group}`,
        {
          first: group,
          second: group,
        },
      ]),
    );

    const result = createLeadSchema.safeParse({
      businessUnitId,
      name: "Nur Aisyah",
      phone: "0123456789",
      source: "meta.lead_ads",
      attribution,
    });

    expect(result.success).toBe(false);
  });

  it("rejects lead-level estimated value because value belongs to opportunity", () => {
    const result = createLeadSchema.safeParse({
      businessUnitId,
      name: "Nur Aisyah",
      phone: "0123456789",
      source: "Meta",
      estimatedValueMinor: 100_000,
    });
    expect(result.success).toBe(false);
  });

  it("accepts a configured stage code instead of a static enum", () => {
    expect(
      transitionLeadSchema.safeParse({ version: 3, stage: "site-visit-booked" }).success,
    ).toBe(true);
    expect(transitionLeadSchema.safeParse({ version: 3, stage: "Invalid Stage" }).success).toBe(
      false,
    );
  });

  it("rejects conflicting transition-reason aliases", () => {
    const result = transitionLeadSchema.safeParse({
      version: 3,
      stage: "disqualified",
      reason: "No financing",
      disqualificationReason: "No response",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({
          path: ["reason"],
          message: "Sebab peralihan tidak sepadan.",
        }),
      );
    }
  });

  it("resolves transition-reason aliases in canonical order", () => {
    expect(
      transitionReason({
        version: 3,
        stage: "disqualified",
        reason: "Canonical reason",
        disqualificationReason: "Legacy reason",
      }),
    ).toBe("Canonical reason");
    expect(
      transitionReason({
        version: 3,
        stage: "disqualified",
        disqualificationReason: "Legacy reason",
      }),
    ).toBe("Legacy reason");
    expect(transitionReason({ version: 3, stage: "contacted" })).toBeNull();
  });
});

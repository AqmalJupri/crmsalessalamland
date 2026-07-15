import { z } from "zod";

const pipelineStageCode = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9-]{1,62}$/, "Kod peringkat tidak sah.");

const optionalDateTime = z.iso.datetime({ offset: true }).optional();
const nullableReason = z.string().trim().max(500).nullable().optional();
export const SOURCE_PROVIDER_KEY_PATTERN = /^[a-z][a-z0-9._-]{1,79}$/;

export const ATTRIBUTION_LIMITS = {
  maxArrayLength: 20,
  maxContainerDepth: 3,
  maxKeyLength: 64,
  maxKeysPerObject: 32,
  maxStringLength: 1_024,
  maxTotalKeys: 64,
  maxTotalNodes: 128,
} as const;

const safeAttributionKeyPattern = /^[^\u0000-\u001f\u007f]+$/u;

function codePointLength(value: string): number {
  return Array.from(value).length;
}

const attributionSchema = z.record(z.string(), z.unknown()).superRefine((attribution, context) => {
  let totalKeys = 0;
  let totalNodes = 0;
  let globalBudgetExceeded = false;
  const ancestors = new WeakSet<object>();

  function addIssue(path: PropertyKey[], message: string): void {
    context.addIssue({ code: "custom", path, message });
  }

  function visit(value: unknown, containerDepth: number, path: PropertyKey[]): void {
    if (globalBudgetExceeded) return;
    totalNodes += 1;
    if (totalNodes > ATTRIBUTION_LIMITS.maxTotalNodes) {
      globalBudgetExceeded = true;
      addIssue(path, "Attribution terlalu kompleks.");
      return;
    }

    if (value === null || typeof value === "boolean") return;
    if (typeof value === "string") {
      if (codePointLength(value) > ATTRIBUTION_LIMITS.maxStringLength) {
        addIssue(path, "Nilai attribution terlalu panjang.");
      }
      return;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) addIssue(path, "Nilai attribution tidak sah.");
      return;
    }
    if (typeof value !== "object") {
      addIssue(path, "Nilai attribution tidak sah.");
      return;
    }

    if (containerDepth > ATTRIBUTION_LIMITS.maxContainerDepth) {
      addIssue(path, "Attribution terlalu dalam.");
      return;
    }
    if (ancestors.has(value)) {
      addIssue(path, "Nilai attribution tidak sah.");
      return;
    }

    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        if (value.length > ATTRIBUTION_LIMITS.maxArrayLength) {
          addIssue(path, "Senarai attribution terlalu panjang.");
          return;
        }
        value.forEach((item, index) => visit(item, containerDepth + 1, [...path, index]));
        return;
      }

      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        addIssue(path, "Nilai attribution tidak sah.");
        return;
      }

      const entries = Object.entries(value as Record<string, unknown>);
      if (entries.length > ATTRIBUTION_LIMITS.maxKeysPerObject) {
        addIssue(path, "Terlalu banyak medan attribution.");
        return;
      }
      totalKeys += entries.length;
      if (totalKeys > ATTRIBUTION_LIMITS.maxTotalKeys) {
        globalBudgetExceeded = true;
        addIssue(path, "Terlalu banyak medan attribution.");
        return;
      }

      for (const [key, nested] of entries) {
        const nestedPath = [...path, key];
        if (
          codePointLength(key) === 0 ||
          codePointLength(key) > ATTRIBUTION_LIMITS.maxKeyLength ||
          !safeAttributionKeyPattern.test(key)
        ) {
          addIssue(nestedPath, "Kunci attribution tidak sah.");
          continue;
        }
        visit(nested, containerDepth + 1, nestedPath);
      }
    } finally {
      ancestors.delete(value);
    }
  }

  visit(attribution, 0, []);
});

export const sourceProviderKeySchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(2)
  .max(80)
  .regex(SOURCE_PROVIDER_KEY_PATTERN, "Kunci provider tidak sah.");

export const createLeadSchema = z
  .object({
    businessUnitId: z.uuid(),
    name: z.string().trim().min(2).max(160),
    phone: z.string().trim().min(9).max(32),

    // `source` and `sourceExternalId` retain the first UI contract while the
    // provider-named fields are the canonical API vocabulary.
    source: sourceProviderKeySchema.optional(),
    sourceProvider: sourceProviderKeySchema.optional(),
    sourceChannel: z.string().trim().min(1).max(80).optional(),
    sourceExternalId: z.string().trim().min(1).max(200).optional(),
    externalLeadId: z.string().trim().min(1).max(200).optional(),
    providerOccurredAt: optionalDateTime,
    attribution: attributionSchema.optional(),

    // The current UI uses this as the lead title. There is no canonical
    // estimated-value field on a lead; value belongs to an opportunity.
    productInterest: z.string().trim().min(2).max(200).optional(),
    estimatedValueMinor: z.never().optional(),
    ownerMembershipId: z.uuid().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.source && !value.sourceProvider) {
      context.addIssue({
        code: "custom",
        path: ["source"],
        message: "Sumber lead diperlukan.",
      });
    }
    if (value.source && value.sourceProvider && value.source !== value.sourceProvider) {
      context.addIssue({
        code: "custom",
        path: ["sourceProvider"],
        message: "Sumber lead tidak sepadan.",
      });
    }
    if (
      value.sourceExternalId &&
      value.externalLeadId &&
      value.sourceExternalId !== value.externalLeadId
    ) {
      context.addIssue({
        code: "custom",
        path: ["externalLeadId"],
        message: "ID lead luar tidak sepadan.",
      });
    }
  });

export type CreateLeadInput = z.infer<typeof createLeadSchema>;

export const transitionLeadSchema = z
  .object({
    version: z.number().int().positive(),
    stage: pipelineStageCode,
    ownerMembershipId: z.uuid().nullable().optional(),
    reason: nullableReason,
    disqualificationReason: nullableReason,
    convertedOpportunityId: z.uuid().nullable().optional(),
  })
  .superRefine((value, context) => {
    if (
      value.reason &&
      value.disqualificationReason &&
      value.reason !== value.disqualificationReason
    ) {
      context.addIssue({
        code: "custom",
        path: ["reason"],
        message: "Sebab peralihan tidak sepadan.",
      });
    }
  });

export type TransitionLeadInput = z.infer<typeof transitionLeadSchema>;

export function transitionReason(input: TransitionLeadInput): string | null {
  return input.reason ?? input.disqualificationReason ?? null;
}

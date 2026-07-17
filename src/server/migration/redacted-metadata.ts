import "server-only";

import { isProxy } from "node:util/types";
import { ApiError } from "@/server/http/errors";

const MAX_METADATA_BYTES = 8_192;
const MAX_METADATA_DEPTH = 5;
const MAX_METADATA_COLLECTION = 128;
const MAX_METADATA_CODE_LENGTH = 128;
const METADATA_CODE_PATTERN = /^(?:[A-Z][A-Z0-9]*(?:[_.:-][A-Z0-9]+)*|[a-z][a-z0-9]*(?:[_.:-][a-z0-9]+)*)$/;

function metadataFailure(): never {
  throw new ApiError(
    422,
    "MIGRATION_METADATA_NOT_REDACTED",
    "Migration metadata must contain only bounded redacted codes.",
  );
}

export function migrationTextLooksSensitive(value: string): boolean {
  if (/[\u0000-\u001f\u007f]/.test(value)) return true;
  if (/[{}\[\]]/.test(value)) return true;
  if (/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(value)) return true;
  if (/(?:^|\D)\+?\d[\d\s().-]{7,}\d(?:\D|$)/.test(value)) return true;
  if (/\bBearer\s+[A-Za-z0-9._~+/=-]+\b/i.test(value)) return true;
  if (/\b(?:password|passwd|secret|token|api[_-]?key|authorization|cookie|credential)\s*[:=]/i.test(value)) {
    return true;
  }
  if (/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/.test(value)) {
    return true;
  }
  return false;
}

function keyLooksSensitive(key: string): boolean {
  const canonicalKey = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2");
  return /(?:^|[_.:-])(?:email|phone|mobile|telephone|name|address|nric|passport|password|passwd|secret|token|api[_-]?key|authorization|cookie|credential|payload|raw|customer|record)(?:$|[_.:-])/i.test(
    canonicalKey,
  );
}

function dataDescriptor(
  descriptor: PropertyDescriptor | undefined,
): descriptor is PropertyDescriptor & { value: unknown } {
  return (
    descriptor !== undefined &&
    descriptor.enumerable === true &&
    Object.prototype.hasOwnProperty.call(descriptor, "value")
  );
}

function snapshotValue(
  value: unknown,
  depth: number,
  ancestors: WeakSet<object>,
): unknown {
  if (depth > MAX_METADATA_DEPTH) metadataFailure();
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) metadataFailure();
    return value;
  }
  if (typeof value === "string") {
    if (
      value.length > MAX_METADATA_CODE_LENGTH ||
      !METADATA_CODE_PATTERN.test(value) ||
      migrationTextLooksSensitive(value)
    ) {
      metadataFailure();
    }
    return value;
  }
  if (typeof value !== "object" || isProxy(value)) metadataFailure();
  if (ancestors.has(value)) metadataFailure();
  ancestors.add(value);

  try {
    const prototype = Object.getPrototypeOf(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key === "symbol")) metadataFailure();

    if (Array.isArray(value)) {
      if (prototype !== Array.prototype) metadataFailure();
      const lengthDescriptor = descriptors.length;
      if (
        lengthDescriptor === undefined ||
        !Object.prototype.hasOwnProperty.call(lengthDescriptor, "value") ||
        !Number.isSafeInteger(lengthDescriptor.value) ||
        (lengthDescriptor.value as number) < 0 ||
        (lengthDescriptor.value as number) > MAX_METADATA_COLLECTION
      ) {
        metadataFailure();
      }
      const length = lengthDescriptor.value as number;
      const entryKeys = keys.filter(
        (key): key is string => typeof key === "string" && key !== "length",
      );
      if (entryKeys.length !== length) metadataFailure();
      const snapshot = new Array<unknown>(length);
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!dataDescriptor(descriptor)) metadataFailure();
        snapshot[index] = snapshotValue(descriptor.value, depth + 1, ancestors);
      }
      return snapshot;
    }

    if (prototype !== Object.prototype && prototype !== null) metadataFailure();
    if (keys.length > MAX_METADATA_COLLECTION) metadataFailure();
    const snapshot: Record<string, unknown> = {};
    for (const keyValue of keys) {
      if (typeof keyValue !== "string") metadataFailure();
      if (
        keyValue.length < 1 ||
        keyValue.length > 64 ||
        !/^[A-Za-z][A-Za-z0-9_.:-]*$/.test(keyValue) ||
        keyLooksSensitive(keyValue)
      ) {
        metadataFailure();
      }
      const descriptor = descriptors[keyValue];
      if (!dataDescriptor(descriptor)) metadataFailure();
      snapshot[keyValue] = snapshotValue(descriptor.value, depth + 1, ancestors);
    }
    return snapshot;
  } catch {
    metadataFailure();
  } finally {
    ancestors.delete(value);
  }
}

export function snapshotRedactedMigrationMetadata(
  value: unknown,
  field: string,
): Record<string, unknown> {
  void field;
  let snapshot: unknown;
  try {
    snapshot = snapshotValue(value, 0, new WeakSet<object>());
  } catch {
    metadataFailure();
  }
  if (
    snapshot === null ||
    typeof snapshot !== "object" ||
    Array.isArray(snapshot)
  ) {
    metadataFailure();
  }
  let encoded: string;
  try {
    encoded = JSON.stringify(snapshot);
  } catch {
    metadataFailure();
  }
  if (Buffer.byteLength(encoded, "utf8") > MAX_METADATA_BYTES) metadataFailure();
  return snapshot as Record<string, unknown>;
}

export function assertRedactedMigrationMetadata(
  value: unknown,
  field: string,
): asserts value is Readonly<Record<string, unknown>> {
  void snapshotRedactedMigrationMetadata(value, field);
}

export function canonicalRedactedMigrationMetadata(
  value: Readonly<Record<string, unknown>>,
): string {
  const canonical = (entry: unknown): string => {
    if (Array.isArray(entry)) return "[" + entry.map(canonical).join(",") + "]";
    if (entry !== null && typeof entry === "object") {
      const record = entry as Record<string, unknown>;
      return (
        "{" +
        Object.keys(record)
          .sort()
          .map((key) => JSON.stringify(key) + ":" + canonical(record[key]))
          .join(",") +
        "}"
      );
    }
    return JSON.stringify(entry);
  };
  return canonical(value);
}

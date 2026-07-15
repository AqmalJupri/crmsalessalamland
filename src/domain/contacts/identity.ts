import { DomainError } from "@/domain/shared/errors";

const digitsOnly = /\D/g;

export function normalizeMalaysianPhone(value: string): string {
  const digits = value.replace(digitsOnly, "");
  const local = digits.startsWith("60") ? digits.slice(2) : digits.startsWith("0") ? digits.slice(1) : digits;

  if (!/^1\d{8,9}$/.test(local)) {
    throw new DomainError(
      "VALIDATION_ERROR",
      "Masukkan nombor mudah alih Malaysia yang sah.",
    );
  }

  return `+60${local}`;
}

export function normalizeEmail(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new DomainError("VALIDATION_ERROR", "Masukkan alamat e-mel yang sah.");
  }
  return normalized;
}

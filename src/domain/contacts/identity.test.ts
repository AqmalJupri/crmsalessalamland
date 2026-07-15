import { describe, expect, it } from "vitest";
import { normalizeEmail, normalizeMalaysianPhone } from "./identity";

describe("contact identity normalization", () => {
  it.each([
    ["012-345 6789", "+60123456789"],
    ["+60 12 345 6789", "+60123456789"],
    ["60123456789", "+60123456789"],
  ])("normalizes %s", (input, expected) => {
    expect(normalizeMalaysianPhone(input)).toBe(expected);
  });

  it("rejects a non-mobile Malaysian number", () => {
    expect(() => normalizeMalaysianPhone("03-12345678")).toThrow(
      "Masukkan nombor mudah alih Malaysia yang sah.",
    );
  });

  it("normalizes email case and whitespace", () => {
    expect(normalizeEmail(" Sales@Example.COM ")).toBe("sales@example.com");
  });

  it("presents invalid email guidance in concise Malay", () => {
    expect(() => normalizeEmail("bukan-e-mel")).toThrow("Masukkan alamat e-mel yang sah.");
  });
});

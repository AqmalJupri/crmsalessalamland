import { describe, expect, it } from "vitest";
import { safeReturnTo } from "./return-to";

describe("safeReturnTo", () => {
  it.each([
    null,
    undefined,
    "",
    "https://evil.example/path",
    "//evil.example/path",
    "/\\evil.example/path",
    "/%5cevil.example/path",
    "/%2f%2fevil.example/path",
    "/..//evil.example/path",
    "/%2e%2e//evil.example/path",
    "/leads%0d%0aLocation:%20https://evil.example",
    "/leads\u0000",
    "javascript:alert(1)",
  ])(
    "falls back for unsafe value %s",
    (value) => {
      expect(safeReturnTo(value)).toBe("/");
    },
  );

  it("preserves an application-relative path, query, and fragment", () => {
    expect(safeReturnTo("/leads?owner=me#today")).toBe("/leads?owner=me#today");
  });
});

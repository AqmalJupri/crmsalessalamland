import { describe, expect, it } from "vitest";
import {
  readDocumentEvidence,
  requireDocumentEvidence,
  runWithCleanup,
} from "./runtime-evidence.mjs";

describe("runWithCleanup", () => {
  it("runs every cleanup step in order and returns the primary result", async () => {
    const calls = [];

    const result = await runWithCleanup(
      async () => {
        calls.push("primary");
        return "result";
      },
      [
        async () => {
          calls.push("fixture-a");
        },
        async () => {
          calls.push("fixture-b");
        },
        async () => {
          calls.push("connection");
        },
      ],
    );

    expect(result).toBe("result");
    expect(calls).toEqual(["primary", "fixture-a", "fixture-b", "connection"]);
  });

  it("surfaces a cleanup-only failure after attempting every cleanup step", async () => {
    const cleanupFailure = new Error("fixture cleanup failed");
    const calls = [];

    await expect(
      runWithCleanup(async () => "result", [
        async () => {
          calls.push("fixture");
          throw cleanupFailure;
        },
        async () => {
          calls.push("connection");
        },
      ]),
    ).rejects.toBe(cleanupFailure);
    expect(calls).toEqual(["fixture", "connection"]);
  });

  it("aggregates every cleanup-only failure in cleanup order", async () => {
    const firstCleanupFailure = new Error("first cleanup failed");
    const secondCleanupFailure = new Error("second cleanup failed");

    const rejection = await runWithCleanup(async () => undefined, [
      async () => {
        throw firstCleanupFailure;
      },
      async () => {
        throw secondCleanupFailure;
      },
    ]).catch((error) => error);

    expect(rejection).toBeInstanceOf(AggregateError);
    expect(rejection.errors).toEqual([firstCleanupFailure, secondCleanupFailure]);
  });

  it("preserves the primary failure first and every cleanup failure after it", async () => {
    const primaryFailure = new Error("primary failed");
    const firstCleanupFailure = new Error("first cleanup failed");
    const secondCleanupFailure = new Error("second cleanup failed");
    const calls = [];

    const rejection = await runWithCleanup(
      async () => {
        calls.push("primary");
        throw primaryFailure;
      },
      [
        async () => {
          calls.push("fixture-a");
          throw firstCleanupFailure;
        },
        async () => {
          calls.push("fixture-b");
        },
        async () => {
          calls.push("connection");
          throw secondCleanupFailure;
        },
      ],
    ).catch((error) => error);

    expect(rejection).toBeInstanceOf(AggregateError);
    expect(rejection.errors).toEqual([
      primaryFailure,
      firstCleanupFailure,
      secondCleanupFailure,
    ]);
    expect(calls).toEqual(["primary", "fixture-a", "fixture-b", "connection"]);
  });
});

const expectedDocument = {
  language: "ms",
  title: "Log masuk · Salam CRM",
  metadata: {
    "color-scheme": "light",
    "theme-color": "#0B172A",
    robots: "noindex, nofollow, noarchive",
  },
  forbiddenBodyText: ["Aqmal Jupri", "CRM dan revenue operations Salam"],
};

const validHead = `
  <head>
    <meta name="color-scheme" content="light">
    <meta name="theme-color" content="#0B172A">
    <meta name="robots" content="noindex, nofollow, noarchive">
    <title>Log masuk · Salam CRM</title>
  </head>
`;

describe("parsed document evidence", () => {
  it("reads decoded title, metadata, and visible body text from the parsed document", () => {
    const evidence = readDocumentEvidence(
      `<!doctype html><html lang="ms">${validHead}<body>Aqmal &#74;upri &amp; CRM dan revenue</body></html>`,
      Object.keys(expectedDocument.metadata),
    );

    expect(evidence).toEqual({
      language: "ms",
      title: "Log masuk · Salam CRM",
      metadata: expectedDocument.metadata,
      bodyText: "Aqmal Jupri & CRM dan revenue",
    });
  });

  it("rejects duplicate conflicting titles instead of accepting an existential match", () => {
    const html = `<!doctype html><html lang="ms"><head>
      <title>Log masuk · Salam CRM</title>
      <title>Decoy title</title>
      <meta name="color-scheme" content="light">
      <meta name="theme-color" content="#0B172A">
      <meta name="robots" content="noindex, nofollow, noarchive">
    </head><body></body></html>`;

    expect(() => requireDocumentEvidence(html, expectedDocument)).toThrow(
      /exactly one title/i,
    );
  });

  it("rejects duplicate conflicting relevant metadata instead of taking the first match", () => {
    const html = `<!doctype html><html lang="ms"><head>
      <title>Log masuk · Salam CRM</title>
      <meta name="color-scheme" content="light">
      <meta name="theme-color" content="#0B172A">
      <meta name="theme-color" content="#ffffff">
      <meta name="robots" content="noindex, nofollow, noarchive">
    </head><body></body></html>`;

    expect(() => requireDocumentEvidence(html, expectedDocument)).toThrow(
      /exactly one theme-color meta/i,
    );
  });

  it.each([
    [
      "title",
      `<!doctype html><html lang="ms"><head>
        <meta name="color-scheme" content="light">
        <meta name="theme-color" content="#0B172A">
        <meta name="robots" content="noindex, nofollow, noarchive">
      </head><body><title>Log masuk · Salam CRM</title></body></html>`,
    ],
    [
      "metadata",
      `<!doctype html><html lang="ms"><head>
        <title>Log masuk · Salam CRM</title>
        <meta name="color-scheme" content="light">
        <meta name="theme-color" content="#0B172A">
      </head><body><meta name="robots" content="noindex, nofollow, noarchive"></body></html>`,
    ],
  ])("rejects a relevant %s tag outside the parsed head", (_kind, html) => {
    expect(() => requireDocumentEvidence(html, expectedDocument)).toThrow(/document head/i);
  });

  it("rejects entity-encoded PII and old-description leakage in visible body text", () => {
    const html = `<!doctype html><html lang="ms">${validHead}<body>
      Aqmal &#74;upri · CRM dan revenue operations Sal&#97;m
    </body></html>`;

    expect(() => requireDocumentEvidence(html, expectedDocument)).toThrow(/visible body/i);
  });
});

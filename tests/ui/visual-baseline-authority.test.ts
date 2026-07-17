import { describe, expect, it } from "vitest";
import { assertReviewedVisualBaselineAuthority } from "../../scripts/ci/visual-baseline-authority";

const expectedAuthority = {
  sourceBinding: {
    algorithm: "sha256-path-null-digest-lf-v1" as const,
    digest: "a".repeat(64),
    fileCount: 102,
  },
  referenceLock: "b".repeat(64),
  runtime: {
    os: "Linux",
    runnerImage: "ubuntu24",
    runnerArch: "X64",
    playwrightVersion: "1.61.1",
    browserName: "chromium",
    browserVersion: "149.0.7827.55",
  },
};

function reviewedProvenance() {
  return {
    schemaVersion: 2,
    sourceCommit: "c".repeat(40),
    sourceBinding: { ...expectedAuthority.sourceBinding },
    syntheticOnly: true,
    dynamicData: "none-present",
    capture: { ...expectedAuthority.runtime },
    review: {
      status: "reviewed",
      referenceLock: expectedAuthority.referenceLock,
      reviewer: "Named visual reviewer",
    },
  };
}

describe("reviewed visual baseline authority", () => {
  it("accepts only the exact reviewed source, reference, and runtime", () => {
    expect(() =>
      assertReviewedVisualBaselineAuthority(
        reviewedProvenance(),
        expectedAuthority,
      ),
    ).not.toThrow();
  });

  it.each([
    ["schemaVersion", (value: ReturnType<typeof reviewedProvenance>) => { value.schemaVersion = 1; }],
    ["sourceCommit", (value: ReturnType<typeof reviewedProvenance>) => { value.sourceCommit = "not-a-commit"; }],
    ["sourceBinding.digest", (value: ReturnType<typeof reviewedProvenance>) => { value.sourceBinding.digest = "d".repeat(64); }],
    ["sourceBinding.fileCount", (value: ReturnType<typeof reviewedProvenance>) => { value.sourceBinding.fileCount = 101; }],
    ["review.referenceLock", (value: ReturnType<typeof reviewedProvenance>) => { value.review.referenceLock = "e".repeat(64); }],
    ["review.status", (value: ReturnType<typeof reviewedProvenance>) => { value.review.status = "candidate"; }],
    ["review.reviewer", (value: ReturnType<typeof reviewedProvenance>) => { value.review.reviewer = "PENDING"; }],
    ["capture.runnerImage", (value: ReturnType<typeof reviewedProvenance>) => { value.capture.runnerImage = "ubuntu26"; }],
    ["capture.runnerArch", (value: ReturnType<typeof reviewedProvenance>) => { value.capture.runnerArch = "ARM64"; }],
    ["capture.playwrightVersion", (value: ReturnType<typeof reviewedProvenance>) => { value.capture.playwrightVersion = "1.62.0"; }],
    ["capture.browserName", (value: ReturnType<typeof reviewedProvenance>) => { value.capture.browserName = "firefox"; }],
    ["capture.browserVersion", (value: ReturnType<typeof reviewedProvenance>) => { value.capture.browserVersion = "150.0.0.0"; }],
  ])("rejects stale or substituted %s evidence", (label, mutate) => {
    const provenance = reviewedProvenance();
    mutate(provenance);

    expect(() =>
      assertReviewedVisualBaselineAuthority(provenance, expectedAuthority),
    ).toThrow(label);
  });

  it("rejects hostile non-object provenance without leaking a TypeError", () => {
    expect(() =>
      assertReviewedVisualBaselineAuthority(null, expectedAuthority),
    ).toThrow("provenance");
  });
});

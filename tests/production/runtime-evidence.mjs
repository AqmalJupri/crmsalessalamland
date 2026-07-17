import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

export async function runWithCleanup(primaryOperation, cleanupSteps) {
  let primaryResult;
  let primaryError;
  let primaryFailed = false;

  try {
    primaryResult = await primaryOperation();
  } catch (error) {
    primaryFailed = true;
    primaryError = error;
  }

  const cleanupErrors = [];
  for (const cleanupStep of cleanupSteps) {
    try {
      await cleanupStep();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }

  if (primaryFailed && cleanupErrors.length > 0) {
    throw new AggregateError(
      [primaryError, ...cleanupErrors],
      "The primary operation and cleanup both failed.",
      { cause: primaryError },
    );
  }
  if (primaryFailed) throw primaryError;
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1) {
    throw new AggregateError(cleanupErrors, "Multiple cleanup steps failed.");
  }

  return primaryResult;
}

export function readDocumentEvidence(html, relevantMetadataNames = []) {
  const dom = new JSDOM(html, { includeNodeLocations: true });
  const { document } = dom.window;
  const heads = [...document.querySelectorAll("head")];
  assert.equal(heads.length, 1, "HTML must contain exactly one document head.");
  const [head] = heads;
  assert.ok(head, "HTML must contain a document head.");
  assert.ok(dom.nodeLocation(head), "HTML must contain an explicit document head.");

  const titles = [...document.querySelectorAll("title")];
  assert.equal(titles.length, 1, "HTML must contain exactly one title element.");
  const [title] = titles;
  assert.ok(title && head.contains(title), "The only title element must be in the document head.");

  const metadata = {};
  const namedMetadata = [...document.querySelectorAll("meta[name]")];
  for (const metadataName of relevantMetadataNames) {
    const matchingMetadata = namedMetadata.filter(
      (element) => element.getAttribute("name")?.toLowerCase() === metadataName.toLowerCase(),
    );
    assert.equal(
      matchingMetadata.length,
      1,
      `HTML must contain exactly one ${metadataName} meta element.`,
    );
    const [element] = matchingMetadata;
    assert.ok(
      element && head.contains(element),
      `The ${metadataName} meta element must be in the document head.`,
    );
    metadata[metadataName] = element.getAttribute("content");
  }

  return {
    language: document.documentElement.getAttribute("lang"),
    title: document.title,
    metadata,
    bodyText: document.body?.textContent ?? "",
  };
}

export function requireDocumentEvidence(html, expected) {
  const evidence = readDocumentEvidence(html, Object.keys(expected.metadata));
  assert.equal(evidence.language, expected.language);
  assert.equal(evidence.title, expected.title);
  assert.deepEqual(evidence.metadata, expected.metadata);

  const visibleBodyText = evidence.bodyText.toLowerCase();
  for (const forbiddenText of expected.forbiddenBodyText ?? []) {
    assert.ok(
      !visibleBodyText.includes(forbiddenText.toLowerCase()),
      `Visible body text must not contain ${JSON.stringify(forbiddenText)}.`,
    );
  }

  return evidence;
}

import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const manifestName = "sha256.txt";
const referenceRoot = fileURLToPath(
  new URL("../../docs/design/reference/2026-07-16/", import.meta.url),
);

const requestedPaths = process.argv.slice(2);
if (requestedPaths.some((candidate) => path.basename(candidate) === manifestName)) {
  console.error(`Refusing to hash ${manifestName} into itself.`);
  process.exitCode = 1;
} else if (requestedPaths.length > 0) {
  console.error("Refusing partial reference manifests; run without file arguments.");
  process.exitCode = 1;
} else {
  const entries = await readdir(referenceRoot, { withFileTypes: true });
  const artifacts = entries
    .filter((entry) => entry.name !== manifestName)
    .sort((left, right) =>
      Buffer.from(left.name).compare(Buffer.from(right.name)),
    );

  for (const entry of artifacts) {
    if (!entry.isFile()) {
      throw new Error(`Reference artifact is not a regular file: ${entry.name}`);
    }
  }

  const lines = [];
  for (const entry of artifacts) {
    const bytes = await readFile(path.join(referenceRoot, entry.name));
    const digest = createHash("sha256").update(bytes).digest("hex");
    lines.push(`${digest}  ${entry.name}`);
  }

  await writeFile(
    path.join(referenceRoot, manifestName),
    `${lines.join("\n")}\n`,
    "utf8",
  );
  console.log(`Wrote ${lines.length} entries to ${manifestName}.`);
}

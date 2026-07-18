import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runNextRuntimeSmoke } from "./run-next-runtime-smoke.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(scriptPath), "../..");
const artifactSurface = process.env.ARTIFACT_PRODUCT_SURFACE;
const runtimeSurface = process.env.PRODUCT_SURFACE;

if (!/^(?:crm|tasha)$/.test(artifactSurface ?? "")) {
  throw new Error("ARTIFACT_PRODUCT_SURFACE must be exactly crm or tasha.");
}
if (!/^(?:crm|tasha)$/.test(runtimeSurface ?? "")) {
  throw new Error("PRODUCT_SURFACE must be exactly crm or tasha.");
}
if (artifactSurface === runtimeSurface) {
  throw new Error("Runtime surface mismatch proof requires opposite surfaces.");
}

let rejectedAsExpected = false;
try {
  await runNextRuntimeSmoke({
    smokeCommand: {
      command: process.execPath,
      args: [resolve(repositoryRoot, "tests/production/runtime-surface-mismatch.mjs")],
      cwd: repositoryRoot,
    },
  });
} catch (error) {
  if (
    error instanceof Error &&
    error.message === "Production runtime ready health failed with status 503."
  ) {
    rejectedAsExpected = true;
  } else {
    throw error;
  }
}

if (!rejectedAsExpected) {
  throw new Error("Mismatched runtime unexpectedly reached ready status.");
}

console.log("Immutable product-surface mismatch proof passed.");

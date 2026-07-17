import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

export const VISUAL_SOURCE_BINDING_ALGORITHM =
  "sha256-path-null-digest-lf-v1" as const;

const visualSourceDirectories = [
  "public/fonts",
  "public/icons",
  "src/app",
  "src/components",
  "src/config",
  "src/domain/auth",
  "src/domain/business-units",
  "src/domain/contacts",
  "src/server/auth",
  "src/styles",
] as const;

const visualSourceFiles = [
  "next.config.ts",
  "package.json",
  "playwright.config.ts",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "src/lib/demo-crm.ts",
  "src/proxy.ts",
  "src/server/env.ts",
  "tests/e2e/visual-snapshot.css",
] as const;

export interface VisualSourceBinding {
  algorithm: typeof VISUAL_SOURCE_BINDING_ALGORITHM;
  digest: string;
  fileCount: number;
}

function repositoryPath(repositoryRoot: string, absolutePath: string): string {
  const normalized = relative(repositoryRoot, absolutePath).replaceAll("\\", "/");
  if (!normalized || normalized === ".." || normalized.startsWith("../") || isAbsolute(normalized)) {
    throw new Error(`Visual source input escapes the repository: ${absolutePath}`);
  }
  return normalized;
}

function isExcludedSource(path: string): boolean {
  return (
    path.startsWith("src/app/api/") ||
    path.endsWith(".d.ts") ||
    /\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/.test(path)
  );
}

function collectDirectory(
  repositoryRoot: string,
  directory: string,
  files: Set<string>,
): void {
  const absoluteDirectory = resolve(repositoryRoot, directory);
  const directoryStat = lstatSync(absoluteDirectory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error(`Visual source directory must be a real directory: ${directory}`);
  }

  const entries = readdirSync(absoluteDirectory, { withFileTypes: true }).sort(
    (left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)),
  );
  for (const entry of entries) {
    const absolutePath = join(absoluteDirectory, entry.name);
    const path = repositoryPath(repositoryRoot, absolutePath);
    if (entry.isSymbolicLink()) {
      throw new Error(`Visual source inputs cannot contain symbolic links: ${path}`);
    }
    if (entry.isDirectory()) {
      collectDirectory(repositoryRoot, path, files);
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`Visual source input must be a regular file: ${path}`);
    }
    if (!isExcludedSource(path)) files.add(path);
  }
}

function collectVisualSourceFiles(repositoryRoot: string): string[] {
  const root = resolve(repositoryRoot);
  const files = new Set<string>();

  for (const directory of visualSourceDirectories) {
    collectDirectory(root, directory, files);
  }
  for (const path of visualSourceFiles) {
    const absolutePath = resolve(root, path);
    const normalized = repositoryPath(root, absolutePath);
    const stat = lstatSync(absolutePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Visual source input must be a real file: ${normalized}`);
    }
    files.add(normalized);
  }

  return [...files].sort((left, right) =>
    Buffer.from(left).compare(Buffer.from(right)),
  );
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function computeVisualSourceBinding(
  repositoryRoot: string,
): VisualSourceBinding {
  const root = resolve(repositoryRoot);
  const files = collectVisualSourceFiles(root);
  if (files.length === 0) {
    throw new Error("Visual source binding cannot be empty.");
  }

  const manifest = createHash("sha256");
  for (const path of files) {
    const fileDigest = sha256(readFileSync(resolve(root, path)));
    manifest.update(path, "utf8");
    manifest.update("\0", "utf8");
    manifest.update(fileDigest, "ascii");
    manifest.update("\n", "utf8");
  }

  return {
    algorithm: VISUAL_SOURCE_BINDING_ALGORITHM,
    digest: manifest.digest("hex"),
    fileCount: files.length,
  };
}

export function computeVisualReferenceLock(repositoryRoot: string): string {
  return sha256(
    readFileSync(
      resolve(repositoryRoot, "docs/design/reference/2026-07-16/sha256.txt"),
    ),
  );
}

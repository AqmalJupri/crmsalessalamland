import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const dockerfilePath = `${repositoryRoot}Dockerfile`;
const dockerignorePath = `${repositoryRoot}.dockerignore`;
const nextConfigSource = readFileSync(`${repositoryRoot}next.config.ts`, "utf8");
const releaseContractSource = readFileSync(
  `${repositoryRoot}scripts/ci/release-image-contract.mjs`,
  "utf8",
);
const runtimeBaseLockSource = readFileSync(
  `${repositoryRoot}security/runtime-base-lock.json`,
  "utf8",
);
const runtimeBaseLock = JSON.parse(runtimeBaseLockSource) as {
  reference: string;
  indexDigest: string;
  platformDigest: string;
  layers: unknown[];
  diffIds: string[];
  runtime: { nodeVersion: string; entrypoint: string[] };
};
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const exactBuildBase =
  "node:22.23.1-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3";
const exactAmd64BaseDigest =
  "sha256:8607a9064d4a571140998ae9e52a3b3fcf9cff361d04642d5971e6cd76d39e27";
const exactRuntimeBase =
  "gcr.io/distroless/nodejs22-debian13:nonroot@sha256:a2723a2817c5b01b8e7b98d567bc8b5a6b0e713e25bfb0a82b6ade4b9db06f50";
const exactRuntimePlatformDigest =
  "sha256:6eae66c49774276f50ae1818db25bb89735971a909fb833633dd1400dbc450a1";
const releaseSurfaces = ["crm", "tasha"] as const;
const exactReleaseModeNormalization =
  "find /app/.next/standalone /app/.next/static /app/public -type d -exec chmod 0755 -- {} + && find /app/.next/standalone /app/.next/static /app/public -type f -perm /111 -exec chmod 0755 -- {} + && find /app/.next/standalone /app/.next/static /app/public -type f ! -perm /111 -exec chmod 0644 -- {} +";

const reviewedIgnoreRules = [
  ".git",
  ".git/**",
  ".github",
  ".env*",
  ".npmrc",
  ".pnpmrc",
  ".yarnrc*",
  ".netrc",
  ".ssh",
  ".ssh/**",
  ".aws",
  ".aws/**",
  ".DS_Store",
  ".worktrees",
  "node_modules",
  ".next",
  ".pnpm-store",
  ".turbo",
  "coverage",
  ".playwright",
  "playwright-report",
  "test-results",
  "tests",
  "**/*.test.ts",
  "**/*.test.tsx",
  "**/*.spec.ts",
  "**/*.spec.tsx",
  "docs",
  ".superpowers",
  "README.md",
  "*.zip",
  "*.tar",
  "*.tar.gz",
  "*.tgz",
  "*.csv",
  "*.tsv",
  "*.xlsx",
  "*.xls",
  "*.ods",
  "*.sqlite",
  "*.sqlite3",
  "*.db",
  "*.dump",
  "*.bak",
  "*.log",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
] as const;

interface DockerInstruction {
  readonly name: string;
  readonly value: string;
  readonly source: string;
}

interface DockerStage {
  readonly name: string;
  readonly parent: string;
  readonly instructions: DockerInstruction[];
}

interface EffectiveStage {
  readonly user: string | undefined;
  readonly command: readonly string[] | undefined;
  readonly entrypoint: readonly string[] | undefined;
  readonly labels: ReadonlyMap<string, string>;
}

function logicalDockerfileLines(source: string): string[] {
  if (/\r(?!\n)/.test(source)) throw new Error("CR-only Dockerfile input is forbidden.");
  if (/^\s*#\s*escape\s*=/im.test(source)) {
    throw new Error("Custom Dockerfile escape directives are forbidden.");
  }
  if (source.includes("<<")) throw new Error("Dockerfile heredocs are forbidden.");

  const result: string[] = [];
  let pending = "";
  for (const rawLine of source.replaceAll("\r\n", "\n").split("\n")) {
    const trimmed = rawLine.trim();
    if (!pending && (!trimmed || trimmed.startsWith("#"))) continue;

    const continued = trimmed.endsWith("\\");
    const content = continued ? trimmed.slice(0, -1).trimEnd() : trimmed;
    pending = pending ? `${pending} ${content}` : content;
    if (!continued) {
      result.push(pending.replace(/\s+/g, " "));
      pending = "";
    }
  }

  if (pending) throw new Error("Dockerfile ends with an unfinished continuation.");
  return result;
}

function parseInstruction(source: string): DockerInstruction {
  const match = source.match(/^([A-Za-z]+)(?:\s+(.+))?$/);
  if (!match?.[2]) throw new Error(`Malformed Dockerfile instruction: ${source}`);
  const name = match[1]!.toUpperCase();
  if (name === "ONBUILD") throw new Error("ONBUILD is forbidden.");
  return { name, value: match[2], source };
}

function parseDockerfile(source: string) {
  const stages = new Map<string, DockerStage>();
  const externalBases: string[] = [];
  let current: DockerStage | undefined;

  for (const line of logicalDockerfileLines(source)) {
    const instruction = parseInstruction(line);
    if (instruction.name === "FROM") {
      const match = instruction.value.match(/^(\S+)\s+AS\s+([a-z0-9_-]+)$/i);
      if (!match) throw new Error(`Every FROM must use one named stage: ${line}`);
      const parent = match[1]!;
      const name = match[2]!.toLowerCase();
      if (parent.includes("$")) throw new Error("Variable FROM references are forbidden.");
      if (stages.has(name)) throw new Error(`Duplicate build stage ${name}.`);
      if (!stages.has(parent.toLowerCase())) externalBases.push(parent);
      current = { name, parent, instructions: [] };
      stages.set(name, current);
      continue;
    }

    if (!current) throw new Error("Only FROM may appear before the first stage.");
    current.instructions.push(instruction);
  }

  return { stages, externalBases };
}

function parseJsonInstruction(instruction: DockerInstruction): readonly string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(instruction.value);
  } catch {
    throw new Error(`${instruction.name} must use JSON form.`);
  }
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) {
    throw new Error(`${instruction.name} must be a JSON string array.`);
  }
  if (parsed.some((value) => value.includes("$"))) {
    throw new Error(`${instruction.name} cannot contain unresolved variables.`);
  }
  return parsed;
}

function parseLabels(instruction: DockerInstruction): ReadonlyMap<string, string> {
  const labels = new Map<string, string>();
  for (const entry of instruction.value.split(/\s+/)) {
    const separator = entry.indexOf("=");
    if (separator < 1 || separator === entry.length - 1) {
      throw new Error(`Malformed LABEL entry ${entry}.`);
    }
    const name = entry.slice(0, separator);
    if (labels.has(name)) throw new Error(`Duplicate LABEL ${name}.`);
    labels.set(name, entry.slice(separator + 1));
  }
  return labels;
}

function assertNoSecretInputs(stages: ReadonlyMap<string, DockerStage>): void {
  const secretName =
    /(?:^|_)(?:AUTH|CREDENTIAL|DATABASE|KEY|OIDC|PASS|PASSWORD|PRIVATE|SECRET|TOKEN)(?:_|$)/i;

  for (const stage of stages.values()) {
    for (const instruction of stage.instructions) {
      if (instruction.name !== "ARG" && instruction.name !== "ENV") continue;
      const names = instruction.value
        .split(/\s+/)
        .map((entry) => entry.split("=", 1)[0])
        .filter(Boolean);
      for (const name of names) {
        if (secretName.test(name!)) {
          throw new Error(`Secret-shaped ${instruction.name} ${name} is forbidden.`);
        }
      }
    }
  }
}

function effectiveStage(
  name: string,
  stages: ReadonlyMap<string, DockerStage>,
  active = new Set<string>(),
): EffectiveStage {
  const stage = stages.get(name);
  if (!stage) throw new Error(`Unknown stage ${name}.`);
  if (active.has(name)) throw new Error("Dockerfile stage inheritance must be acyclic.");

  const parentName = stage.parent.toLowerCase();
  const parent = stages.has(parentName)
    ? effectiveStage(parentName, stages, new Set([...active, name]))
    : {
        user: undefined,
        command: undefined,
        entrypoint: undefined,
        labels: new Map<string, string>(),
      };
  let user = parent.user;
  let command = parent.command;
  let entrypoint = parent.entrypoint;
  const labels = new Map(parent.labels);

  for (const instruction of stage.instructions) {
    if (instruction.name === "USER") {
      if (instruction.value.includes("$")) throw new Error("Variable USER is forbidden.");
      user = instruction.value;
    } else if (instruction.name === "CMD") {
      command = parseJsonInstruction(instruction);
    } else if (instruction.name === "ENTRYPOINT") {
      entrypoint = parseJsonInstruction(instruction);
    } else if (instruction.name === "LABEL") {
      for (const [key, value] of parseLabels(instruction)) labels.set(key, value);
    }
  }
  return { user, command, entrypoint, labels };
}

function expectedReleaseCopies(surface: (typeof releaseSurfaces)[number]): readonly string[] {
  return [
    `--from=build-${surface} --chown=0:0 ["/app/.next/standalone", "./"]`,
    `--from=build-${surface} --chown=0:0 ["/app/.next/static", "./.next/static"]`,
    `--from=build-${surface} --chown=0:0 ["/app/public", "./public"]`,
  ];
}

function assertReleaseStage(
  surface: (typeof releaseSurfaces)[number],
  stages: ReadonlyMap<string, DockerStage>,
): void {
  const stageName = `release-${surface}`;
  const stage = stages.get(stageName);
  if (!stage) throw new Error(`Missing ${stageName} target.`);
  expect(stage.parent).toBe("runtime-base");
  expect(stage.instructions.map((instruction) => instruction.name)).toEqual([
    "ARG",
    "ARG",
    "ARG",
    "LABEL",
    "ENV",
    "COPY",
    "COPY",
    "COPY",
    "USER",
    "ENTRYPOINT",
    "CMD",
  ]);
  expect(
    stage.instructions
      .filter((instruction) => instruction.name === "ARG")
      .map((instruction) => instruction.value),
  ).toEqual(["OCI_SOURCE", "SOURCE_REVISION", "APP_VERSION"]);

  const effective = effectiveStage(stageName, stages);
  expect(effective.user).toBe("65532:65532");
  expect(effective.command).toEqual(["/nodejs/bin/node", "server.js"]);
  expect(effective.entrypoint).toEqual([]);
  expect(Object.fromEntries(effective.labels)).toEqual({
    "org.opencontainers.image.source": "$OCI_SOURCE",
    "org.opencontainers.image.revision": "$SOURCE_REVISION",
    "org.opencontainers.image.version": "$APP_VERSION",
    "com.salamland.product-surface": surface,
  });

  const copies = stage.instructions
    .filter((instruction) => instruction.name === "COPY")
    .map((instruction) => instruction.value);
  expect(copies).toEqual(expectedReleaseCopies(surface));
  for (const copy of copies) {
    expect(copy).not.toMatch(/(?:\.env|\/src|\/tests|\/docs|\.git|\["\.")/);
    expect(copy).not.toContain("$");
  }

  const userInstructions = stage.instructions.filter(
    (instruction) => instruction.name === "USER",
  );
  const commandInstructions = stage.instructions.filter(
    (instruction) => instruction.name === "CMD",
  );
  const environmentInstructions = stage.instructions.filter(
    (instruction) => instruction.name === "ENV",
  );
  expect(userInstructions.map((instruction) => instruction.value)).toEqual([
    "65532:65532",
  ]);
  expect(commandInstructions).toHaveLength(1);
  expect(environmentInstructions.map((instruction) => instruction.value)).toEqual([
    `APP_VERSION=$APP_VERSION PRODUCT_SURFACE=${surface}`,
  ]);
  expect(
    stage.instructions
      .filter((instruction) => instruction.name === "ENTRYPOINT")
      .map((instruction) => instruction.value),
  ).toEqual(["[]"]);
  expect(stage.instructions.map((instruction) => instruction.source).join("\n")).not.toMatch(
    /(?:apt-get|\bapk\b|\byum\b|\bdnf\b|npm\s+install|pnpm\s+install|yarn\s+install)/,
  );
}

function assertDockerfileContract(source: string): void {
  expect(source).not.toMatch(/^#\s*syntax=/m);
  const { stages, externalBases } = parseDockerfile(source);
  expect(externalBases).toEqual([exactBuildBase, exactRuntimeBase]);

  const base = externalBases[0]!;
  const separator = base.lastIndexOf("@");
  expect(separator).toBeGreaterThan(0);
  expect(base).toBe(exactBuildBase);
  expect(base.slice(0, separator)).toMatch(/^node:22\.23\.1-[a-z0-9.-]+$/);
  expect(base.slice(separator + 1)).toMatch(digestPattern);
  expect(externalBases[1]!.slice(externalBases[1]!.lastIndexOf("@") + 1)).toMatch(
    digestPattern,
  );

  expect([...stages.keys()].filter((name) => name.startsWith("release-"))).toEqual([
    "release-crm",
    "release-tasha",
  ]);
  for (const required of [
    "base",
    "dependencies",
    "build-crm",
    "build-tasha",
    "runtime-base",
    "release-crm",
    "release-tasha",
  ]) {
    expect(stages.has(required), `missing Docker stage ${required}`).toBe(true);
  }

  assertNoSecretInputs(stages);
  for (const surface of releaseSurfaces) {
    const buildStage = stages.get(`build-${surface}`)!;
    expect(buildStage.parent).toBe("dependencies");
    expect(
      buildStage.instructions
        .filter((instruction) => instruction.name === "RUN")
        .map((instruction) => instruction.value),
    ).toEqual(["pnpm build", exactReleaseModeNormalization]);
  }
  const runtimeBase = stages.get("runtime-base")!;
  expect(runtimeBase.parent).toBe(exactRuntimeBase);
  expect(
    runtimeBase.instructions.map((instruction) => [instruction.name, instruction.value]),
  ).toEqual([
    ["USER", "0:0"],
    ["WORKDIR", "/app"],
    [
      "ENV",
      "HOME=/tmp HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1 NODE_ENV=production PORT=3000",
    ],
    ["EXPOSE", "3000"],
  ]);
  const dependencies = stages.get("dependencies")!;
  expect(
    dependencies.instructions
      .filter((instruction) => instruction.name === "RUN")
      .map((instruction) => instruction.value)
      .filter((value) => value.includes("release_image_canary")),
  ).toEqual([
    "--mount=type=secret,id=release_image_canary,required=true test -s /run/secrets/release_image_canary",
  ]);
  for (const surface of releaseSurfaces) assertReleaseStage(surface, stages);
}

function dockerignoreRules(source: string): string[] {
  if (/\r(?!\n)/.test(source)) throw new Error("CR-only .dockerignore input is forbidden.");
  return source
    .replaceAll("\r\n", "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

function assertDockerignoreContract(source: string): void {
  const rules = dockerignoreRules(source);
  expect(rules.some((rule) => rule.startsWith("!"))).toBe(false);
  expect(new Set(rules).size).toBe(rules.length);
  expect(rules).toEqual(reviewedIgnoreRules);
  expect(rules).not.toEqual(expect.arrayContaining(["*", "**", "**/*", "."]));
  for (const runtimeInput of [
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "next.config.ts",
    "tsconfig.json",
    "src",
    "public",
  ]) {
    expect(rules).not.toContain(runtimeInput);
    expect(rules).not.toContain(`${runtimeInput}/**`);
  }
}

const pinnedBase = exactBuildBase;
const validDockerfileFixture = `
FROM ${pinnedBase} AS base
FROM base AS dependencies
RUN --mount=type=secret,id=release_image_canary,required=true test -s /run/secrets/release_image_canary
RUN corepack enable
FROM dependencies AS build-crm
ENV PRODUCT_SURFACE=crm
RUN pnpm build
RUN ${exactReleaseModeNormalization}
FROM dependencies AS build-tasha
ENV PRODUCT_SURFACE=tasha
RUN pnpm build
RUN ${exactReleaseModeNormalization}
FROM ${exactRuntimeBase} AS runtime-base
USER 0:0
WORKDIR /app
ENV HOME=/tmp HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1 NODE_ENV=production PORT=3000
EXPOSE 3000
FROM runtime-base AS release-crm
ARG OCI_SOURCE
ARG SOURCE_REVISION
ARG APP_VERSION
LABEL org.opencontainers.image.source=$OCI_SOURCE \\
      org.opencontainers.image.revision=$SOURCE_REVISION \\
      org.opencontainers.image.version=$APP_VERSION \\
      com.salamland.product-surface=crm
ENV APP_VERSION=$APP_VERSION PRODUCT_SURFACE=crm
COPY --from=build-crm --chown=0:0 ["/app/.next/standalone", "./"]
COPY --from=build-crm --chown=0:0 ["/app/.next/static", "./.next/static"]
COPY --from=build-crm --chown=0:0 ["/app/public", "./public"]
USER 65532:65532
ENTRYPOINT []
CMD ["/nodejs/bin/node", "server.js"]
FROM runtime-base AS release-tasha
ARG OCI_SOURCE
ARG SOURCE_REVISION
ARG APP_VERSION
LABEL org.opencontainers.image.source=$OCI_SOURCE \\
      org.opencontainers.image.revision=$SOURCE_REVISION \\
      org.opencontainers.image.version=$APP_VERSION \\
      com.salamland.product-surface=tasha
ENV APP_VERSION=$APP_VERSION PRODUCT_SURFACE=tasha
COPY --from=build-tasha --chown=0:0 ["/app/.next/standalone", "./"]
COPY --from=build-tasha --chown=0:0 ["/app/.next/static", "./.next/static"]
COPY --from=build-tasha --chown=0:0 ["/app/public", "./public"]
USER 65532:65532
ENTRYPOINT []
CMD ["/nodejs/bin/node", "server.js"]
`;

const validDockerignoreFixture = `${reviewedIgnoreRules.join("\n")}\n`;

describe("release image source contract", () => {
  it("requires immutable build and supported distroless runtime bases", () => {
    expect(existsSync(dockerfilePath), "Dockerfile must exist").toBe(true);
    assertDockerfileContract(readFileSync(dockerfilePath, "utf8"));
  });

  it("requires the exact fail-closed build-context allowlist", () => {
    expect(existsSync(dockerignorePath), ".dockerignore must exist").toBe(true);
    assertDockerignoreContract(readFileSync(dockerignorePath, "utf8"));
  });

  it("binds standalone output and the resolved linux/amd64 base digest", () => {
    expect(nextConfigSource).toMatch(/\boutput:\s*["']standalone["']/);
    expect(releaseContractSource).toContain(
      `reference: "${exactBuildBase.slice(0, exactBuildBase.indexOf("@"))}"`,
    );
    expect(releaseContractSource).toContain(
      `indexDigest: "${exactBuildBase.slice(exactBuildBase.indexOf("@") + 1)}"`,
    );
    expect(releaseContractSource).toContain(
      `platformDigest: "${exactAmd64BaseDigest}"`,
    );
    expect(`${runtimeBaseLock.reference}@${runtimeBaseLock.indexDigest}`).toBe(
      exactRuntimeBase,
    );
    expect(runtimeBaseLock.platformDigest).toBe(exactRuntimePlatformDigest);
    expect(runtimeBaseLock.runtime).toMatchObject({
      nodeVersion: "22.23.1",
      entrypoint: ["/nodejs/bin/node"],
    });
    expect(runtimeBaseLock.layers).toHaveLength(22);
    expect(runtimeBaseLock.diffIds).toHaveLength(22);
    expect(runtimeBaseLockSource).toBe(`${JSON.stringify(runtimeBaseLock, null, 2)}\n`);
  });

  it("accepts only the reviewed fixture shape", () => {
    expect(() => assertDockerfileContract(validDockerfileFixture)).not.toThrow();
    expect(() => assertDockerignoreContract(validDockerignoreFixture)).not.toThrow();
  });

  it.each([
    ["root name", validDockerfileFixture.replace("USER 65532:65532", "USER root")],
    ["root ID", validDockerfileFixture.replace("USER 65532:65532", "USER 0:0")],
    ["variable user", validDockerfileFixture.replace("USER 65532:65532", "USER ${UID}")],
    [
      "runtime workdir before root owner",
      validDockerfileFixture.replace("USER 0:0\nWORKDIR /app", "WORKDIR /app\nUSER 0:0"),
    ],
    [
      "writable release output",
      validDockerfileFixture.replace(exactReleaseModeNormalization, "chmod -R 0777 /app/.next"),
    ],
    ["floating base", validDockerfileFixture.replace(/@sha256:[a-f0-9]{64}/, "")],
    [
      "second external base",
      validDockerfileFixture.replace(
        `FROM ${exactRuntimeBase} AS runtime-base`,
        "FROM alpine:3.23 AS runtime-base",
      ),
    ],
    [
      "runtime base ownership mutation",
      validDockerfileFixture.replace(
        `FROM ${exactRuntimeBase} AS runtime-base`,
        `FROM ${exactRuntimeBase} AS runtime-base\nRUN chown 65532:65532 /app`,
      ),
    ],
    [
      "secret argument",
      validDockerfileFixture.replace("ARG OCI_SOURCE", "ARG OIDC_CLIENT_SECRET"),
    ],
    [
      "secret environment",
      validDockerfileFixture.replace("ENV PRODUCT_SURFACE=crm", "ENV DATABASE_URL=postgres://unsafe"),
    ],
    [
      "copied environment",
      validDockerfileFixture.replace(
        'COPY --from=build-crm --chown=0:0 ["/app/public", "./public"]',
        'COPY --from=build-crm ["/app/.env", "./.env"]',
      ),
    ],
    [
      "broad context copy",
      validDockerfileFixture.replace(
        'COPY --from=build-crm --chown=0:0 ["/app/public", "./public"]',
        'COPY [".", "."]',
      ),
    ],
    [
      "swapped builder",
      validDockerfileFixture.replace("--from=build-crm", "--from=build-tasha"),
    ],
    [
      "wrong surface label",
      validDockerfileFixture.replace(
        "com.salamland.product-surface=crm",
        "com.salamland.product-surface=tasha",
      ),
    ],
    [
      "later surface override",
      validDockerfileFixture.replace(
        "USER 65532:65532",
        "LABEL com.salamland.product-surface=tasha\nUSER 65532:65532",
      ),
    ],
    [
      "shell command",
      validDockerfileFixture.replace(
        'CMD ["/nodejs/bin/node", "server.js"]',
        "CMD /nodejs/bin/node server.js",
      ),
    ],
    [
      "entrypoint",
      validDockerfileFixture.replace(
        'CMD ["/nodejs/bin/node", "server.js"]',
        'ENTRYPOINT ["/nodejs/bin/node"]\nCMD ["server.js"]',
      ),
    ],
    [
      "runtime volume",
      validDockerfileFixture.replace(
        "USER 65532:65532",
        'VOLUME ["/tmp/uploads"]\nUSER 65532:65532',
      ),
    ],
    [
      "runtime healthcheck",
      validDockerfileFixture.replace(
        "USER 65532:65532",
        'HEALTHCHECK CMD ["/nodejs/bin/node", "healthcheck.js"]\nUSER 65532:65532',
      ),
    ],
    [
      "runtime shell",
      validDockerfileFixture.replace(
        "USER 65532:65532",
        'SHELL ["/bin/sh", "-c"]\nUSER 65532:65532',
      ),
    ],
    [
      "runtime stop signal",
      validDockerfileFixture.replace(
        "USER 65532:65532",
        "STOPSIGNAL SIGKILL\nUSER 65532:65532",
      ),
    ],
    [
      "runtime API key environment",
      validDockerfileFixture.replace(
        "USER 65532:65532",
        "ENV API_KEY=synthetic-api-key-value\nUSER 65532:65532",
      ),
    ],
    ["heredoc", `${validDockerfileFixture}\nRUN <<EOF\necho unsafe\nEOF\n`],
  ])("rejects a %s Dockerfile mutation", (_label, source) => {
    expect(() => assertDockerfileContract(source)).toThrow();
  });

  it.each([
    ["missing rule", validDockerignoreFixture.replace("*.xlsx\n", "")],
    ["negation", `${validDockerignoreFixture}!src/**\n`],
    ["duplicate", `${validDockerignoreFixture}.git\n`],
    ["broad exclusion", `${validDockerignoreFixture}**/*\n`],
    ["unknown exclusion", `${validDockerignoreFixture}src/**\n`],
  ])("rejects a %s in .dockerignore", (_label, source) => {
    expect(() => assertDockerignoreContract(source)).toThrow();
  });
});

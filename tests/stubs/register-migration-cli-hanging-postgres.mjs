import { registerHooks } from "node:module";

const originalSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (callback, delay, ...args) =>
  originalSetTimeout(
    callback,
    delay === 20_000 || delay === 1_000 ? 20 : delay,
    ...args,
  );

const postgresMockUrl = new URL(
  "./migration-cli-hanging-postgres.mjs",
  import.meta.url,
).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "postgres") {
      return { url: postgresMockUrl, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

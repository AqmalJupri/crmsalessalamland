import { registerHooks } from "node:module";

const originalSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (callback, delay, ...args) =>
  originalSetTimeout(
    callback,
    delay === 20_000 || delay === 1_000 ? 20 : delay,
    ...args,
  );

const postgresMockUrl = "test:migration-cli-hanging-postgres";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "postgres") {
      return { url: postgresMockUrl, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url !== postgresMockUrl) return nextLoad(url, context);

    return {
      format: "module",
      shortCircuit: true,
      source: `
        export default function postgres() {
          let rejectBlockedOperation;
          let rejectShutdown;
          const blockedOperation = new Promise((_resolve, reject) => {
            rejectBlockedOperation = reject;
          });
          const shutdown = new Promise((_resolve, reject) => {
            rejectShutdown = reject;
          });
          setInterval(() => undefined, 60_000);
          const reserved = Object.assign(() => blockedOperation, {
            unsafe: () => blockedOperation,
            release: () => undefined,
          });
          return Object.assign(() => blockedOperation, {
            reserve: async () => reserved,
            end: ({ timeout }) => {
              if (timeout === 0) {
                rejectBlockedOperation(new Error("driver forced shutdown"));
                setTimeout(
                  () => rejectShutdown(new Error("late driver shutdown rejection")),
                  75,
                );
              }
              return shutdown;
            },
          });
        }
      `,
    };
  },
});

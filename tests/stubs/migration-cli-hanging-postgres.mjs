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

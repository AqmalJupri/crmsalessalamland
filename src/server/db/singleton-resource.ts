export interface SingletonResource<T> {
  get(): T;
  close(): Promise<void>;
}

export function createSingletonResource<T>(
  create: () => T,
  dispose: (resource: T) => void | Promise<void>,
): SingletonResource<T> {
  let current: T | undefined;

  return {
    get() {
      current ??= create();
      return current;
    },
    async close() {
      if (current === undefined) return;
      const resource = current;
      current = undefined;
      await dispose(resource);
    },
  };
}

import { describe, expect, it, vi } from "vitest";
import { createSingletonResource } from "./singleton-resource";

describe("createSingletonResource", () => {
  it("creates one resource for repeated consumers", () => {
    const create = vi.fn(() => ({ id: crypto.randomUUID() }));
    const resource = createSingletonResource(create, vi.fn());

    expect(resource.get()).toBe(resource.get());
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("disposes once and creates a fresh resource after shutdown", async () => {
    const create = vi.fn(() => ({ id: crypto.randomUUID() }));
    const dispose = vi.fn(async () => undefined);
    const resource = createSingletonResource(create, dispose);
    const first = resource.get();

    await Promise.all([resource.close(), resource.close()]);
    const second = resource.get();

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledWith(first);
    expect(second).not.toBe(first);
    expect(create).toHaveBeenCalledTimes(2);
  });
});

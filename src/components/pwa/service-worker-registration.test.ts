/** @vitest-environment jsdom */

import { createElement } from "react";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

interface MockServiceWorkerContainer {
  getRegistration: ReturnType<typeof vi.fn>;
  register: ReturnType<typeof vi.fn>;
}

function installServiceWorkerMock(
  overrides: Partial<MockServiceWorkerContainer> = {},
): MockServiceWorkerContainer {
  const serviceWorker = {
    getRegistration: vi.fn().mockResolvedValue(undefined),
    register: vi.fn().mockResolvedValue({ scope: "http://localhost:3000/" }),
    ...overrides,
  };
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: serviceWorker,
  });
  return serviceWorker;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, "serviceWorker");
});

describe("ServiceWorkerRegistration", () => {
  it("allows only secure or localhost origins", async () => {
    const { isServiceWorkerOriginEligible } = await import(
      "./service-worker-registration"
    );

    expect(isServiceWorkerOriginEligible("crm.salamland.my", true)).toBe(true);
    expect(isServiceWorkerOriginEligible("localhost", false)).toBe(true);
    expect(isServiceWorkerOriginEligible("127.0.0.1", false)).toBe(true);
    expect(isServiceWorkerOriginEligible("[::1]", false)).toBe(true);
    expect(isServiceWorkerOriginEligible("crm.salamland.my", false)).toBe(false);
  });

  it("registers the root-owned worker once when no root registration exists", async () => {
    const serviceWorker = installServiceWorkerMock();
    const { ServiceWorkerRegistration } = await import("./service-worker-registration");
    const { container } = render(createElement(ServiceWorkerRegistration));

    await waitFor(() => expect(serviceWorker.getRegistration).toHaveBeenCalledWith("/"));
    expect(serviceWorker.register).toHaveBeenCalledOnce();
    expect(serviceWorker.register).toHaveBeenCalledWith("/sw.js", { scope: "/" });
    expect(container.childElementCount).toBe(0);
  });

  it("does not create a duplicate registration", async () => {
    const serviceWorker = installServiceWorkerMock({
      getRegistration: vi.fn().mockResolvedValue({ scope: "http://localhost:3000/" }),
    });
    const { ServiceWorkerRegistration } = await import("./service-worker-registration");
    render(createElement(ServiceWorkerRegistration));

    await waitFor(() => expect(serviceWorker.getRegistration).toHaveBeenCalledOnce());
    expect(serviceWorker.register).not.toHaveBeenCalled();
  });

  it.each(["lookup", "registration"])("fails quietly after a %s error", async (stage) => {
    const serviceWorker = installServiceWorkerMock(
      stage === "lookup"
        ? { getRegistration: vi.fn().mockRejectedValue(new Error("blocked")) }
        : { register: vi.fn().mockRejectedValue(new Error("blocked")) },
    );
    const { ServiceWorkerRegistration } = await import("./service-worker-registration");
    const { container } = render(createElement(ServiceWorkerRegistration));

    await waitFor(() => expect(serviceWorker.getRegistration).toHaveBeenCalledOnce());
    if (stage === "registration") {
      await waitFor(() => expect(serviceWorker.register).toHaveBeenCalledOnce());
    }
    expect(container.childElementCount).toBe(0);
  });
});

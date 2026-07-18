/** @vitest-environment jsdom */

import { createElement } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PipelineBoard } from "./pipeline";

let notifyResize: (() => void) | undefined;

class ResizeObserverStub {
  constructor(callback: ResizeObserverCallback) {
    notifyResize = () => callback([], this as unknown as ResizeObserver);
  }

  observe() {}
  unobserve() {}
  disconnect() {}
}

function setHorizontalDimensions(element: HTMLElement, clientWidth: number, scrollWidth: number) {
  Object.defineProperties(element, {
    clientWidth: { configurable: true, value: clientWidth },
    scrollWidth: { configurable: true, value: scrollWidth },
  });
}

beforeEach(() => vi.stubGlobal("ResizeObserver", ResizeObserverStub));

afterEach(() => {
  cleanup();
  notifyResize = undefined;
  vi.unstubAllGlobals();
});

describe("PipelineBoard", () => {
  function renderBoard() {
    const { container } = render(createElement(PipelineBoard, {
      stages: [
        { id: "new", title: "Baharu", items: [] },
        { id: "won", title: "Menang", items: [] },
      ],
    }));
    return { container, region: screen.getByRole("region", { name: "Pipeline jualan" }) };
  }

  it("keeps a fitting board out of the tab order without a false scroll instruction", () => {
    const { container, region } = renderBoard();

    setHorizontalDimensions(region, 800, 800);
    act(() => notifyResize?.());

    expect(region.getAttribute("tabindex")).toBeNull();
    expect(region.getAttribute("aria-describedby")).toBeNull();
    expect(container.querySelector(".crm-pipeline-region__hint")).toBeNull();
  });

  it("makes a measured overflowing board keyboard-scrollable with a concise visible cue", () => {
    const { container, region } = renderBoard();

    setHorizontalDimensions(region, 320, 800);
    act(() => notifyResize?.());

    const hint = container.querySelector(".crm-pipeline-region__hint");

    expect(region.getAttribute("tabindex")).toBe("0");
    expect(region.getAttribute("aria-describedby")).toBe(hint?.id);
    expect(hint?.textContent?.trim()).toBe("Leret");
    expect(hint?.querySelector("svg[aria-hidden='true']")).toBeTruthy();
  });
});

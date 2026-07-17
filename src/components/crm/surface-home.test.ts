/** @vitest-environment jsdom */

import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SurfaceHome } from "./surface-home";

afterEach(cleanup);

describe("SurfaceHome", () => {
  it("preserves the CRM demo dashboard for an explicit local demo viewer", () => {
    render(createElement(SurfaceHome, { surface: "crm", demo: true }));

    expect(screen.getByText("Lead baharu")).toBeTruthy();
    expect(screen.getByText("RM1.24j")).toBeTruthy();
    expect(screen.getByText(/Nur Aisyah/)).toBeTruthy();
  });

  it("renders a truthful CRM empty state without demo authority", () => {
    render(createElement(SurfaceHome, { surface: "crm", demo: false }));

    expect(screen.getByText("Belum ada data.")).toBeTruthy();
    expect(screen.queryByText("Lead baharu")).toBeNull();
    expect(screen.queryByText("RM1.24j")).toBeNull();
    expect(screen.queryByText(/Nur Aisyah/)).toBeNull();
  });

  it("renders only Tasha's truthful unknown state even when demo fixtures are enabled", () => {
    render(createElement(SurfaceHome, { surface: "tasha", demo: true }));

    expect(screen.getByText("Data pengecualian belum tersedia.")).toBeTruthy();
    for (const leakedCopy of [
      "Lead baharu",
      "Pipeline",
      "RM1.24j",
      "RM286k",
      "Hari ini",
      "Nur Aisyah",
      "Daniel Wong",
    ]) {
      expect(screen.queryByText(leakedCopy)).toBeNull();
    }
  });
});

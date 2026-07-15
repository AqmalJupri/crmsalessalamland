/** @vitest-environment jsdom */

import { createElement } from "react";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { opportunityStages } from "@/lib/demo-crm";
import { PipelineWorkspace } from "./pipeline-workspace";

afterEach(cleanup);

describe("PipelineWorkspace", () => {
  it("does not expose controls for unavailable pipeline views or creation", () => {
    render(createElement(PipelineWorkspace, { initialStages: opportunityStages }));

    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Peluang baharu" })).toBeNull();
  });

  it("traps opportunity-dialog focus, closes with Escape, and restores its opener", async () => {
    const user = userEvent.setup();
    const { container } = render(
      createElement(PipelineWorkspace, { initialStages: opportunityStages }),
    );
    const trigger = screen.getByRole("button", { name: /Nur Aisyah/ });

    await user.click(trigger);

    const dialog = screen.getByRole("dialog", { name: "Nur Aisyah" });
    const close = within(dialog).getByRole("button", { name: "Tutup" });
    const next = within(dialog).getByRole("button", { name: "Seterusnya" });
    expect(document.activeElement).toBe(close);
    const background = container.querySelector(".crm-workspace-background");
    expect(background?.hasAttribute("inert")).toBe(true);
    expect(background?.getAttribute("aria-hidden")).toBe("true");

    close.focus();
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(next);
    await user.tab();
    expect(document.activeElement).toBe(close);

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Nur Aisyah" })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(document.body.style.overflow).toBe("");
  });

  it("shows a truthful empty state instead of demo opportunities", () => {
    render(createElement(PipelineWorkspace, { initialStages: [] }));

    expect(screen.getByText("Belum ada peluang.")).toBeTruthy();
    expect(screen.queryByText("Nur Aisyah")).toBeNull();
    expect(screen.queryByText("Daniel Wong")).toBeNull();
  });

  it("moves an opportunity and recalculates both affected stage totals", async () => {
    const user = userEvent.setup();
    render(createElement(PipelineWorkspace, { initialStages: opportunityStages }));
    const qualification = screen.getByRole("listitem", { name: "Kelayakan" });
    const proposal = screen.getByRole("listitem", { name: "Tawaran" });

    expect(qualification.textContent).toMatch(/RM\s*505K/i);
    expect(proposal.textContent).toMatch(/RM\s*366K/i);
    await user.click(screen.getByRole("button", { name: /Nur Aisyah/ }));
    await user.click(screen.getByRole("button", { name: "Seterusnya" }));

    expect(qualification.textContent).toMatch(/RM\s*320K/i);
    expect(proposal.textContent).toMatch(/RM\s*551K/i);
    expect(screen.getByRole("dialog", { name: "Nur Aisyah" }).textContent).toContain("Tawaran");
  });
});

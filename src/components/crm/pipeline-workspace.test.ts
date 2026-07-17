/** @vitest-environment jsdom */

import { createElement } from "react";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { opportunityStages } from "@/lib/demo-crm";
import type { ClientBusinessScope } from "@/domain/business-units/client-scope";
import { PipelineWorkspace } from "./pipeline-workspace";

afterEach(cleanup);

const salamAccess = {
  id: "00000000-0000-4000-8000-000000000101",
  name: "Salam Land",
  code: "salam-land",
  slug: "salam-land",
  membershipIds: ["membership-salam"],
  capabilities: ["opportunity.read"],
  capabilityRecordScopes: {},
} as const;
const unitScope: ClientBusinessScope = {
  kind: "UNIT",
  queryValue: "salam-land",
  businessUnitId: salamAccess.id,
  businessUnitCode: salamAccess.code,
  businessUnitName: salamAccess.name,
};

function workspace(
  stages = opportunityStages,
  scope: ClientBusinessScope = unitScope,
  activeFilterLabel: string | null = null,
  populationKey: "all" | "active" = "all",
  sourcePopulationCount = stages.flatMap((stage) => stage.items).length,
) {
  return createElement(PipelineWorkspace, {
    initialStages: stages,
    scope,
    activeFilterLabel,
    populationKey,
    sourcePopulationCount,
  });
}

describe("PipelineWorkspace", () => {
  it("does not expose controls for unavailable pipeline views or creation", () => {
    render(workspace());

    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Peluang baharu" })).toBeNull();
  });

  it("traps opportunity-dialog focus, closes with Escape, and restores its opener", async () => {
    const user = userEvent.setup();
    const { container } = render(
      workspace(),
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
    render(workspace([]));

    const state = screen.getByRole("region", { name: "Belum ada peluang." });
    expect(state.getAttribute("data-state-kind")).toBe("empty");
    expect(screen.queryByText("Nur Aisyah")).toBeNull();
    expect(screen.queryByText("Daniel Wong")).toBeNull();
  });

  it("uses filtered-empty when a nonempty source population is filtered to zero", () => {
    const emptyStages = opportunityStages.map((stage) => ({ ...stage, items: [] }));
    render(workspace(emptyStages, unitScope, "Pipeline aktif", "active", 3));

    expect(screen.getByRole("status").textContent).toContain("Pipeline aktif · 0 rekod");
    const state = screen.getByRole("region", { name: "Tiada peluang sepadan." });
    expect(state.getAttribute("data-state-kind")).toBe("filtered-empty");
    expect(screen.queryByText("Belum ada peluang.")).toBeNull();
  });

  it("uses empty when the source population is zero even with an active filter", () => {
    render(workspace([], unitScope, "Pipeline aktif", "active", 0));

    expect(screen.getByRole("status").textContent).toContain("Pipeline aktif · 0 rekod");
    const state = screen.getByRole("region", { name: "Belum ada peluang." });
    expect(state.getAttribute("data-state-kind")).toBe("empty");
    expect(screen.queryByText("Tiada peluang sepadan.")).toBeNull();
  });

  it("remounts local board state when the authorised unit scope changes", async () => {
    const bumiAccess = {
      ...salamAccess,
      id: "00000000-0000-4000-8000-000000000102",
      name: "Bumi Hayat Printing",
      code: "bumi-hayat",
      slug: "bumi-hayat",
      membershipIds: ["membership-bumi"],
    } as const;
    const bumiScope: ClientBusinessScope = {
      kind: "UNIT",
      queryValue: bumiAccess.code,
      businessUnitId: bumiAccess.id,
      businessUnitCode: bumiAccess.code,
      businessUnitName: bumiAccess.name,
    };
    const user = userEvent.setup();
    const { rerender } = render(workspace());
    await user.click(screen.getByRole("button", { name: /Nur Aisyah/ }));
    expect(screen.getByRole("dialog", { name: "Nur Aisyah" })).toBeTruthy();

    rerender(workspace(opportunityStages, bumiScope));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Nur Aisyah" })).toBeNull());
    expect(screen.queryByRole("button", { name: /Nur Aisyah/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Liyana Musa/ })).toBeTruthy();
  });

  it("remounts the exact server population across same-scope metric history", () => {
    const bumiScope: ClientBusinessScope = {
      kind: "UNIT",
      queryValue: "bumi-hayat",
      businessUnitId: "00000000-0000-4000-8000-000000000102",
      businessUnitCode: "bumi-hayat",
      businessUnitName: "Bumi Hayat Printing",
    };
    const activeStages = opportunityStages.filter((stage) => stage.id !== "won");
    const { rerender } = render(workspace(opportunityStages, bumiScope));

    expect(screen.getByRole("button", { name: /Daniel Wong/ })).toBeTruthy();
    expect(screen.getByRole("listitem", { name: "Menang" })).toBeTruthy();

    rerender(workspace(activeStages, bumiScope, "Pipeline aktif", "active"));

    expect(screen.getByText("Tapis: Pipeline aktif · 1 rekod")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Daniel Wong/ })).toBeNull();
    expect(screen.queryByRole("listitem", { name: "Menang" })).toBeNull();

    rerender(workspace(opportunityStages, bumiScope, null, "all"));

    expect(screen.getByRole("button", { name: /Daniel Wong/ })).toBeTruthy();
    expect(screen.getByRole("listitem", { name: "Menang" })).toBeTruthy();
  });

  it("moves an opportunity and recalculates both affected stage totals", async () => {
    const user = userEvent.setup();
    render(workspace());
    const qualification = screen.getByRole("listitem", { name: "Kelayakan" });
    const proposal = screen.getByRole("listitem", { name: "Tawaran" });

    expect(qualification.textContent).toMatch(/RM\s*505K/i);
    expect(proposal.textContent).toMatch(/RM\s*190K/i);
    await user.click(screen.getByRole("button", { name: /Nur Aisyah/ }));
    await user.click(screen.getByRole("button", { name: "Seterusnya" }));

    expect(qualification.textContent).toMatch(/RM\s*320K/i);
    expect(proposal.textContent).toMatch(/RM\s*375K/i);
    expect(screen.getByRole("dialog", { name: "Nur Aisyah" }).textContent).toContain("Tawaran");
  });

  it("labels every opportunity and disables movement in Semua", async () => {
    const bumi = {
      ...salamAccess,
      id: "00000000-0000-4000-8000-000000000102",
      name: "Bumi Hayat Printing",
      code: "bumi-hayat",
      slug: "bumi-hayat",
      membershipIds: ["membership-bumi"],
    } as const;
    const barakah = {
      ...salamAccess,
      id: "00000000-0000-4000-8000-000000000103",
      name: "Barakah Emas",
      code: "barakah-emas",
      slug: "barakah-emas",
      membershipIds: ["membership-barakah"],
    } as const;
    const scope: ClientBusinessScope = {
      kind: "ALL",
      queryValue: "all",
      units: [salamAccess, bumi, barakah].map((unit) => ({
        id: unit.id,
        code: unit.code,
        name: unit.name,
      })),
      unitIds: [salamAccess.id, bumi.id, barakah.id],
    };
    const user = userEvent.setup();
    render(workspace(opportunityStages, scope));

    expect(screen.getAllByText("Salam Land").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Bumi Hayat Printing").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Barakah Emas").length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: /Nur Aisyah/ }));
    const choose = screen.getByRole("button", { name: "Pilih syarikat" }) as HTMLButtonElement;
    expect(choose.disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Seterusnya" })).toBeNull();
  });
});

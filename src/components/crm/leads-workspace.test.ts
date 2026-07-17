/** @vitest-environment jsdom */

import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LeadsWorkspace } from "./leads-workspace";
import type { DemoLead } from "@/lib/demo-crm";
import type { ClientBusinessScope } from "@/domain/business-units/client-scope";

const businessUnitId = "00000000-0000-4000-8000-000000000101";
const salamAccess = {
  id: businessUnitId,
  name: "Salam Land",
  code: "salam-land",
  slug: "salam-land",
  membershipIds: ["membership-salam"],
  capabilities: ["lead.read", "lead.create"],
  capabilityRecordScopes: {},
} as const;
const unitScope: ClientBusinessScope = {
  kind: "UNIT",
  queryValue: "salam-land",
  businessUnitId,
  businessUnitCode: "salam-land",
  businessUnitName: "Salam Land",
};
const initialLeads: DemoLead[] = [
  {
    businessUnitId,
    businessUnitCode: "salam-land",
    businessUnitName: "Salam Land",
    id: "10000000-0000-4000-8000-000000000001",
    name: "Nur Aisyah",
    phone: "+6012•••6789",
    source: "meta",
    productInterest: "Lot A-118",
    owner: "Farah",
    stage: "new",
    nextAction: "Hari ini",
    version: 1,
  },
  {
    businessUnitId,
    businessUnitCode: "salam-land",
    businessUnitName: "Salam Land",
    id: "10000000-0000-4000-8000-000000000002",
    name: "Daniel Wong",
    phone: "+6017•••4421",
    source: "google.ads",
    productInterest: "Lot B-204",
    owner: "Amir",
    stage: "awaiting-documents",
    nextAction: "Esok",
    version: 3,
  },
];

function renderWorkspace(
  canCreate = true,
  leads = initialLeads,
  scope: ClientBusinessScope = unitScope,
  initialStageFilter: string | null = null,
) {
  return render(
    createElement(LeadsWorkspace, {
      scope,
      canCreate,
      initialLeads: leads,
      initialStageFilter,
    }),
  );
}

async function openCreateForm() {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Lead baharu" }));
  const form = await screen.findByRole("dialog", { name: "Lead baharu" });
  return { user, form };
}

async function completeRequiredFields(
  user: ReturnType<typeof userEvent.setup>,
  values: { name?: string; phone?: string; productInterest?: string } = {},
) {
  await user.type(screen.getByLabelText(/^Nama/), values.name ?? "Hana Lee");
  await user.type(screen.getByLabelText(/^Telefon/), values.phone ?? "0123456789");
  await user.type(
    screen.getByLabelText(/^Minat produk/),
    values.productInterest ?? "Lot C-031",
  );
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
  vi.stubGlobal("crypto", {
    randomUUID: vi.fn(() => "0195f4f8-8e36-7dd1-8f14-c31f0edb30d6"),
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("LeadsWorkspace", () => {
  it("makes Semua read-only and labels every row with its company", () => {
    const bumi = {
      id: "00000000-0000-4000-8000-000000000102",
      name: "Bumi Hayat Printing",
      code: "bumi-hayat",
      slug: "bumi-hayat",
      membershipIds: ["membership-bumi"],
      capabilities: ["lead.read", "lead.create"],
      capabilityRecordScopes: {},
    } as const;
    const allScope: ClientBusinessScope = {
      kind: "ALL",
      queryValue: "all",
      units: [
        { id: salamAccess.id, code: salamAccess.code, name: salamAccess.name },
        { id: bumi.id, code: bumi.code, name: bumi.name },
      ],
      unitIds: [salamAccess.id, bumi.id],
    };
    renderWorkspace(true, [
      initialLeads[0]!,
      {
        ...initialLeads[1]!,
        businessUnitId: bumi.id,
        businessUnitCode: bumi.code,
        businessUnitName: bumi.name,
      },
    ], allScope);

    expect(screen.getByRole("columnheader", { name: "Syarikat" })).toBeTruthy();
    expect(screen.getByText("Salam Land")).toBeTruthy();
    expect(screen.getByText("Bumi Hayat Printing")).toBeTruthy();
    const choose = screen.getByRole("button", { name: "Pilih syarikat" }) as HTMLButtonElement;
    expect(choose.disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Lead baharu" })).toBeNull();
  });

  it("drops local records and dialogs when the authorised unit scope changes", async () => {
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
    const bumiLead: DemoLead = {
      ...initialLeads[1]!,
      businessUnitId: bumiAccess.id,
      businessUnitCode: bumiAccess.code,
      businessUnitName: bumiAccess.name,
      id: "10000000-0000-4000-8000-000000000099",
      name: "Izzati Salleh",
    };
    const user = userEvent.setup();
    const { rerender } = renderWorkspace();
    await user.click(screen.getByRole("button", { name: "Nur Aisyah" }));

    rerender(createElement(LeadsWorkspace, {
      scope: bumiScope,
      canCreate: true,
      initialLeads: [bumiLead],
    }));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Nur Aisyah" })).toBeNull());
    expect(screen.queryByRole("button", { name: "Nur Aisyah" })).toBeNull();
    expect(screen.getByRole("button", { name: "Izzati Salleh" })).toBeTruthy();
  });

  it("shows a truthful empty state while retaining authorized creation", () => {
    renderWorkspace(true, []);

    expect(screen.getByText("Belum ada lead.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Lead baharu" })).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByText("Nur Aisyah")).toBeNull();
  });

  it("hides lead creation when the viewer lacks lead.create", () => {
    renderWorkspace(false);

    expect(screen.queryByRole("button", { name: "Lead baharu" })).toBeNull();
  });

  it("presents known and provider-defined records and opens either detail panel", async () => {
    const user = userEvent.setup();
    renderWorkspace();
    const table = screen.getByRole("table");

    expect(within(table).getByText("+6012•••6789 · Meta")).toBeTruthy();
    expect(within(table).getByText("+6017•••4421 · Google ads")).toBeTruthy();
    expect(within(table).getByText("Baharu")).toBeTruthy();
    expect(within(table).getByText("Awaiting documents")).toBeTruthy();

    await user.click(within(table).getByRole("button", { name: "Nur Aisyah" }));
    const detail = screen.getByRole("dialog", { name: "Nur Aisyah" });
    expect(within(detail).getByText("Lot A-118")).toBeTruthy();
    expect(within(detail).getByText("Meta")).toBeTruthy();

    await user.click(within(detail).getByRole("button", { name: "Tutup" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Nur Aisyah" })).toBeNull());

    await user.click(within(table).getByRole("button", { name: "Daniel Wong" }));
    expect(screen.getByRole("dialog", { name: "Daniel Wong" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Tutup butiran lead" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Daniel Wong" })).toBeNull());
  });

  it("filters by provider text and stage and reports an empty intersection", async () => {
    const user = userEvent.setup();
    renderWorkspace();
    const search = screen.getByRole("textbox", { name: "Cari lead" });
    const stage = screen.getByRole("combobox", { name: "Tapis status" }) as HTMLSelectElement;

    expect(Array.from(stage.options, (option) => [option.value, option.textContent])).toEqual([
      ["all", "Semua status"],
      ["awaiting-documents", "Awaiting documents"],
      ["new", "Baharu"],
    ]);

    await user.type(search, "  GOOGLE  ");
    expect(screen.getByRole("button", { name: "Daniel Wong" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Nur Aisyah" })).toBeNull();
    expect(screen.getByText("1 daripada 2")).toBeTruthy();

    await user.clear(search);
    await user.selectOptions(stage, "new");
    expect(screen.getByRole("button", { name: "Nur Aisyah" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Daniel Wong" })).toBeNull();

    await user.type(search, "Daniel");
    expect(screen.getByText("Tiada rekod sepadan.")).toBeTruthy();
    expect(screen.getByText("0 daripada 2")).toBeTruthy();
  });

  it("applies an authorised stage drill-down on first render", () => {
    renderWorkspace(true, initialLeads, unitScope, "new");

    expect((screen.getByRole("combobox", { name: "Tapis status" }) as HTMLSelectElement).value).toBe("new");
    expect(screen.getByRole("button", { name: "Nur Aisyah" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Daniel Wong" })).toBeNull();
    expect(screen.getByText("1 daripada 2")).toBeTruthy();
  });

  it("keeps an allowlisted zero-result drill-down visible in the status control", () => {
    renderWorkspace(true, initialLeads, unitScope, "qualified");

    const status = screen.getByRole("combobox", { name: "Tapis status" }) as HTMLSelectElement;
    expect(status.value).toBe("qualified");
    expect(Array.from(status.options, (option) => option.value)).toContain("qualified");
    expect(screen.getByText("Tiada rekod sepadan.")).toBeTruthy();
    expect(screen.getByText("0 daripada 2")).toBeTruthy();
  });

  it("traps create-dialog focus and restores the opener after Escape", async () => {
    const { container } = renderWorkspace();
    const trigger = screen.getByRole("button", { name: "Lead baharu" });
    const { user, form } = await openCreateForm();

    expect(document.activeElement).toBe(screen.getByLabelText(/^Nama/));
    const background = container.querySelector(".crm-workspace-background");
    expect(background?.hasAttribute("inert")).toBe(true);
    expect(background?.getAttribute("aria-hidden")).toBe("true");

    const close = within(form).getByRole("button", { name: "Tutup" });
    const save = within(form).getByRole("button", { name: "Simpan" });
    close.focus();
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(save);
    await user.tab();
    expect(document.activeElement).toBe(close);

    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Lead baharu" })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(document.body.style.overflow).toBe("");
  });

  it("does not refocus the first field when the create dialog rerenders", async () => {
    renderWorkspace();
    const { user } = await openCreateForm();
    const phone = screen.getByLabelText(/^Telefon/);

    await user.click(phone);
    await user.type(phone, "0");

    expect(document.activeElement).toBe(phone);
  });

  it("protects dirty form changes and closes only after discard confirmation", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    const { container } = renderWorkspace();
    const { user, form } = await openCreateForm();

    await user.type(screen.getByLabelText(/^Nama/), "Hana");
    fireEvent.mouseDown(form);
    expect(screen.getByRole("dialog", { name: "Lead baharu" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Batal" }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("dialog", { name: "Lead baharu" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Batal" }));
    expect(confirm).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Lead baharu" })).toBeNull());

    await user.click(screen.getByRole("button", { name: "Lead baharu" }));
    const backdrop = container.querySelector(".crm-modal-backdrop");
    expect(backdrop).not.toBeNull();
    fireEvent.mouseDown(backdrop!);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Lead baharu" })).toBeNull());
  });

  it("shows local phone validation without making a request", async () => {
    renderWorkspace();
    const { user } = await openCreateForm();
    await completeRequiredFields(user, { phone: "123" });

    await user.click(screen.getByRole("button", { name: "Simpan" }));

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe(
        "Masukkan nombor mudah alih Malaysia yang sah.",
      ),
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("prevents duplicate submission and prepends a successful API lead", async () => {
    let resolveResponse!: (response: { ok: boolean; json: () => Promise<unknown> }) => void;
    const responsePromise = new Promise<{ ok: boolean; json: () => Promise<unknown> }>((resolve) => {
      resolveResponse = resolve;
    });
    vi.mocked(fetch).mockReturnValue(responsePromise as ReturnType<typeof fetch>);
    renderWorkspace();
    const { user, form } = await openCreateForm();
    await completeRequiredFields(user);
    await user.selectOptions(screen.getByLabelText(/^Sumber/), "tiktok");

    await user.click(screen.getByRole("button", { name: "Simpan" }));
    await waitFor(() => {
      const saving = screen.getByRole("button", { name: "Menyimpan" }) as HTMLButtonElement;
      expect(saving.disabled).toBe(true);
      expect(saving.getAttribute("aria-busy")).toBe("true");
    });
    fireEvent.submit(form);
    expect(fetch).toHaveBeenCalledTimes(1);

    const [, request] = vi.mocked(fetch).mock.calls[0]!;
    expect(request).toMatchObject({
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "lead:0195f4f8-8e36-7dd1-8f14-c31f0edb30d6",
      },
    });
    expect(JSON.parse(String(request?.body))).toEqual({
      businessUnitId,
      name: "Hana Lee",
      phone: "+60123456789",
      source: "tiktok",
      productInterest: "Lot C-031",
    });

    resolveResponse({
      ok: true,
      json: async () => ({
        data: {
          id: "10000000-0000-4000-8000-000000000003",
          name: "Hana Lee",
          phone: "+60123456789",
          source: "google.ads",
          productInterest: null,
          stage: "awaiting-documents",
          version: 1,
        },
      }),
    });

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Lead baharu" })).toBeNull());
    expect(screen.getByRole("status").textContent).toBe("Hana Lee ditambah.");
    expect(screen.getByText("+6012•••6789 · Google ads")).toBeTruthy();
    expect(screen.getByText("3 daripada 3")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Hana Lee" }));
    expect(
      within(screen.getByRole("dialog", { name: "Hana Lee" })).getAllByText("Belum ditetapkan"),
    ).toHaveLength(2);
  });

  it("reuses one idempotency key when an ambiguous request is retried", async () => {
    vi.mocked(crypto.randomUUID)
      .mockReturnValueOnce("0195f4f8-8e36-7dd1-8f14-c31f0edb30d6")
      .mockReturnValueOnce("0195f4f8-8e36-7dd1-8f14-c31f0edb30d7");
    vi.mocked(fetch)
      .mockRejectedValueOnce(new TypeError("network unavailable"))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            id: "10000000-0000-4000-8000-000000000004",
            name: "Hana Lee",
            phone: "+60123456789",
            source: "meta",
            productInterest: "Lot C-031",
            stage: "new",
            version: 1,
          },
        }),
      } as Response);
    renderWorkspace();
    const { user } = await openCreateForm();
    await completeRequiredFields(user);

    await user.click(screen.getByRole("button", { name: "Simpan" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("network unavailable"));
    await user.click(screen.getByRole("button", { name: "Simpan" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Hana Lee ditambah."));

    const keys = vi.mocked(fetch).mock.calls.map(([, request]) =>
      (request?.headers as Record<string, string>)["Idempotency-Key"]
    );
    expect(keys).toEqual([
      "lead:0195f4f8-8e36-7dd1-8f14-c31f0edb30d6",
      "lead:0195f4f8-8e36-7dd1-8f14-c31f0edb30d6",
    ]);
    expect(crypto.randomUUID).toHaveBeenCalledTimes(1);
  });

  it("keeps the modal open and presents a server error", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      json: async () => ({ error: { message: "Lead already exists." } }),
    } as Response);
    renderWorkspace();
    const { user } = await openCreateForm();
    await completeRequiredFields(user);

    await user.click(screen.getByRole("button", { name: "Simpan" }));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Lead already exists."));
    expect(screen.getByRole("dialog", { name: "Lead baharu" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Simpan" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("uses a safe fallback for malformed success and non-Error request failures", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) } as Response)
      .mockRejectedValueOnce("network unavailable");
    renderWorkspace();
    const first = await openCreateForm();
    await completeRequiredFields(first.user);

    await first.user.click(screen.getByRole("button", { name: "Simpan" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe("Lead tidak dapat disimpan."),
    );

    await first.user.click(screen.getByRole("button", { name: "Simpan" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe("Lead tidak dapat disimpan."),
    );
  });
});

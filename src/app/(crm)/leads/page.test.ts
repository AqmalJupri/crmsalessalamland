import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DemoLead } from "@/lib/demo-crm";

const mocks = vi.hoisted(() => ({ requireViewer: vi.fn() }));

vi.mock("@/server/auth/viewer", () => ({
  requireViewer: mocks.requireViewer,
}));

import LeadsPage from "./page";

interface LeadsPageProps {
  businessUnitId: string;
  canCreate: boolean;
  initialLeads: DemoLead[];
}

const baseViewer = {
  businessUnitId: "00000000-0000-4000-8000-000000000101",
  capabilities: ["lead.read", "lead.create"],
  demo: false,
};

describe("LeadsPage fixture boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireViewer.mockResolvedValue(baseViewer);
  });

  it("passes an empty initial collection to every non-demo viewer", async () => {
    const page = (await LeadsPage()) as ReactElement<LeadsPageProps>;

    expect(mocks.requireViewer).toHaveBeenCalledWith("/leads");
    expect(page.props.initialLeads).toEqual([]);
    expect(page.props.canCreate).toBe(true);
  });

  it("preserves seeded leads for the explicit demo viewer", async () => {
    mocks.requireViewer.mockResolvedValue({ ...baseViewer, demo: true });

    const page = (await LeadsPage()) as ReactElement<LeadsPageProps>;

    expect(page.props.initialLeads.length).toBeGreaterThan(0);
    expect(page.props.initialLeads.some((lead) => lead.name === "Nur Aisyah")).toBe(true);
  });
});

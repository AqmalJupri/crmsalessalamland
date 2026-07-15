import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DemoOpportunityStage } from "@/lib/demo-crm";

const mocks = vi.hoisted(() => ({ canRenderDemoFixtures: vi.fn() }));

vi.mock("@/server/auth/page-access", () => ({
  canRenderDemoFixtures: mocks.canRenderDemoFixtures,
}));

import PipelinePage from "./page";

interface PipelinePageProps {
  initialStages: DemoOpportunityStage[];
}

describe("PipelinePage fixture boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.canRenderDemoFixtures.mockReturnValue(false);
  });

  it("passes no demo opportunities to a non-demo viewer", async () => {
    const page = (await PipelinePage()) as ReactElement<PipelinePageProps>;

    expect(mocks.canRenderDemoFixtures).toHaveBeenCalledWith();
    expect(page.props.initialStages).toEqual([]);
  });

  it("preserves seeded opportunities for the explicit demo viewer", async () => {
    mocks.canRenderDemoFixtures.mockReturnValue(true);

    const page = (await PipelinePage()) as ReactElement<PipelinePageProps>;

    expect(page.props.initialStages.length).toBeGreaterThan(0);
  });
});

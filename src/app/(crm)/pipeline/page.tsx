import type { Metadata } from "next";
import { PipelineWorkspace } from "@/components/crm/pipeline-workspace";
import { opportunityStages } from "@/lib/demo-crm";
import { canRenderDemoFixtures } from "@/server/auth/page-access";

export const metadata: Metadata = { title: "Pipeline" };

export default function PipelinePage() {
  return (
    <PipelineWorkspace initialStages={canRenderDemoFixtures() ? opportunityStages : []} />
  );
}

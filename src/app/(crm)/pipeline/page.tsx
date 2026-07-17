import type { Metadata } from "next";
import { PipelineWorkspace } from "@/components/crm/pipeline-workspace";
import { MetricDefinitionPanel } from "@/components/crm/metric";
import { filterOpportunityStagesByUnitIds, isActiveDemoOpportunityStage, opportunityStages } from "@/lib/demo-crm";
import { CRM_MODULE_ACCESS } from "@/server/auth/module-access";
import { canRenderDemoFixtures, requireScopedPageViewer } from "@/server/auth/page-access";
import { projectClientBusinessScope } from "@/domain/business-units/client-scope";

export const metadata: Metadata = { title: "Pipeline" };

type PageSearchParams = Record<string, string | string[] | undefined>;

export default async function PipelinePage({ searchParams }: { searchParams: Promise<PageSearchParams> }) {
  const query = await searchParams;
  const { scope } = await requireScopedPageViewer(
    query.bu,
    CRM_MODULE_ACCESS.pipeline.capability,
    "/pipeline",
    query,
  );
  const unitIds = scope.kind === "ALL" ? scope.unitIds : [scope.businessUnitId];
  const activeOnly = query.metric === "active";
  const sourceStages = canRenderDemoFixtures()
    ? filterOpportunityStagesByUnitIds(opportunityStages, unitIds)
    : [];
  const stages = activeOnly
    ? sourceStages.filter(isActiveDemoOpportunityStage)
    : sourceStages;
  const sourcePopulationCount = sourceStages.reduce(
    (sum, stage) => sum + stage.items.length,
    0,
  );
  const workspace = (
    <PipelineWorkspace
      scope={projectClientBusinessScope(scope)}
      populationKey={activeOnly ? "active" : "all"}
      emptyStateKind="empty"
      initialStages={stages}
      sourcePopulationCount={sourcePopulationCount}
      activeFilterLabel={activeOnly ? "Pipeline aktif" : null}
    />
  );
  if (query.definition !== "active") return workspace;
  return (
    <div className="crm-page-stack">
      <MetricDefinitionPanel definition={{
        key: "active",
        title: "Nilai pipeline",
        formula: "Jumlah nilai peluang selain peringkat Menang.",
        source: "Rekod peluang demo.",
        dateBasis: "Tarikh peringkat",
      }} />
      {workspace}
    </div>
  );
}

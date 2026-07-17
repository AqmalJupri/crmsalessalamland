import type { Metadata } from "next";
import { LeadsWorkspace } from "@/components/crm/leads-workspace";
import { MetricDefinitionPanel } from "@/components/crm/metric";
import { demoLeads, filterDemoRecordsByUnitIds } from "@/lib/demo-crm";
import { CRM_MODULE_ACCESS } from "@/server/auth/module-access";
import { requireScopedPageViewer } from "@/server/auth/page-access";
import { projectClientBusinessScope } from "@/domain/business-units/client-scope";

export const metadata: Metadata = { title: "Lead" };

type LeadPageSearchParams = {
  [key: string]: string | string[] | undefined;
  bu?: string | string[];
  stage?: string | string[];
};

const LEAD_STAGE_DRILLDOWNS = new Set([
  "new",
  "assigned",
  "contacted",
  "qualified",
  "nurture",
  "disqualified",
  "converted",
]);

export default async function LeadsPage({ searchParams }: { searchParams: Promise<LeadPageSearchParams> }) {
  const query = await searchParams;
  const { viewer, scope } = await requireScopedPageViewer(
    query.bu,
    CRM_MODULE_ACCESS.leads.capability,
    "/leads",
    query,
  );
  const unitIds = scope.kind === "ALL" ? scope.unitIds : [scope.businessUnitId];
  const initialStageFilter = typeof query.stage === "string" && LEAD_STAGE_DRILLDOWNS.has(query.stage)
    ? query.stage
    : null;
  const workspace = (
    <LeadsWorkspace
      scope={projectClientBusinessScope(scope)}
      canCreate={scope.kind === "UNIT" && scope.access.capabilities.includes("lead.create")}
      initialLeads={viewer.demo ? filterDemoRecordsByUnitIds(demoLeads, unitIds) : []}
      initialStageFilter={initialStageFilter}
    />
  );
  if (query.definition !== "lead-baharu") return workspace;
  return (
    <div className="crm-page-stack">
      <MetricDefinitionPanel definition={{
        key: "lead-baharu",
        title: "Lead baharu",
        formula: "Bilangan lead berstatus Baharu.",
        source: "Rekod lead demo.",
        dateBasis: "Tarikh diterima",
      }} />
      {workspace}
    </div>
  );
}

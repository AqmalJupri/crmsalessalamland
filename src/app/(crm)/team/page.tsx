import { DataEmptyState } from "@/components/crm/data-empty-state";
import { createDemoModuleMetrics, OperationalModule, parseModuleMetricQuery, type DemoModuleMetric } from "@/components/crm/operational-module";
import { demoBusinessUnits } from "@/lib/demo-crm";
import { CRM_MODULE_ACCESS } from "@/server/auth/module-access";
import { canRenderDemoFixtures, requireScopedPageViewer } from "@/server/auth/page-access";

const rows = [
  { ...demoBusinessUnits.salam, id: "u1", name: "Farah", role: "Eksekutif Jualan", pipeline: "RM512k", won: "RM210k", target: "yes", followup: "current" },
  { ...demoBusinessUnits.bumi, id: "u2", name: "Amir", role: "Eksekutif Jualan", pipeline: "RM426k", won: "RM168k", target: "no", followup: "overdue" },
  { ...demoBusinessUnits.barakah, id: "u3", name: "Nadia", role: "Pengurus Jualan", pipeline: "RM398k", won: "RM352k", target: "yes", followup: "overdue" },
] as const;
const metricDefinitions: readonly DemoModuleMetric[] = [
  { key: "active", label: "Aktif", filterLabel: "Ahli aktif", definition: { formula: "Bilangan ahli pasukan aktif.", source: "Rekod pasukan demo." }, matches: () => true },
  { key: "target", label: "Sasaran dicapai", filterLabel: "Ahli capai sasaran", definition: { formula: "Bilangan ahli yang mencapai sasaran.", source: "Rekod pasukan demo." }, matches: (row) => row.target === "yes" },
  { key: "overdue", label: "Susulan lewat", filterLabel: "Ahli dengan susulan lewat", definition: { formula: "Bilangan ahli yang mempunyai susulan lewat.", source: "Rekod pasukan demo." }, matches: (row) => row.followup === "overdue" },
];
type PageSearchParams = Record<string, string | string[] | undefined>;

export default async function TeamPage({ searchParams }: { searchParams: Promise<PageSearchParams> }) {
  const query = await searchParams;
  const { scope } = await requireScopedPageViewer(query.bu, CRM_MODULE_ACCESS.team.capability, "/team", query);
  if (!canRenderDemoFixtures()) {
    return <DataEmptyState label="Belum ada data." />;
  }

  const metrics = createDemoModuleMetrics({ scope, capability: CRM_MODULE_ACCESS.team.capability, modulePath: "/team", dateBasis: "Tarikh aktiviti", periodLabel: "Bulan ini", rows, metrics: metricDefinitions });
  return <OperationalModule
    scope={scope}
    metrics={metrics}
    activeMetricKey={parseModuleMetricQuery(query.metric, metrics)}
    activeDefinitionKey={parseModuleMetricQuery(query.definition, metrics)}
    title="Pasukan jualan"
    columns={[{ key: "name", label: "Nama" }, { key: "role", label: "Peranan" }, { key: "pipeline", label: "Pipeline" }, { key: "won", label: "Menang", align: "right" }]}
    rows={rows}
  />;
}

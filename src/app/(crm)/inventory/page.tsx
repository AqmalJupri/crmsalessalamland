import { DataEmptyState } from "@/components/crm/data-empty-state";
import { createDemoModuleMetrics, OperationalModule, parseModuleMetricQuery, type DemoModuleMetric } from "@/components/crm/operational-module";
import { demoBusinessUnits } from "@/lib/demo-crm";
import { CRM_MODULE_ACCESS } from "@/server/auth/module-access";
import { canRenderDemoFixtures, requireScopedPageViewer } from "@/server/auth/page-access";

const rows = [
  { ...demoBusinessUnits.salam, id: "l1", lot: "A-118", project: "Fasa A", state: "Pegangan", expires: "16 Jul, 3:10 PTG" },
  { ...demoBusinessUnits.bumi, id: "l2", lot: "B-204", project: "Fasa B", state: "Ditempah", expires: "—" },
  { ...demoBusinessUnits.barakah, id: "l3", lot: "C-041", project: "Fasa C", state: "Tersedia", expires: "—" },
] as const;
const metricDefinitions: readonly DemoModuleMetric[] = [
  { key: "available", label: "Tersedia", filterLabel: "Lot tersedia", definition: { formula: "Bilangan lot berstatus Tersedia.", source: "Rekod inventori demo." }, matches: (row) => row.state === "Tersedia" },
  { key: "held", label: "Pegangan", filterLabel: "Lot dalam pegangan", definition: { formula: "Bilangan lot berstatus Pegangan.", source: "Rekod inventori demo." }, matches: (row) => row.state === "Pegangan" },
  { key: "booked", label: "Ditempah", filterLabel: "Lot ditempah", definition: { formula: "Bilangan lot berstatus Ditempah.", source: "Rekod inventori demo." }, matches: (row) => row.state === "Ditempah" },
];
type PageSearchParams = Record<string, string | string[] | undefined>;

export default async function InventoryPage({ searchParams }: { searchParams: Promise<PageSearchParams> }) {
  const query = await searchParams;
  const { scope } = await requireScopedPageViewer(query.bu, CRM_MODULE_ACCESS.inventory.capability, "/inventory", query);
  if (!canRenderDemoFixtures()) {
    return <DataEmptyState label="Belum ada data." />;
  }

  const metrics = createDemoModuleMetrics({ scope, capability: CRM_MODULE_ACCESS.inventory.capability, modulePath: "/inventory", dateBasis: "Status inventori", periodLabel: "Semasa", rows, metrics: metricDefinitions });
  return <OperationalModule
    scope={scope}
    metrics={metrics}
    activeMetricKey={parseModuleMetricQuery(query.metric, metrics)}
    activeDefinitionKey={parseModuleMetricQuery(query.definition, metrics)}
    title="Status lot"
    columns={[{ key: "lot", label: "Lot" }, { key: "project", label: "Projek" }, { key: "state", label: "Status" }, { key: "expires", label: "Tamat pegangan" }]}
    rows={rows}
  />;
}

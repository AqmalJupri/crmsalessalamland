import { OperationState } from "@/components/ui";
import { createDemoModuleMetrics, OperationalModule, parseModuleMetricQuery, type DemoModuleMetric } from "@/components/crm/operational-module";
import { demoBusinessUnits } from "@/lib/demo-crm";
import { CRM_MODULE_ACCESS } from "@/server/auth/module-access";
import { canRenderDemoFixtures, requireScopedPageViewer } from "@/server/auth/page-access";

const rows = [
  { ...demoBusinessUnits.salam, id: "r1", report: "Prestasi jualan", period: "Julai 2026", owner: "Pengurusan", updated: "Hari ini", category: "sales" },
  { ...demoBusinessUnits.bumi, id: "r2", report: "Usia kutipan", period: "Semasa", owner: "Kewangan", updated: "1 jam", category: "collections" },
  { ...demoBusinessUnits.barakah, id: "r3", report: "Atribusi pemasaran", period: "30 hari", owner: "Pemasaran", updated: "3 jam", category: "attribution" },
] as const;
const metricDefinitions: readonly DemoModuleMetric[] = [
  { key: "sales", label: "Laporan jualan", filterLabel: "Laporan jualan", definition: { formula: "Bilangan laporan yang menerangkan Kadar menang.", source: "Laporan tersimpan demo." }, matches: (row) => row.category === "sales" },
  { key: "collections", label: "Laporan kutipan", filterLabel: "Laporan kutipan", definition: { formula: "Bilangan laporan kutipan tersedia.", source: "Laporan tersimpan demo." }, matches: (row) => row.category === "collections" },
  { key: "attribution", label: "Atribusi pemasaran", filterLabel: "Laporan atribusi pemasaran", definition: { formula: "Bilangan laporan atribusi pemasaran.", source: "Laporan tersimpan demo." }, matches: (row) => row.category === "attribution" },
];
type PageSearchParams = Record<string, string | string[] | undefined>;

export default async function ReportsPage({ searchParams }: { searchParams: Promise<PageSearchParams> }) {
  const query = await searchParams;
  const { scope } = await requireScopedPageViewer(query.bu, CRM_MODULE_ACCESS.reports.capability, "/reports", query);
  if (!canRenderDemoFixtures()) {
    return <OperationState kind="empty" label="Belum ada laporan." />;
  }

  const metrics = createDemoModuleMetrics({ scope, capability: CRM_MODULE_ACCESS.reports.capability, modulePath: "/reports", dateBasis: "Tarikh rekod", periodLabel: "30 hari", rows, metrics: metricDefinitions });
  return <OperationalModule
    scope={scope}
    metrics={metrics}
    activeMetricKey={parseModuleMetricQuery(query.metric, metrics)}
    activeDefinitionKey={parseModuleMetricQuery(query.definition, metrics)}
    title="Laporan tersimpan"
    columns={[{ key: "report", label: "Laporan" }, { key: "period", label: "Tempoh" }, { key: "owner", label: "Pemilik" }, { key: "updated", label: "Dikemas kini" }]}
    rows={rows}
  />;
}

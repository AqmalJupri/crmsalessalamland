import { DataEmptyState } from "@/components/crm/data-empty-state";
import { createDemoModuleMetrics, OperationalModule, parseModuleMetricQuery, type DemoModuleMetric } from "@/components/crm/operational-module";
import { demoFinanceReceipts, formatMoneyMinor } from "@/lib/demo-crm";
import { CRM_MODULE_ACCESS } from "@/server/auth/module-access";
import { canRenderDemoFixtures, requireScopedPageViewer } from "@/server/auth/page-access";

const rows = demoFinanceReceipts;
const metricDefinitions: readonly DemoModuleMetric[] = [
  {
    key: "collections",
    label: "Kutipan",
    filterLabel: "Semua kutipan",
    definition: { formula: "Jumlah amaun resit diterima.", source: "Rekod resit demo." },
    matches: () => true,
    formatValue: (matches) => formatMoneyMinor(matches.reduce((sum, row) => sum + Number(row.amountMinor), 0), true),
  },
  {
    key: "allocated",
    label: "Diagih",
    filterLabel: "Kutipan diagih",
    definition: { formula: "Bilangan resit berstatus Diagih.", source: "Rekod resit demo." },
    matches: (row) => row.state === "Diagih",
  },
  {
    key: "partial",
    label: "Sebahagian",
    filterLabel: "Kutipan sebahagian",
    definition: { formula: "Bilangan resit berstatus Sebahagian.", source: "Rekod resit demo." },
    matches: (row) => row.state === "Sebahagian",
  },
];

type PageSearchParams = Record<string, string | string[] | undefined>;

export default async function FinancePage({ searchParams }: { searchParams: Promise<PageSearchParams> }) {
  const query = await searchParams;
  const { scope } = await requireScopedPageViewer(query.bu, CRM_MODULE_ACCESS.finance.capability, "/finance", query);
  if (!canRenderDemoFixtures()) {
    return <DataEmptyState label="Belum ada transaksi." />;
  }

  const metrics = createDemoModuleMetrics({ scope, capability: CRM_MODULE_ACCESS.finance.capability, modulePath: "/finance", dateBasis: "Tarikh bayaran", periodLabel: "Bulan ini", rows, metrics: metricDefinitions });
  return <OperationalModule
    scope={scope}
    metrics={metrics}
    activeMetricKey={parseModuleMetricQuery(query.metric, metrics)}
    activeDefinitionKey={parseModuleMetricQuery(query.definition, metrics)}
    title="Transaksi terkini"
    columns={[{ key: "receipt", label: "Resit" }, { key: "order", label: "Pesanan" }, { key: "state", label: "Status" }, { key: "amount", label: "Amaun", align: "right" }]}
    rows={rows}
  />;
}

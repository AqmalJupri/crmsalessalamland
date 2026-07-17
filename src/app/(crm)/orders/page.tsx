import type { Metadata } from "next";
import { OperationState } from "@/components/ui";
import { createDemoModuleMetrics, OperationalModule, parseModuleMetricQuery, type DemoModuleMetric } from "@/components/crm/operational-module";
import { demoBusinessUnits } from "@/lib/demo-crm";
import { CRM_MODULE_ACCESS } from "@/server/auth/module-access";
import { canRenderDemoFixtures, requireScopedPageViewer } from "@/server/auth/page-access";

export const metadata: Metadata = { title: "Pesanan" };

const rows = [
  { ...demoBusinessUnits.salam, id: "o1", order: "SL-2026-0481", customer: "Nur Aisyah", state: "Disahkan", value: "RM210,000" },
  { ...demoBusinessUnits.bumi, id: "o2", order: "BH-2026-0480", customer: "Daniel Wong", state: "Draf", value: "RM185,000" },
  { ...demoBusinessUnits.barakah, id: "o3", order: "BE-2026-0479", customer: "Aina Sofea", state: "Menunggu", value: "RM168,000" },
] as const;
const metricDefinitions: readonly DemoModuleMetric[] = [
  { key: "active", label: "Aktif", filterLabel: "Semua pesanan aktif", definition: { formula: "Bilangan pesanan semasa.", source: "Rekod pesanan demo." }, matches: () => true },
  { key: "pending", label: "Menunggu", filterLabel: "Pesanan menunggu", definition: { formula: "Bilangan pesanan berstatus Menunggu.", source: "Rekod pesanan demo." }, matches: (row) => row.state === "Menunggu" },
  { key: "confirmed", label: "Disahkan", filterLabel: "Pesanan disahkan", definition: { formula: "Bilangan pesanan berstatus Disahkan.", source: "Rekod pesanan demo." }, matches: (row) => row.state === "Disahkan", attributionModel: "Pesanan disahkan" },
];
type PageSearchParams = Record<string, string | string[] | undefined>;

export default async function OrdersPage({ searchParams }: { searchParams: Promise<PageSearchParams> }) {
  const query = await searchParams;
  const { scope } = await requireScopedPageViewer(query.bu, CRM_MODULE_ACCESS.orders.capability, "/orders", query);
  if (!canRenderDemoFixtures()) {
    return <OperationState kind="empty" label="Belum ada pesanan." />;
  }

  const metrics = createDemoModuleMetrics({ scope, capability: CRM_MODULE_ACCESS.orders.capability, modulePath: "/orders", dateBasis: "Tarikh pesanan", periodLabel: "30 hari", rows, metrics: metricDefinitions });
  return <OperationalModule
    scope={scope}
    metrics={metrics}
    activeMetricKey={parseModuleMetricQuery(query.metric, metrics)}
    activeDefinitionKey={parseModuleMetricQuery(query.definition, metrics)}
    title="Pesanan terkini"
    columns={[{ key: "order", label: "Pesanan" }, { key: "customer", label: "Pelanggan" }, { key: "state", label: "Status" }, { key: "value", label: "Nilai", align: "right" }]}
    rows={rows}
  />;
}

import type { Metadata } from "next";
import { OperationState } from "@/components/ui";
import { createDemoModuleMetrics, OperationalModule, parseModuleMetricQuery, type DemoModuleMetric } from "@/components/crm/operational-module";
import { demoBusinessUnits } from "@/lib/demo-crm";
import { CRM_MODULE_ACCESS } from "@/server/auth/module-access";
import { canRenderDemoFixtures, requireScopedPageViewer } from "@/server/auth/page-access";

export const metadata: Metadata = { title: "Tetapan" };

const rows = [
  { ...demoBusinessUnits.salam, id: "i1", provider: "Meta Lead Ads", state: "Tidak diketahui", checked: "Tidak diketahui", owner: "Pemasaran" },
  { ...demoBusinessUnits.bumi, id: "i2", provider: "TikTok Lead Gen", state: "Tidak diketahui", checked: "Tidak diketahui", owner: "Pemasaran" },
  { ...demoBusinessUnits.barakah, id: "i3", provider: "WhatsApp Cloud", state: "Tidak diketahui", checked: "Tidak diketahui", owner: "Operasi" },
] as const;
const metricDefinitions: readonly DemoModuleMetric[] = [
  { key: "unknown", label: "Status tidak diketahui", filterLabel: "Status tidak diketahui", definition: { formula: "Bilangan integrasi tanpa bukti masa pemeriksaan.", source: "Tiada bukti masa pemeriksaan tersedia." }, matches: (row) => row.state === "Tidak diketahui" },
  { key: "all", label: "Semua integrasi", filterLabel: "Semua integrasi", definition: { formula: "Bilangan integrasi yang disenaraikan.", source: "Senarai integrasi demo." }, matches: () => true },
];
type PageSearchParams = Record<string, string | string[] | undefined>;

export default async function SettingsPage({ searchParams }: { searchParams: Promise<PageSearchParams> }) {
  const query = await searchParams;
  const { scope } = await requireScopedPageViewer(query.bu, CRM_MODULE_ACCESS.settings.capability, "/settings", query);
  if (!canRenderDemoFixtures()) {
    return <OperationState kind="empty" label="Belum ada integrasi." />;
  }

  const metrics = createDemoModuleMetrics({ scope, capability: CRM_MODULE_ACCESS.settings.capability, modulePath: "/settings", dateBasis: "Masa pemeriksaan", periodLabel: "Semasa", asOf: null, freshness: "unknown", rows, metrics: metricDefinitions });
  return <OperationalModule
    scope={scope}
    metrics={metrics}
    activeMetricKey={parseModuleMetricQuery(query.metric, metrics)}
    activeDefinitionKey={parseModuleMetricQuery(query.definition, metrics)}
    title="Integrasi"
    columns={[{ key: "provider", label: "Penyedia" }, { key: "state", label: "Status" }, { key: "checked", label: "Diperiksa" }, { key: "owner", label: "Pemilik" }]}
    rows={rows}
  />;
}

import { OperationState } from "@/components/ui";
import { createDemoModuleMetrics, OperationalModule, parseModuleMetricQuery, type DemoModuleMetric } from "@/components/crm/operational-module";
import { demoBusinessUnits } from "@/lib/demo-crm";
import { CRM_MODULE_ACCESS } from "@/server/auth/module-access";
import { canRenderDemoFixtures, requireScopedPageViewer } from "@/server/auth/page-access";

const rows = [
  { ...demoBusinessUnits.salam, id: "i1", provider: "Meta Lead Ads", state: "Sihat", checked: "2 min", owner: "Pemasaran" },
  { ...demoBusinessUnits.bumi, id: "i2", provider: "TikTok Lead Gen", state: "Sihat", checked: "4 min", owner: "Pemasaran" },
  { ...demoBusinessUnits.barakah, id: "i3", provider: "WhatsApp Cloud", state: "Perlu semak", checked: "18 min", owner: "Operasi" },
] as const;
const metricDefinitions: readonly DemoModuleMetric[] = [
  { key: "healthy", label: "Integrasi sihat", filterLabel: "Integrasi sihat", definition: { formula: "Bilangan integrasi berstatus Sihat.", source: "Pemeriksaan integrasi demo." }, matches: (row) => row.state === "Sihat" },
  { key: "action", label: "Perlu tindakan", filterLabel: "Integrasi perlu tindakan", definition: { formula: "Bilangan integrasi yang perlu disemak.", source: "Pemeriksaan integrasi demo." }, matches: (row) => row.state === "Perlu semak" },
  { key: "all", label: "Semua integrasi", filterLabel: "Semua integrasi", definition: { formula: "Bilangan integrasi diperiksa.", source: "Pemeriksaan integrasi demo." }, matches: () => true },
];
type PageSearchParams = Record<string, string | string[] | undefined>;

export default async function SettingsPage({ searchParams }: { searchParams: Promise<PageSearchParams> }) {
  const query = await searchParams;
  const { scope } = await requireScopedPageViewer(query.bu, CRM_MODULE_ACCESS.settings.capability, "/settings", query);
  if (!canRenderDemoFixtures()) {
    return <OperationState kind="empty" label="Belum ada integrasi." />;
  }

  const metrics = createDemoModuleMetrics({ scope, capability: CRM_MODULE_ACCESS.settings.capability, modulePath: "/settings", dateBasis: "Masa pemeriksaan", periodLabel: "24 jam", rows, metrics: metricDefinitions });
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

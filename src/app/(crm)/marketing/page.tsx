import { DataEmptyState } from "@/components/crm/data-empty-state";
import { createDemoModuleMetrics, OperationalModule, parseModuleMetricQuery, type DemoModuleMetric } from "@/components/crm/operational-module";
import { demoBusinessUnits, formatMoneyMinor } from "@/lib/demo-crm";
import { CRM_MODULE_ACCESS } from "@/server/auth/module-access";
import { canRenderDemoFixtures, requireScopedPageViewer } from "@/server/auth/page-access";

const rows = [
  { ...demoBusinessUnits.salam, id: "c1", campaign: "Salam Land Julai", channel: "Meta", leads: "184", leadsCount: 184, spend: "RM10,240", spendMinor: 1_024_000 },
  { ...demoBusinessUnits.bumi, id: "c2", campaign: "Cetak Fasa C", channel: "TikTok", leads: "112", leadsCount: 112, spend: "RM6,820", spendMinor: 682_000 },
  { ...demoBusinessUnits.barakah, id: "c3", campaign: "Rujukan aktif", channel: "Rujukan", leads: "30", leadsCount: 30, spend: "RM1,340", spendMinor: 134_000 },
] as const;
const allRows = () => true;
const metricDefinitions: readonly DemoModuleMetric[] = [
  { key: "spend", label: "Belanja", filterLabel: "Kempen penyumbang belanja", definition: { formula: "Jumlah belanja kempen.", source: "Rekod kempen demo." }, matches: allRows, formatValue: (matches) => formatMoneyMinor(matches.reduce((sum, row) => sum + Number(row.spendMinor), 0), true), attributionModel: "Sentuhan terakhir" },
  { key: "leads", label: "Lead", filterLabel: "Kempen penyumbang lead", definition: { formula: "Jumlah lead kempen.", source: "Rekod kempen demo." }, matches: allRows, formatValue: (matches) => String(matches.reduce((sum, row) => sum + Number(row.leadsCount), 0)), attributionModel: "Sentuhan terakhir" },
  { key: "cpl", label: "CPL", filterLabel: "Kempen dalam kiraan CPL", definition: { formula: "Jumlah belanja dibahagi jumlah lead.", source: "Rekod kempen demo." }, matches: allRows, formatValue: (matches) => {
    const leads = matches.reduce((sum, row) => sum + Number(row.leadsCount), 0);
    const spend = matches.reduce((sum, row) => sum + Number(row.spendMinor), 0);
    return leads > 0 ? formatMoneyMinor(Math.round(spend / leads)) : "—";
  }, attributionModel: "Sentuhan terakhir" },
];
type PageSearchParams = Record<string, string | string[] | undefined>;

export default async function MarketingPage({ searchParams }: { searchParams: Promise<PageSearchParams> }) {
  const query = await searchParams;
  const { scope } = await requireScopedPageViewer(query.bu, CRM_MODULE_ACCESS.marketing.capability, "/marketing", query);
  if (!canRenderDemoFixtures()) {
    return <DataEmptyState label="Belum ada kempen." />;
  }

  const metrics = createDemoModuleMetrics({ scope, capability: CRM_MODULE_ACCESS.marketing.capability, modulePath: "/marketing", dateBasis: "Tarikh lead", periodLabel: "30 hari", rows, metrics: metricDefinitions });
  return <OperationalModule
    scope={scope}
    metrics={metrics}
    activeMetricKey={parseModuleMetricQuery(query.metric, metrics)}
    activeDefinitionKey={parseModuleMetricQuery(query.definition, metrics)}
    title="Kempen"
    columns={[{ key: "campaign", label: "Kempen" }, { key: "channel", label: "Saluran" }, { key: "leads", label: "Lead" }, { key: "spend", label: "Belanja", align: "right" }]}
    rows={rows}
  />;
}

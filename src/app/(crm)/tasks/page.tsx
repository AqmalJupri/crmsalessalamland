import type { Metadata } from "next";
import { OperationState } from "@/components/ui";
import { createDemoModuleMetrics, OperationalModule, parseModuleMetricQuery, type DemoModuleMetric, type ModuleRow } from "@/components/crm/operational-module";
import { demoTasks, isDemoTaskActionableToday } from "@/lib/demo-crm";
import { CRM_MODULE_ACCESS } from "@/server/auth/module-access";
import { canRenderDemoFixtures, requireScopedPageViewer } from "@/server/auth/page-access";

export const metadata: Metadata = { title: "Tugasan" };

const rows: readonly ModuleRow[] = demoTasks.map((task) => ({
  ...task,
  task: task.id === "t1" ? "Hubungi pelanggan" : task.title,
  record: task.title.replace(/^(?:Hubungi|Semak|Tamatkan|Hantar)\s+/, ""),
  owner: task.meta.split("·").at(-1)?.trim() ?? "—",
  due: task.meta.split("·")[0]?.trim() ?? "—",
}));
const metricDefinitions: readonly DemoModuleMetric[] = [
  {
    key: "today",
    label: "Hari ini",
    filterLabel: "Tugasan hari ini",
    definition: { formula: "Bilangan tugasan perlu tindakan hari ini.", source: "Rekod tugasan demo." },
    matches: (row) => isDemoTaskActionableToday({ status: row.status }),
  },
  {
    key: "overdue",
    label: "Susulan lewat",
    filterLabel: "Susulan lewat",
    definition: { formula: "Bilangan tugasan berstatus lewat.", source: "Rekod tugasan demo." },
    matches: (row) => row.status === "overdue",
  },
  {
    key: "upcoming",
    label: "Akan datang",
    filterLabel: "Tugasan akan datang",
    definition: { formula: "Bilangan tugasan selepas hari ini.", source: "Rekod tugasan demo." },
    matches: (row) => row.status === "upcoming",
  },
];

type PageSearchParams = Record<string, string | string[] | undefined>;

export default async function TasksPage({ searchParams }: { searchParams: Promise<PageSearchParams> }) {
  const query = await searchParams;
  const { scope } = await requireScopedPageViewer(query.bu, CRM_MODULE_ACCESS.tasks.capability, "/tasks", query);
  if (!canRenderDemoFixtures()) {
    return <OperationState kind="empty" label="Belum ada tugasan." />;
  }

  const metrics = createDemoModuleMetrics({ scope, capability: CRM_MODULE_ACCESS.tasks.capability, modulePath: "/tasks", dateBasis: "Tarikh akhir", periodLabel: "Hari ini", rows, metrics: metricDefinitions });
  return <OperationalModule
    scope={scope}
    metrics={metrics}
    activeMetricKey={parseModuleMetricQuery(query.metric, metrics)}
    activeDefinitionKey={parseModuleMetricQuery(query.definition, metrics)}
    title="Senarai tugasan"
    columns={[{ key: "task", label: "Tugasan" }, { key: "record", label: "Rekod" }, { key: "owner", label: "Pemilik" }, { key: "due", label: "Tarikh" }]}
    rows={rows}
  />;
}

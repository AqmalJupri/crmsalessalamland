import {
  ArrowRight,
  CalendarClock,
  CircleDollarSign,
  ContactRound,
  WalletCards,
} from "lucide-react";
import type { BusinessUnitReadScope } from "@/domain/business-units/read-scope";
import type { ProductSurface } from "@/config/product-surface";
import {
  demoActivities,
  demoKpis,
  demoTasks,
  aggregateDemoKpiInputs,
  filterDemoRecordsByUnitIds,
  filterOpportunityStagesByUnitIds,
  formatMoneyMinor,
  isActiveDemoOpportunityStage,
  isDemoTaskActionableToday,
  opportunityStages,
} from "@/lib/demo-crm";
import { scopedHref } from "@/domain/business-units/scope-url";
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui";
import { DataEmptyState } from "./data-empty-state";
import { createMetricScope, MetricCard, MetricGrid } from "./metric";

const DEMO_AS_OF = "2026-07-17T12:00:00+08:00";

function unitsForCapability(scope: BusinessUnitReadScope, capability: string) {
  const units = scope.kind === "ALL" ? scope.units : [scope.access];
  return units.filter((unit) => unit.capabilities.includes(capability));
}

function total(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0);
}

export function SurfaceHome({
  demo,
  scope,
  surface,
}: {
  demo: boolean;
  scope: BusinessUnitReadScope;
  surface: ProductSurface;
}) {
  if (surface === "tasha") {
    return <DataEmptyState label="Data pengecualian belum tersedia." />;
  }

  if (!demo) {
    return <DataEmptyState label="Belum ada data." />;
  }

  const leadUnits = unitsForCapability(scope, "lead.read");
  const taskUnits = unitsForCapability(scope, "task.read");
  const opportunityUnits = unitsForCapability(scope, "opportunity.read");
  const financeUnits = unitsForCapability(scope, "finance.read");
  const reportUnits = unitsForCapability(scope, "report.read");
  const capabilityUnitIds = (units: ReturnType<typeof unitsForCapability>) =>
    units.map((unit) => unit.id);
  const leadKpis = aggregateDemoKpiInputs(demoKpis, capabilityUnitIds(leadUnits));
  const taskKpis = aggregateDemoKpiInputs(demoKpis, capabilityUnitIds(taskUnits));
  const opportunityKpis = aggregateDemoKpiInputs(demoKpis, capabilityUnitIds(opportunityUnits));
  const financeKpis = aggregateDemoKpiInputs(demoKpis, capabilityUnitIds(financeUnits));
  const tasks = filterDemoRecordsByUnitIds(
    demoTasks,
    capabilityUnitIds(taskUnits),
  ).filter(isDemoTaskActionableToday);
  const activities = filterDemoRecordsByUnitIds(demoActivities, capabilityUnitIds(reportUnits));
  const pipelineStages = filterOpportunityStagesByUnitIds(
    opportunityStages.filter(isActiveDemoOpportunityStage),
    capabilityUnitIds(opportunityUnits),
  );
  const pipelineCount = total(pipelineStages.map((stage) => stage.items.length));
  const pipelineMax = Math.max(...pipelineStages.map((stage) => stage.items.length), 1);

  if (
    leadUnits.length === 0 &&
    taskUnits.length === 0 &&
    opportunityUnits.length === 0 &&
    financeUnits.length === 0 &&
    reportUnits.length === 0
  ) {
    return <DataEmptyState label="Belum ada data." />;
  }

  return (
    <div className="crm-page-stack">
      <MetricGrid>
        {leadUnits.length > 0 ? <MetricCard
          label="Lead baharu"
          value={String(leadKpis.leadNewCount)}
          icon={ContactRound}
          scope={createMetricScope({
            scope,
            capability: "lead.read",
            dateBasis: "Tarikh diterima",
            periodLabel: "30 hari",
            asOf: DEMO_AS_OF,
            freshness: "stale",
            attributionModel: null,
            definitionHref: "/leads?definition=lead-baharu",
            drilldownPath: "/leads?stage=new",
          })}
        /> : null}
        {taskUnits.length > 0 ? <MetricCard
          label="Susulan lewat"
          value={String(taskKpis.overdueTaskCount)}
          icon={CalendarClock}
          scope={createMetricScope({
            scope,
            capability: "task.read",
            dateBasis: "Tarikh akhir",
            periodLabel: "Hari ini",
            asOf: DEMO_AS_OF,
            freshness: "stale",
            attributionModel: null,
            definitionHref: "/tasks?definition=overdue",
            drilldownPath: "/tasks?metric=overdue",
          })}
        /> : null}
        {opportunityUnits.length > 0 ? <MetricCard
          label="Nilai pipeline"
          value={formatMoneyMinor(opportunityKpis.pipelineValueMinor, true)}
          icon={CircleDollarSign}
          scope={createMetricScope({
            scope,
            capability: "opportunity.read",
            dateBasis: "Tarikh peringkat",
            periodLabel: "Semasa",
            asOf: DEMO_AS_OF,
            freshness: "stale",
            attributionModel: null,
            definitionHref: "/pipeline?definition=active",
            drilldownPath: "/pipeline?metric=active",
          })}
        /> : null}
        {financeUnits.length > 0 ? <MetricCard
          label="Kutipan"
          value={formatMoneyMinor(financeKpis.collectionMinor, true)}
          icon={WalletCards}
          scope={createMetricScope({
            scope,
            capability: "finance.read",
            dateBasis: "Tarikh bayaran",
            periodLabel: "Bulan ini",
            asOf: DEMO_AS_OF,
            freshness: "stale",
            attributionModel: null,
            definitionHref: "/finance?definition=collections",
            drilldownPath: "/finance?metric=collections",
          })}
        /> : null}
      </MetricGrid>

      {taskUnits.length > 0 || opportunityUnits.length > 0 ? <div className="crm-dashboard-grid">
        {taskUnits.length > 0 ? <Card>
          <CardHeader>
            <CardTitle>Hari ini</CardTitle>
            <a href={scopedHref("/tasks", scope.queryValue)} className="crm-text-link">Semua <ArrowRight aria-hidden="true" /></a>
          </CardHeader>
          <CardContent className="crm-list-flush">
            <ul className="crm-task-list">
              {tasks.map((task) => (
                <li key={task.id} className="crm-task-row">
                  <span className="crm-task-row__marker" data-priority={task.priority} aria-hidden="true" />
                  <span className="crm-task-row__copy">
                    <strong>{task.title}</strong>
                    <span>{task.meta}</span>
                    {scope.kind === "ALL" ? <Badge>{task.businessUnitName}</Badge> : null}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card> : null}

        {opportunityUnits.length > 0 ? <Card>
          <CardHeader><CardTitle><a href={scopedHref("/pipeline", scope.queryValue)}>Pipeline</a></CardTitle><Badge variant="success">{pipelineCount} aktif</Badge></CardHeader>
          <CardContent>
            <div className="crm-funnel-list">
              {pipelineStages.map((stage) => {
                const count = stage.items.length;
                const width = Math.round((count / pipelineMax) * 100);
                return <div className="crm-funnel-row" key={stage.id}>
                  <div className="crm-funnel-row__label"><span>{stage.title}</span><strong>{count}</strong></div>
                  <div className="crm-progress" role="progressbar" aria-label={`${stage.title}: ${count}`} aria-valuenow={width} aria-valuemin={0} aria-valuemax={100}>
                    <span data-width={width} />
                  </div>
                </div>;
              })}
            </div>
          </CardContent>
        </Card> : null}
      </div> : null}

      {reportUnits.length > 0 ? <Card>
        <CardHeader><CardTitle>Aktiviti terkini</CardTitle></CardHeader>
        <CardContent className="crm-card-content--flush">
          <Table responsive="stack">
            <TableHeader><TableRow>{scope.kind === "ALL" ? <TableHead>Syarikat</TableHead> : null}<TableHead>Tindakan</TableHead><TableHead>Rekod</TableHead><TableHead>Oleh</TableHead><TableHead align="right">Masa</TableHead></TableRow></TableHeader>
            <TableBody>
              {activities.map((activity) => (
                <TableRow key={activity.id}>
                  {scope.kind === "ALL" ? <TableCell label="Syarikat"><Badge>{activity.businessUnitName}</Badge></TableCell> : null}
                  <TableCell label="Tindakan"><strong>{activity.action}</strong></TableCell>
                  <TableCell label="Rekod">{activity.record}</TableCell>
                  <TableCell label="Oleh">{activity.actor}</TableCell>
                  <TableCell label="Masa" align="right">{activity.time}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card> : null}
    </div>
  );
}

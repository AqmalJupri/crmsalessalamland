import { Badge, OperationState, Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui";
import type { BusinessUnitReadScope } from "@/domain/business-units/read-scope";
import { createMetricScope, MetricCard, MetricDefinitionPanel, MetricGrid, type MetricDefinitionContent, type MetricScope } from "./metric";

const DEMO_METRIC_AS_OF = "2026-07-17T12:00:00+08:00";
const METRIC_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface ModuleMetric {
  key: string;
  label: string;
  value: string;
  scope: MetricScope;
  definition: MetricDefinitionContent;
  filterLabel: string;
  matchedRowIds: readonly string[];
}

export interface DemoModuleMetric {
  key: string;
  label: string;
  filterLabel: string;
  definition: Pick<MetricDefinitionContent, "formula" | "source">;
  matches: (row: ModuleRow) => boolean;
  formatValue?: (rows: readonly ModuleRow[]) => string;
  attributionModel?: string;
}

export function createDemoModuleMetrics(input: {
  scope: BusinessUnitReadScope;
  capability: string;
  modulePath: string;
  dateBasis: string;
  periodLabel: string;
  rows: readonly ModuleRow[];
  metrics: readonly DemoModuleMetric[];
}): ModuleMetric[] {
  const unitIds = new Set(
    input.scope.kind === "ALL" ? input.scope.unitIds : [input.scope.businessUnitId],
  );
  const scopedRows = input.rows.filter((row) => unitIds.has(row.businessUnitId));
  return input.metrics.map((metric) => {
    if (!METRIC_KEY_PATTERN.test(metric.key)) {
      throw new Error("Metric key is invalid.");
    }
    const matchingRows = scopedRows.filter(metric.matches);
    return Object.freeze({
      key: metric.key,
      label: metric.label,
      value: metric.formatValue?.(matchingRows) ?? String(matchingRows.length),
      definition: Object.freeze({
        key: metric.key,
        title: metric.label,
        formula: metric.definition.formula,
        source: metric.definition.source,
        dateBasis: input.dateBasis,
      }),
      filterLabel: metric.filterLabel,
      matchedRowIds: Object.freeze(matchingRows.map((row) => row.id)),
      scope: createMetricScope({
        scope: input.scope,
        capability: input.capability,
        dateBasis: input.dateBasis,
        periodLabel: input.periodLabel,
        asOf: DEMO_METRIC_AS_OF,
        freshness: "stale",
        attributionModel: metric.attributionModel ?? null,
        definitionHref: `${input.modulePath}?definition=${metric.key}`,
        drilldownPath: `${input.modulePath}?metric=${metric.key}`,
      }),
    });
  });
}

export function parseModuleMetricQuery(
  raw: string | readonly string[] | undefined,
  metrics: readonly ModuleMetric[],
): string | null {
  if (typeof raw !== "string" || !METRIC_KEY_PATTERN.test(raw)) return null;
  return metrics.some((metric) => metric.key === raw) ? raw : null;
}

export interface ModuleColumn {
  key: string;
  label: string;
  align?: "left" | "center" | "right";
}

export interface ModuleRow {
  id: string;
  businessUnitId: string;
  businessUnitCode: string;
  businessUnitName: string;
  [key: string]: string | number;
}

function recordHeadingId(title: string): string {
  const key = title
    .normalize("NFKD")
    .toLocaleLowerCase("ms")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `crm-record-${key || "senarai"}`;
}

export function OperationalModule({
  metrics,
  scope,
  title,
  columns,
  rows,
  activeDefinitionKey = null,
  activeMetricKey = null,
}: {
  scope: BusinessUnitReadScope;
  metrics: readonly ModuleMetric[];
  title: string;
  columns: readonly ModuleColumn[];
  rows: readonly ModuleRow[];
  activeDefinitionKey?: string | null;
  activeMetricKey?: string | null;
}) {
  const unitIds = new Set(
    scope.kind === "ALL" ? scope.unitIds : [scope.businessUnitId],
  );
  const scopedRows = rows.filter((row) => unitIds.has(row.businessUnitId));
  const activeMetric = metrics.find((metric) => metric.key === activeMetricKey) ?? null;
  const activeDefinition = metrics.find((metric) => metric.key === activeDefinitionKey) ?? null;
  const matchedRowIds = activeMetric ? new Set(activeMetric.matchedRowIds) : null;
  const visibleRows = matchedRowIds
    ? scopedRows.filter((row) => matchedRowIds.has(row.id))
    : scopedRows;
  const isFilteredEmpty = scopedRows.length > 0 && activeMetric !== null;
  const visibleColumns: readonly ModuleColumn[] = scope.kind === "ALL"
    ? [{ key: "businessUnitName", label: "Syarikat" }, ...columns]
    : columns;
  const headingId = recordHeadingId(title);

  return (
    <div className="crm-page-stack">
      {activeDefinition ? <MetricDefinitionPanel definition={activeDefinition.definition} /> : null}
      {metrics.length > 0 ? (
        <MetricGrid>
          {metrics.map((metric) => (
            <MetricCard
              key={metric.label}
              label={metric.label}
              value={metric.value}
              scope={metric.scope}
            />
          ))}
        </MetricGrid>
      ) : null}
      {activeMetric ? (
        <p className="crm-filter-status" role="status">Tapis: {activeMetric.filterLabel} · {visibleRows.length} rekod</p>
      ) : null}
      <section className="crm-record-section" aria-labelledby={headingId}>
        <header className="crm-record-section__header">
          <h2 id={headingId}>{title}</h2>
          <Badge variant="neutral">{visibleRows.length}</Badge>
        </header>
        {visibleRows.length === 0 ? (
          <OperationState
            kind={isFilteredEmpty ? "filtered-empty" : "empty"}
            label={isFilteredEmpty ? "Tiada rekod sepadan." : "Belum ada rekod."}
          />
        ) : (
          <Table responsive="stack" containerLabel={title}>
            <TableCaption>{title}</TableCaption>
            <TableHeader><TableRow>{visibleColumns.map((column) => <TableHead key={column.key} {...(column.align ? { align: column.align } : {})}>{column.label}</TableHead>)}</TableRow></TableHeader>
            <TableBody>
              {visibleRows.map((row) => <TableRow key={row.id}>{visibleColumns.map((column) => <TableCell key={column.key} label={column.label} {...(column.align ? { align: column.align } : {})}>{row[column.key] ?? "—"}</TableCell>)}</TableRow>)}
            </TableBody>
          </Table>
        )}
      </section>
    </div>
  );
}

import type { HTMLAttributes, ReactNode } from "react";
import {
  ArrowDownRight,
  ArrowUpRight,
  Minus,
  type LucideIcon,
} from "lucide-react";

import { cn } from "../ui/utils";
import type { BusinessUnitReadScope } from "@/domain/business-units/read-scope";
import { scopedHref } from "@/domain/business-units/scope-url";

export type MetricTrend = "positive" | "negative" | "neutral";

export interface MetricScope {
  businessUnitIds: readonly string[];
  businessUnitCodes: readonly string[];
  dateBasis: string;
  periodLabel: string;
  timezone: "Asia/Kuala_Lumpur";
  asOf: string | null;
  freshness: "fresh" | "stale" | "unknown";
  attributionModel: string | null;
  definitionHref: string;
  drilldownHref: string;
}

const metricTimestampFormatter = new Intl.DateTimeFormat("ms-MY", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "Asia/Kuala_Lumpur",
});

export function createMetricScope(input: {
  scope: BusinessUnitReadScope;
  capability: string;
  dateBasis: string;
  periodLabel: string;
  asOf: string | null;
  freshness: MetricScope["freshness"];
  attributionModel: string | null;
  definitionHref: string;
  drilldownPath: string;
}): MetricScope {
  if (input.asOf !== null && !Number.isFinite(Date.parse(input.asOf))) {
    throw new Error("Metric as-of timestamp is invalid.");
  }
  if (input.asOf === null && input.freshness !== "unknown") {
    throw new Error("Metric freshness requires an as-of timestamp.");
  }
  const units = input.scope.kind === "ALL"
    ? input.scope.units.filter((unit) => unit.capabilities.includes(input.capability))
    : input.scope.access.capabilities.includes(input.capability)
      ? [input.scope.access]
      : [];
  if (units.length === 0) {
    throw new Error("Metric scope has no authorised business unit.");
  }
  return Object.freeze({
    businessUnitIds: Object.freeze(units.map((unit) => unit.id)),
    businessUnitCodes: Object.freeze(units.map((unit) => unit.code)),
    dateBasis: input.dateBasis,
    periodLabel: input.periodLabel,
    timezone: "Asia/Kuala_Lumpur",
    asOf: input.asOf,
    freshness: input.freshness,
    attributionModel: input.attributionModel,
    definitionHref: scopedHref(input.definitionHref, input.scope.queryValue),
    drilldownHref: scopedHref(input.drilldownPath, input.scope.queryValue),
  });
}

export interface MetricCardProps extends HTMLAttributes<HTMLElement> {
  label: string;
  value: ReactNode;
  icon?: LucideIcon;
  delta?: ReactNode;
  trend?: MetricTrend;
  context?: ReactNode;
  scope: MetricScope;
}

const trendIcon: Record<MetricTrend, LucideIcon> = {
  positive: ArrowUpRight,
  negative: ArrowDownRight,
  neutral: Minus,
};

export function MetricCard({
  className,
  context,
  delta,
  icon: Icon,
  label,
  scope,
  trend = "neutral",
  value,
  ...props
}: MetricCardProps) {
  const TrendIcon = trendIcon[trend];

  return (
    <article className={cn("crm-metric", className)} {...props}>
      <div className="crm-metric__header">
        <span className="crm-metric__label">{label}</span>
        {Icon ? (
          <span className="crm-metric__icon" aria-hidden="true">
            <Icon />
          </span>
        ) : null}
      </div>
      <p className="crm-metric__value">
        <a href={scope.drilldownHref} aria-label={`Lihat rekod ${label}`}>{value}</a>
      </p>
      {delta !== undefined || context ? (
        <div className="crm-metric__footer">
          {delta !== undefined ? (
            <span className="crm-metric__delta" data-trend={trend}>
              <TrendIcon aria-hidden="true" size={14} />
              {delta}
            </span>
          ) : null}
          {context ? (
            <span className="crm-metric__context">{context}</span>
          ) : null}
        </div>
      ) : null}
      <div className="crm-metric__scope">
        <span>{scope.businessUnitCodes.join(", ")} · {scope.periodLabel}</span>
        <span>
          {scope.dateBasis} · {{ fresh: "Semasa", stale: "Lewat", unknown: "Tidak diketahui" }[scope.freshness]}
        </span>
        {scope.asOf !== null ? (
          <span>
            <time dateTime={scope.asOf}>{metricTimestampFormatter.format(new Date(scope.asOf))}</time>
            {scope.attributionModel ? ` · ${scope.attributionModel}` : ""}
          </span>
        ) : scope.attributionModel ? (
          <span>{scope.attributionModel}</span>
        ) : null}
        <a href={scope.definitionHref} aria-label={`Lihat definisi ${label}`}>Definisi</a>
      </div>
    </article>
  );
}

export interface MetricDefinitionContent {
  key: string;
  title: string;
  formula: string;
  source: string;
  dateBasis: string;
}

export function MetricDefinitionPanel({
  definition,
}: {
  definition: MetricDefinitionContent;
}) {
  return (
    <section className="crm-metric-definition" aria-labelledby={`metric-definition-${definition.key}`}>
      <h2 id={`metric-definition-${definition.key}`}>Definisi {definition.title}</h2>
      <dl>
        <div><dt>Formula</dt><dd>{definition.formula}</dd></div>
        <div><dt>Sumber</dt><dd>{definition.source}</dd></div>
        <div><dt>Asas tarikh</dt><dd>{definition.dateBasis}</dd></div>
      </dl>
    </section>
  );
}

export function MetricGrid({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("crm-metric-grid", className)} {...props} />;
}

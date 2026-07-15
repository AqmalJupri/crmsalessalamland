import type { HTMLAttributes, ReactNode } from "react";
import {
  ArrowDownRight,
  ArrowUpRight,
  Minus,
  type LucideIcon,
} from "lucide-react";

import { cn } from "../ui/utils";

export type MetricTrend = "positive" | "negative" | "neutral";

export interface MetricCardProps extends HTMLAttributes<HTMLElement> {
  label: ReactNode;
  value: ReactNode;
  icon?: LucideIcon;
  delta?: ReactNode;
  trend?: MetricTrend;
  context?: ReactNode;
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
      <p className="crm-metric__value">{value}</p>
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
    </article>
  );
}

export function MetricGrid({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("crm-metric-grid", className)} {...props} />;
}

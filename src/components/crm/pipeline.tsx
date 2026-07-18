"use client";

import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ArrowRight } from "lucide-react";

import { cn } from "../ui/utils";

export interface PipelineRecord {
  id: string;
  title: string;
  href?: string;
  meta?: ReactNode;
  value?: ReactNode;
  owner?: ReactNode;
  due?: ReactNode;
  status?: ReactNode;
}

export type PipelineStageTone = "default" | "success" | "danger";

export interface PipelineStage {
  id: string;
  title: string;
  items: PipelineRecord[];
  count?: number;
  value?: ReactNode;
  tone?: PipelineStageTone;
  emptyLabel?: ReactNode;
}

export interface PipelineItemProps {
  item: PipelineRecord;
  className?: string;
  onActivate?: (item: PipelineRecord) => void;
}

function PipelineItemContent({ item }: { item: PipelineRecord }) {
  return (
    <>
      <div className="crm-pipeline-item__title">{item.title}</div>
      {item.meta !== undefined || item.status ? (
        <div className="crm-pipeline-item__meta">
          <span>{item.meta}</span>
          {item.status ? <span>{item.status}</span> : null}
        </div>
      ) : null}
      {item.value !== undefined || item.owner || item.due ? (
        <div className="crm-pipeline-item__footer">
          <span className="crm-pipeline-item__value">{item.value}</span>
          <span>{item.owner ?? item.due}</span>
        </div>
      ) : null}
    </>
  );
}

export function PipelineItem({
  className,
  item,
  onActivate,
}: PipelineItemProps) {
  const classes = cn("crm-pipeline-item", className);

  if (item.href) {
    return (
      <a
        className={classes}
        href={item.href}
        onClick={() => onActivate?.(item)}
      >
        <PipelineItemContent item={item} />
      </a>
    );
  }

  if (onActivate) {
    return (
      <button
        type="button"
        className={classes}
        onClick={() => onActivate(item)}
      >
        <PipelineItemContent item={item} />
      </button>
    );
  }

  return (
    <article className={classes}>
      <PipelineItemContent item={item} />
    </article>
  );
}

export interface PipelineBoardProps {
  stages: PipelineStage[];
  ariaLabel?: string;
  className?: string;
  onItemActivate?: (item: PipelineRecord, stage: PipelineStage) => void;
  renderItem?: (item: PipelineRecord, stage: PipelineStage) => ReactNode;
}

export function PipelineBoard({
  ariaLabel = "Pipeline jualan",
  className,
  onItemActivate,
  renderItem,
  stages,
}: PipelineBoardProps) {
  const boardId = useId().replace(/:/g, "");
  const hintId = `crm-pipeline-${boardId}-hint`;
  const viewportRef = useRef<HTMLElement>(null);
  const [isScrollable, setIsScrollable] = useState(false);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const measure = () => {
      setIsScrollable(viewport.scrollWidth - viewport.clientWidth > 1);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    const board = viewport.firstElementChild;
    if (board) observer.observe(board);
    return () => observer.disconnect();
  }, [stages]);

  return (
    <div className={cn("crm-pipeline-region", className)}>
      {isScrollable ? <p id={hintId} className="crm-pipeline-region__hint">
        <span>Leret</span>
        <ArrowRight aria-hidden="true" />
      </p> : null}
      <section
        ref={viewportRef}
        className="crm-pipeline-region__viewport"
        aria-label={ariaLabel}
        aria-describedby={isScrollable ? hintId : undefined}
        tabIndex={isScrollable ? 0 : undefined}
      >
        <div className="crm-pipeline" role="list">
        {stages.map((stage) => {
          const titleId = `crm-pipeline-${boardId}-${stage.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;

          return (
            <section
              key={stage.id}
              className="crm-pipeline__stage"
              data-tone={stage.tone ?? "default"}
              role="listitem"
              aria-labelledby={titleId}
            >
              <header className="crm-pipeline__stage-header">
                <div className="crm-pipeline__stage-heading">
                  <h2 id={titleId} className="crm-pipeline__stage-title">
                    {stage.title}
                  </h2>
                  <span
                    className="crm-pipeline__stage-count"
                    aria-label={`${stage.count ?? stage.items.length} rekod`}
                  >
                    {stage.count ?? stage.items.length}
                  </span>
                </div>
                {stage.value !== undefined ? (
                  <p className="crm-pipeline__stage-value">{stage.value}</p>
                ) : null}
              </header>

              {stage.items.length > 0 ? (
                <ol className="crm-pipeline__items">
                  {stage.items.map((item) => (
                    <li key={item.id}>
                      {renderItem ? (
                        renderItem(item, stage)
                      ) : (
                        onItemActivate ? (
                          <PipelineItem
                            item={item}
                            onActivate={() => onItemActivate(item, stage)}
                          />
                        ) : (
                          <PipelineItem item={item} />
                        )
                      )}
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="crm-pipeline__empty">
                  {stage.emptyLabel ?? "Tiada rekod"}
                </p>
              )}
            </section>
          );
        })}
        </div>
      </section>
    </div>
  );
}

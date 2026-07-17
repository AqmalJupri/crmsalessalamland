"use client";

import { useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { PipelineBoard, type PipelineStage } from "@/components/crm";
import { Button, OperationState } from "@/components/ui";
import type { ClientBusinessScope } from "@/domain/business-units/client-scope";
import {
  filterOpportunityStagesByUnitIds,
  formatMoneyMinor,
  opportunityStageTotalMinor,
  type DemoOpportunityStage,
} from "@/lib/demo-crm";
import { useDialogFocus } from "./use-dialog-focus";

function copyScopedStages(
  initialStages: readonly DemoOpportunityStage[],
  scope: ClientBusinessScope,
): DemoOpportunityStage[] {
  const unitIds = scope.kind === "ALL" ? scope.unitIds : [scope.businessUnitId];
  return filterOpportunityStagesByUnitIds(initialStages, unitIds).map((stage) => ({
      ...stage,
      items: stage.items.map((item) => ({ ...item })),
  }));
}

interface PipelineWorkspaceProps {
  initialStages: DemoOpportunityStage[];
  emptyStateKind?: "empty";
  scope: ClientBusinessScope;
  populationKey: "all" | "active";
  sourcePopulationCount: number;
  activeFilterLabel?: string | null;
}

export function PipelineWorkspace(props: PipelineWorkspaceProps) {
  const scopeKey = props.scope.kind === "ALL"
    ? `ALL:${props.scope.unitIds.join("|")}`
    : `UNIT:${props.scope.businessUnitId}`;
  return (
    <ScopedPipelineWorkspace
      key={`${scopeKey}:population:${props.populationKey}`}
      {...props}
    />
  );
}

function ScopedPipelineWorkspace({
  initialStages,
  emptyStateKind = "empty",
  scope,
  sourcePopulationCount,
  activeFilterLabel = null,
}: PipelineWorkspaceProps) {
  const [stages, setStages] = useState<DemoOpportunityStage[]>(() =>
    copyScopedStages(initialStages, scope),
  );
  const [selected, setSelected] = useState<{ itemId: string; stageId: string } | null>(null);
  const itemCount = stages.reduce((sum, stage) => sum + stage.items.length, 0);
  const isFilteredEmpty = sourcePopulationCount > 0 && Boolean(activeFilterLabel);
  const detailDialogRef = useRef<HTMLElement>(null);
  const detailCloseRef = useRef<HTMLButtonElement>(null);

  const selection = useMemo(() => {
    if (!selected) return null;
    const stageIndex = stages.findIndex((stage) => stage.id === selected.stageId);
    const item = stages[stageIndex]?.items.find((record) => record.id === selected.itemId);
    return item && stageIndex >= 0 ? { item, stageIndex } : null;
  }, [selected, stages]);

  const boardStages = useMemo<PipelineStage[]>(() => stages.map((stage) => ({
    ...stage,
    value: formatMoneyMinor(opportunityStageTotalMinor(stage.items), true),
    items: stage.items.map((item) => ({
      ...item,
      status: scope.kind === "ALL" ? item.businessUnitName : undefined,
      value: formatMoneyMinor(item.valueMinor, true),
    })),
  })), [scope.kind, stages]);

  useDialogFocus({
    dialogRef: detailDialogRef,
    initialFocusRef: detailCloseRef,
    onClose: () => setSelected(null),
    open: selection !== null,
  });

  function move(direction: -1 | 1): void {
    if (!selection || scope.kind === "ALL") return;
    const targetIndex = selection.stageIndex + direction;
    const target = stages[targetIndex];
    const source = stages[selection.stageIndex];
    if (!target || !source) return;
    setStages((current) => current.map((stage, index) => {
      if (index === selection.stageIndex) return { ...stage, items: stage.items.filter((item) => item.id !== selection.item.id) };
      if (index === targetIndex) return { ...stage, items: [selection.item, ...stage.items] };
      return stage;
    }));
    setSelected({ itemId: selection.item.id, stageId: target.id });
  }

  return (
    <div className="crm-workspace">
      <div
        className="crm-page-stack crm-workspace-background"
        inert={selection !== null || undefined}
        aria-hidden={selection !== null || undefined}
      >
        {activeFilterLabel ? (
          <p className="crm-filter-status" role="status">
            Tapis: {activeFilterLabel} · {itemCount} rekod
          </p>
        ) : null}
        {itemCount === 0 ? (
          <OperationState
            kind={isFilteredEmpty ? "filtered-empty" : emptyStateKind}
            label={isFilteredEmpty ? "Tiada peluang sepadan." : "Belum ada peluang."}
          />
        ) : (
          <PipelineBoard
            stages={boardStages}
            onItemActivate={(item, stage) => setSelected({ itemId: item.id, stageId: stage.id })}
          />
        )}
      </div>

      {selection ? (
        <>
          <button className="crm-detail-backdrop" type="button" aria-label="Tutup butiran peluang" onClick={() => setSelected(null)} />
          <aside ref={detailDialogRef} className="crm-detail-panel" role="dialog" aria-modal="true" aria-labelledby="opportunity-title" tabIndex={-1}>
            <header className="crm-detail-panel__header"><div><h2 id="opportunity-title">{selection.item.title}</h2><p>{selection.item.meta}</p></div><Button ref={detailCloseRef} size="icon" variant="quiet" aria-label="Tutup" onClick={() => setSelected(null)}><X aria-hidden="true" /></Button></header>
            <section className="crm-detail-panel__section"><h3>Ringkasan</h3><ul className="crm-detail-list">{scope.kind === "ALL" ? <li><span>Syarikat</span><strong>{selection.item.businessUnitName}</strong></li> : null}<li><span>Peringkat</span><strong>{stages[selection.stageIndex]?.title}</strong></li><li><span>Nilai</span><strong>{formatMoneyMinor(selection.item.valueMinor)}</strong></li><li><span>Pemilik</span><strong>{selection.item.owner}</strong></li></ul></section>
            <footer className="crm-detail-panel__footer">{scope.kind === "ALL" ? <Button disabled>Pilih syarikat</Button> : <><Button disabled={selection.stageIndex === 0} onClick={() => move(-1)}><ChevronLeft aria-hidden="true" />Undur</Button><Button variant="primary" disabled={selection.stageIndex === stages.length - 1} onClick={() => move(1)}>Seterusnya<ChevronRight aria-hidden="true" /></Button></>}</footer>
          </aside>
        </>
      ) : null}
    </div>
  );
}

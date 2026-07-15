"use client";

import { useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { PipelineBoard, type PipelineStage } from "@/components/crm";
import { Button } from "@/components/ui";
import { formatMoneyMinor, opportunityStageTotalMinor, type DemoOpportunityStage } from "@/lib/demo-crm";
import { DataEmptyState } from "./data-empty-state";
import { useDialogFocus } from "./use-dialog-focus";

export function PipelineWorkspace({ initialStages }: { initialStages: DemoOpportunityStage[] }) {
  const [stages, setStages] = useState<DemoOpportunityStage[]>(() =>
    initialStages.map((stage) => ({
      ...stage,
      items: stage.items.map((item) => ({ ...item })),
    })),
  );
  const [selected, setSelected] = useState<{ itemId: string; stageId: string } | null>(null);
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
      value: formatMoneyMinor(item.valueMinor, true),
    })),
  })), [stages]);

  useDialogFocus({
    dialogRef: detailDialogRef,
    initialFocusRef: detailCloseRef,
    onClose: () => setSelected(null),
    open: selection !== null,
  });

  function move(direction: -1 | 1): void {
    if (!selection) return;
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
        {stages.length === 0 ? (
          <DataEmptyState label="Belum ada peluang." />
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
            <section className="crm-detail-panel__section"><h3>Ringkasan</h3><ul className="crm-detail-list"><li><span>Peringkat</span><strong>{stages[selection.stageIndex]?.title}</strong></li><li><span>Nilai</span><strong>{formatMoneyMinor(selection.item.valueMinor)}</strong></li><li><span>Pemilik</span><strong>{selection.item.owner}</strong></li></ul></section>
            <footer className="crm-detail-panel__footer"><Button disabled={selection.stageIndex === 0} onClick={() => move(-1)}><ChevronLeft aria-hidden="true" />Undur</Button><Button variant="primary" disabled={selection.stageIndex === stages.length - 1} onClick={() => move(1)}>Seterusnya<ChevronRight aria-hidden="true" /></Button></footer>
          </aside>
        </>
      ) : null}
    </div>
  );
}

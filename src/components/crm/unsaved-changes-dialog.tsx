"use client";

import { useRef } from "react";
import { Button } from "@/components/ui";
import { useDialogFocus } from "./use-dialog-focus";

export interface UnsavedChangesDialogProps {
  formName: string;
  onCancel: () => void;
  onDiscard: () => void;
  open: boolean;
}

export function UnsavedChangesDialog({
  formName,
  onCancel,
  onDiscard,
  open,
}: UnsavedChangesDialogProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useDialogFocus({
    dialogRef,
    initialFocusRef: cancelRef,
    onClose: onCancel,
    open,
  });

  if (!open) return null;

  return (
    <div className="crm-modal-backdrop crm-modal-backdrop--confirm" data-unsaved-changes-backdrop>
      <section
        ref={dialogRef}
        className="crm-modal crm-confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="unsaved-changes-title"
        aria-describedby="unsaved-changes-description"
        tabIndex={-1}
      >
        <header className="crm-modal__header">
          <h2 id="unsaved-changes-title">Buang perubahan?</h2>
        </header>
        <div className="crm-confirm-dialog__body">
          <p id="unsaved-changes-description">
            Perubahan dalam {formName} akan dibuang.
          </p>
        </div>
        <footer className="crm-modal__footer">
          <Button ref={cancelRef} onClick={onCancel}>Kekalkan perubahan</Button>
          <Button variant="danger" onClick={onDiscard}>Buang perubahan</Button>
        </footer>
      </section>
    </div>
  );
}

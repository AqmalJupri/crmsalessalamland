"use client";

import { useEffect, useRef, type RefObject } from "react";

const focusableSelector = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[contenteditable='true']",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

let bodyScrollLockCount = 0;
let bodyOverflowBeforeLocks: string | null = null;

function acquireBodyScrollLock(): () => void {
  if (bodyScrollLockCount === 0) {
    bodyOverflowBeforeLocks = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
  bodyScrollLockCount += 1;
  let released = false;

  return () => {
    if (released) return;
    released = true;
    bodyScrollLockCount = Math.max(0, bodyScrollLockCount - 1);
    if (bodyScrollLockCount === 0) {
      document.body.style.overflow = bodyOverflowBeforeLocks ?? "";
      bodyOverflowBeforeLocks = null;
    }
  };
}

function focusableElements(dialog: HTMLElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector)).filter(
    (element) => !element.hidden && element.getAttribute("aria-hidden") !== "true",
  );
}

export function useDialogFocus({
  dialogRef,
  initialFocusRef,
  onClose,
  open,
  paused = false,
}: {
  dialogRef: RefObject<HTMLElement | null>;
  initialFocusRef?: RefObject<HTMLElement | null>;
  onClose: () => void;
  open: boolean;
  paused?: boolean;
}): void {
  const onCloseRef = useRef(onClose);
  const pausedRef = useRef(paused);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  useEffect(() => {
    if (!open) return;

    const opener = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const releaseBodyScrollLock = acquireBodyScrollLock();

    const dialog = dialogRef.current;
    const initialFocus = initialFocusRef?.current ?? (dialog ? focusableElements(dialog)[0] : null);
    (initialFocus ?? dialog)?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (pausedRef.current) return;
      const currentDialog = dialogRef.current;
      if (!currentDialog) return;

      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }

      if (event.key !== "Tab") return;
      const controls = focusableElements(currentDialog);
      if (controls.length === 0) {
        event.preventDefault();
        currentDialog.focus();
        return;
      }

      const first = controls[0]!;
      const last = controls[controls.length - 1]!;
      const active = document.activeElement;
      if (!currentDialog.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && (active === first || !controls.includes(active as HTMLElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !controls.includes(active as HTMLElement))) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      releaseBodyScrollLock();
      if (opener?.isConnected) opener.focus();
    };
  }, [dialogRef, initialFocusRef, open]);
}

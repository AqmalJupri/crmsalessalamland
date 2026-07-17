"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { Building2, Check, ChevronDown } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { PublicBusinessUnitAccess } from "@/domain/auth/public-viewer";

interface SwitcherOption {
  id: string | null;
  code: string;
  name: string;
}

const tabbableSelector = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export function BusinessUnitSwitcher({
  selectedCode,
  units,
}: {
  selectedCode: string;
  units: readonly PublicBusinessUnitAccess[];
}) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const listboxId = `crm-business-units-${useId().replace(/:/g, "")}`;
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef(new Map<string, HTMLButtonElement>());
  const restoreFocusAfterCloseRef = useRef(false);
  const [open, setOpen] = useState(false);
  const [savingCode, setSavingCode] = useState<string | null>(null);
  const [error, setError] = useState("");
  const options: readonly SwitcherOption[] = [
    { id: null, code: "all", name: "Semua" },
    ...units.map((unit) => ({ id: unit.id, code: unit.code, name: unit.name })),
  ];
  const selected = options.find((option) => option.code === selectedCode) ?? options[0]!;
  const [focusedCode, setFocusedCode] = useState(selected.code);

  useEffect(() => {
    if (!open) return;
    optionRefs.current.get(focusedCode)?.focus();

    const onPointerDown = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        rootRef.current &&
        !rootRef.current.contains(event.target)
      ) {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [focusedCode, open]);

  useEffect(() => {
    if (open || !restoreFocusAfterCloseRef.current) return;
    restoreFocusAfterCloseRef.current = false;
    triggerRef.current?.focus();
  }, [open]);

  function closeAndFocus(): void {
    restoreFocusAfterCloseRef.current = true;
    setOpen(false);
  }

  function moveFocus(event: KeyboardEvent, offset: number): void {
    event.preventDefault();
    const currentIndex = options.findIndex(
      (option) => optionRefs.current.get(option.code) === document.activeElement,
    );
    const nextIndex = (currentIndex + offset + options.length) % options.length;
    const next = options[nextIndex];
    if (next) {
      setFocusedCode(next.code);
      optionRefs.current.get(next.code)?.focus();
    }
  }

  function destination(code: string): string {
    const next = new URLSearchParams(searchParams.toString());
    next.set("bu", code);
    const query = next.toString();
    return `${pathname}${query ? `?${query}` : ""}`;
  }

  function closeForTab(event: KeyboardEvent): void {
    const controls = Array.from(
      document.querySelectorAll<HTMLElement>(tabbableSelector),
    ).filter((control) => !control.hidden && control.tabIndex >= 0);
    const currentIndex = controls.indexOf(document.activeElement as HTMLElement);
    const target = controls[currentIndex + (event.shiftKey ? -1 : 1)];
    setOpen(false);
    if (target) {
      event.preventDefault();
      target.focus();
    }
  }

  async function selectOption(option: SwitcherOption): Promise<void> {
    if (savingCode !== null) return;
    setError("");
    if (option.code === selected.code) {
      closeAndFocus();
      return;
    }
    if (option.id === null) {
      router.push(destination("all"));
      closeAndFocus();
      return;
    }

    setSavingCode(option.code);
    try {
      const response = await fetch("/api/v1/auth/business-unit", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessUnitId: option.id }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        throw new Error(body?.error?.message ?? "Syarikat tidak dapat ditukar.");
      }
      router.push(destination(option.code));
      closeAndFocus();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Syarikat tidak dapat ditukar.",
      );
    } finally {
      setSavingCode(null);
    }
  }

  return (
    <div ref={rootRef} className="crm-business-unit-switcher">
      <button
        ref={triggerRef}
        type="button"
        className="crm-workspace-switcher"
        aria-label={`Tukar syarikat. Semasa: ${selected.name}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        onClick={() => {
          if (open) {
            setOpen(false);
            return;
          }
          setFocusedCode(selected.code);
          setOpen(true);
        }}
      >
        <Building2 aria-hidden="true" />
        <span className="crm-workspace-switcher__copy">
          <span className="crm-workspace-switcher__label">Syarikat</span>
          <span className="crm-workspace-switcher__name">{selected.name}</span>
        </span>
        <ChevronDown aria-hidden="true" />
      </button>

      {open ? (
        <ul
          id={listboxId}
          className="crm-business-unit-switcher__menu"
          role="listbox"
          aria-label="Syarikat"
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") moveFocus(event, 1);
            else if (event.key === "ArrowUp") moveFocus(event, -1);
            else if (event.key === "Home") {
              event.preventDefault();
              const first = options[0]!;
              setFocusedCode(first.code);
              optionRefs.current.get(first.code)?.focus();
            } else if (event.key === "End") {
              event.preventDefault();
              const last = options.at(-1)!;
              setFocusedCode(last.code);
              optionRefs.current.get(last.code)?.focus();
            } else if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              closeAndFocus();
            } else if (event.key === "Tab") {
              closeForTab(event);
            }
          }}
        >
          {options.map((option) => (
            <li key={option.code} role="presentation">
              <button
                ref={(node) => {
                  if (node) optionRefs.current.set(option.code, node);
                  else optionRefs.current.delete(option.code);
                }}
                type="button"
                role="option"
                aria-selected={option.code === selected.code}
                tabIndex={option.code === focusedCode ? 0 : -1}
                disabled={savingCode !== null}
                onClick={() => void selectOption(option)}
              >
                <span>{option.name}</span>
                {option.code === selected.code ? <Check aria-hidden="true" /> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="crm-live-status" role="status" aria-live="polite">{error}</p>
    </div>
  );
}

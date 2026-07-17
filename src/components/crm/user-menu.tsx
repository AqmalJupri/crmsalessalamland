"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ChevronDown, LogOut } from "lucide-react";

export interface UserMenuProps {
  displayName: string;
  sessionExpiresAt: string | null;
  demo?: boolean;
  onLoggedOut?: () => void;
}

function initialsFor(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}

function formatExpiry(value: string): string | null {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("ms-MY", {
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    month: "short",
    timeZone: "Asia/Kuala_Lumpur",
    year: "numeric",
  }).format(date);
}

const pageFocusableSelector = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

async function errorMessage(response: Response): Promise<string> {
  try {
    const body = await response.json() as { error?: { message?: unknown } };
    if (typeof body.error?.message === "string" && body.error.message.trim()) {
      return body.error.message;
    }
  } catch {
    // A non-JSON failure still receives the safe message below.
  }
  return "Log keluar tidak berjaya. Cuba lagi.";
}

export function UserMenu({
  demo = false,
  displayName,
  onLoggedOut,
  sessionExpiresAt,
}: UserMenuProps) {
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [sessionNow, setSessionNow] = useState(() => Date.now());
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const logoutRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const expiry = sessionExpiresAt ? formatExpiry(sessionExpiresAt) : null;
  const expiryTimestamp = sessionExpiresAt ? Date.parse(sessionExpiresAt) : Number.NaN;
  const hasValidExpiry = expiry !== null && Number.isFinite(expiryTimestamp);
  const sessionStatus = demo
    ? "Sesi demo"
    : !hasValidExpiry
      ? "Status sesi tidak tersedia"
      : expiryTimestamp > sessionNow
        ? "Sesi aktif"
        : "Sesi tamat";

  const close = useCallback((restoreFocus = true): void => {
    setOpen(false);
    setError("");
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (demo || !Number.isFinite(expiryTimestamp)) return;
    let timeoutId: number | undefined;

    const updateAtExpiry = () => {
      const remaining = expiryTimestamp - Date.now();
      if (remaining <= 0) {
        setSessionNow(Date.now());
        return;
      }
      timeoutId = window.setTimeout(
        updateAtExpiry,
        Math.min(remaining + 1, 2_147_483_647),
      );
    };
    updateAtExpiry();

    return () => {
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    };
  }, [demo, expiryTimestamp]);

  useEffect(() => {
    if (!open) return;
    logoutRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      } else if (event.key === "Tab") {
        event.preventDefault();
        const controls = Array.from(
          document.querySelectorAll<HTMLElement>(pageFocusableSelector),
        ).filter((control) => !control.hidden && control.getAttribute("aria-hidden") !== "true");
        const triggerIndex = controls.indexOf(triggerRef.current!);
        const nextPageControl = controls
          .slice(triggerIndex + 1)
          .find((control) => !containerRef.current?.contains(control)) ??
          controls.find((control) => !containerRef.current?.contains(control));
        close(false);
        (event.shiftKey ? triggerRef.current : nextPageControl ?? triggerRef.current)?.focus();
      }
    };
    const handlePointerDown = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !containerRef.current?.contains(event.target)
      ) {
        close();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("pointerdown", handlePointerDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [close, open]);

  async function logout(): Promise<void> {
    if (submitting) return;
    setSubmitting(true);
    setError("");
    try {
      const response = await fetch("/api/v1/auth/logout", {
        credentials: "same-origin",
        method: "POST",
      });
      if (!response.ok) {
        setError(await errorMessage(response));
        return;
      }
      if (onLoggedOut) {
        onLoggedOut();
      } else {
        window.location.assign("/login");
      }
    } catch {
      setError("Log keluar tidak berjaya. Semak sambungan dan cuba lagi.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div ref={containerRef} className="crm-user-menu">
      <button
        ref={triggerRef}
        type="button"
        className="crm-user-menu__trigger"
        aria-label={`Menu pengguna ${displayName}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => {
          setOpen((current) => !current);
          setSessionNow(Date.now());
          setError("");
        }}
      >
        <span className="crm-topbar__avatar" aria-hidden="true">
          {initialsFor(displayName)}
        </span>
        <span className="crm-topbar__user-copy">
          <span className="crm-topbar__user-name">{displayName}</span>
        </span>
        <ChevronDown className="crm-user-menu__chevron" aria-hidden="true" />
      </button>

      {open ? (
        <div id={menuId} className="crm-user-menu__popover" role="menu" aria-label={`Akaun ${displayName}`}>
          <div className="crm-user-menu__identity" role="presentation">
            <strong>{displayName}</strong>
            <span>{sessionStatus}</span>
            {hasValidExpiry && sessionExpiresAt ? (
              <time dateTime={sessionExpiresAt}>Tamat {expiry}</time>
            ) : null}
          </div>
          {error ? <p className="crm-user-menu__error" role="alert">{error}</p> : null}
          <button
            ref={logoutRef}
            type="button"
            className="crm-user-menu__logout"
            role="menuitem"
            disabled={submitting}
            onClick={logout}
          >
            <LogOut aria-hidden="true" />
            {submitting ? "Sedang keluar" : "Log keluar"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

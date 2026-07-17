"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { cn } from "../ui/utils";
import {
  Sidebar,
  type SidebarBrand,
  type SidebarNavItem,
  type SidebarNavSection,
  type SidebarProps,
} from "./sidebar";
import { Topbar, type TopbarUser } from "./topbar";

export interface AppShellProps {
  children: ReactNode;
  navigation: SidebarNavSection[];
  title: ReactNode;
  activeHref?: string;
  brand?: SidebarBrand;
  workspace?: ReactNode;
  topbarActions?: ReactNode;
  user?: TopbarUser;
  sidebarFooter?: ReactNode;
  className?: string;
  contentClassName?: string;
  mainId?: string;
  skipLabel?: string;
  drawerLabel?: string;
  drawerOpen?: boolean;
  defaultDrawerOpen?: boolean;
  onDrawerOpenChange?: (open: boolean) => void;
  onNavigate?: SidebarProps["onNavigate"];
  routeKey?: string;
}

const focusableSelector = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(focusableSelector)).filter(
    (element) => !element.hidden && element.getAttribute("aria-hidden") !== "true",
  );
}

export function AppShell({
  activeHref,
  brand,
  children,
  className,
  contentClassName,
  defaultDrawerOpen = false,
  drawerLabel = "Navigasi utama",
  drawerOpen: controlledDrawerOpen,
  mainId = "crm-main-content",
  navigation,
  onDrawerOpenChange,
  onNavigate,
  routeKey,
  sidebarFooter,
  skipLabel = "Langkau ke kandungan",
  title,
  topbarActions,
  user,
  workspace,
}: AppShellProps) {
  const generatedId = useId().replace(/:/g, "");
  const drawerId = `crm-drawer-${generatedId}`;
  const drawerRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const previousRouteKeyRef = useRef(routeKey);
  const [internalDrawerOpen, setInternalDrawerOpen] = useState(defaultDrawerOpen);
  const drawerOpen = controlledDrawerOpen ?? internalDrawerOpen;

  const setDrawerOpen = useCallback(
    (next: boolean) => {
      if (controlledDrawerOpen === undefined) {
        setInternalDrawerOpen(next);
      }
      onDrawerOpenChange?.(next);
    },
    [controlledDrawerOpen, onDrawerOpenChange],
  );

  const closeDrawer = useCallback(
    (restoreFocus = true) => {
      setDrawerOpen(false);
      if (restoreFocus) {
        window.requestAnimationFrame(() => menuButtonRef.current?.focus());
      }
    },
    [setDrawerOpen],
  );

  const openDrawer = useCallback(() => {
    menuButtonRef.current?.blur();
    setDrawerOpen(true);
  }, [setDrawerOpen]);

  useEffect(() => {
    const previousRouteKey = previousRouteKeyRef.current;
    previousRouteKeyRef.current = routeKey;
    if (previousRouteKey !== routeKey && drawerOpen) {
      closeDrawer(false);
    }
  }, [closeDrawer, drawerOpen, routeKey]);

  useEffect(() => {
    if (!drawerOpen) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusFirstControl = () => {
      const currentDrawer = drawerRef.current;
      if (!currentDrawer) return;
      (focusableElements(currentDrawer)[0] ?? currentDrawer).focus();
    };
    window.requestAnimationFrame(focusFirstControl);

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeDrawer();
        return;
      }

      if (event.key !== "Tab" || !drawerRef.current) return;

      const controls = focusableElements(drawerRef.current);
      if (controls.length === 0) {
        event.preventDefault();
        drawerRef.current.focus();
        return;
      }

      const first = controls[0]!;
      const last = controls[controls.length - 1]!;
      const active = document.activeElement;

      if (!drawerRef.current.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    const handleFocusIn = (event: FocusEvent) => {
      const currentDrawer = drawerRef.current;
      if (
        currentDrawer &&
        event.target instanceof Node &&
        !currentDrawer.contains(event.target)
      ) {
        focusFirstControl();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("focusin", handleFocusIn);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("focusin", handleFocusIn);
    };
  }, [closeDrawer, drawerOpen]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const media = window.matchMedia("(min-width: 901px)");
    const handleDesktop = (event: MediaQueryListEvent | MediaQueryList) => {
      if (event.matches && drawerOpen) setDrawerOpen(false);
    };
    handleDesktop(media);
    media.addEventListener("change", handleDesktop);
    return () => media.removeEventListener("change", handleDesktop);
  }, [drawerOpen, setDrawerOpen]);

  const handleNavigate: SidebarProps["onNavigate"] = (item, event) => {
    onNavigate?.(item, event);
    closeDrawer(false);
  };

  const sidebarProps: SidebarProps = {
    ariaLabel: drawerLabel,
    sections: navigation,
    ...(activeHref !== undefined ? { activeHref } : {}),
    ...(brand !== undefined ? { brand } : {}),
    ...(sidebarFooter !== undefined ? { footer: sidebarFooter } : {}),
    ...(workspace !== undefined ? { workspace } : {}),
  };

  return (
    <div className={cn("crm-theme crm-shell", className)}>
      <a
        className="crm-skip-link"
        href={`#${mainId}`}
        inert={drawerOpen || undefined}
        aria-hidden={drawerOpen || undefined}
      >
        {skipLabel}
      </a>

      <div
        className="crm-shell__desktop-sidebar"
        inert={drawerOpen || undefined}
        aria-hidden={drawerOpen || undefined}
      >
        <Sidebar
          {...sidebarProps}
          {...(onNavigate !== undefined ? { onNavigate } : {})}
        />
      </div>

      {drawerOpen ? (
        <div className="crm-drawer">
          <button
            type="button"
            className="crm-drawer__backdrop"
            onClick={() => closeDrawer()}
            aria-label="Tutup menu navigasi"
          />
          <div
            ref={drawerRef}
            id={drawerId}
            className="crm-drawer__panel"
            role="dialog"
            aria-modal="true"
            aria-label={drawerLabel}
            tabIndex={-1}
          >
            <Sidebar
              {...sidebarProps}
              onClose={() => closeDrawer()}
              onNavigate={handleNavigate}
            />
          </div>
        </div>
      ) : null}

      <div
        className="crm-shell__workspace"
        inert={drawerOpen || undefined}
        aria-hidden={drawerOpen || undefined}
      >
        <Topbar
          title={title}
          onMenuClick={openDrawer}
          menuOpen={drawerOpen}
          menuControls={drawerId}
          menuButtonRef={menuButtonRef}
          {...(topbarActions !== undefined ? { actions: topbarActions } : {})}
          {...(user !== undefined ? { user } : {})}
        />
        <main id={mainId} className="crm-shell__main" tabIndex={-1}>
          <div className={cn("crm-shell__content", contentClassName)}>
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}

export type { SidebarNavItem };

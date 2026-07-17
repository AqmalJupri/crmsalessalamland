"use client";

import type {
  MouseEvent as ReactMouseEvent,
  ReactNode,
} from "react";
import { useId } from "react";
import { X, type LucideIcon } from "lucide-react";

import { cn } from "../ui/utils";

export interface SidebarBrand {
  name: string;
  meta?: string;
  mark?: ReactNode;
}

export interface SidebarNavItem {
  label: string;
  href: string;
  icon: LucideIcon;
  count?: number | string;
  active?: boolean;
  disabled?: boolean;
}

export interface SidebarNavSection {
  label?: string;
  items: SidebarNavItem[];
}

export interface SidebarProps {
  sections: SidebarNavSection[];
  activeHref?: string;
  brand?: SidebarBrand;
  workspace?: ReactNode;
  footer?: ReactNode;
  className?: string;
  ariaLabel?: string;
  onNavigate?: (
    item: SidebarNavItem,
    event: ReactMouseEvent<HTMLAnchorElement>,
  ) => void;
  onClose?: () => void;
}

export function Sidebar({
  activeHref,
  ariaLabel = "Navigasi utama",
  brand = { name: "Salam CRM", mark: "S" },
  className,
  footer,
  onClose,
  onNavigate,
  sections,
  workspace,
}: SidebarProps) {
  const navigationId = useId().replace(/:/g, "");

  return (
    <aside className={cn("crm-sidebar", className)} aria-label={ariaLabel}>
      <div className="crm-sidebar__header">
        <div className="crm-sidebar__brand">
          <span className="crm-sidebar__brand-mark" aria-hidden="true">
            {brand.mark ?? "S"}
          </span>
          <span className="crm-sidebar__brand-copy">
            <span className="crm-sidebar__brand-name">{brand.name}</span>
            {brand.meta ? (
              <span className="crm-sidebar__brand-meta">{brand.meta}</span>
            ) : null}
          </span>
        </div>

        {onClose ? (
          <button
            type="button"
            className="crm-icon-button"
            onClick={onClose}
            aria-label="Tutup menu navigasi"
            data-drawer-close
          >
            <X aria-hidden="true" />
          </button>
        ) : null}
      </div>

      {workspace ?? null}

      <div className="crm-sidebar__scroll">
        <nav aria-label={ariaLabel}>
          {sections.map((section, sectionIndex) => (
            <section
              key={section.label ?? `section-${sectionIndex}`}
              className="crm-sidebar__section"
              aria-labelledby={
                section.label
                  ? `crm-nav-${navigationId}-section-${sectionIndex}`
                  : undefined
              }
            >
              {section.label ? (
                <h2
                  id={`crm-nav-${navigationId}-section-${sectionIndex}`}
                  className="crm-sidebar__section-label"
                >
                  {section.label}
                </h2>
              ) : null}
              <ul className="crm-sidebar__nav-list">
                {section.items.map((item) => {
                  const Icon = item.icon;
                  const isActive = item.active ?? activeHref === item.href;

                  return (
                    <li key={`${item.href}-${item.label}`}>
                      <a
                        href={item.href}
                        className="crm-sidebar__nav-link"
                        aria-current={isActive ? "page" : undefined}
                        aria-disabled={item.disabled || undefined}
                        tabIndex={item.disabled ? -1 : undefined}
                        onClick={(event) => {
                          if (item.disabled) {
                            event.preventDefault();
                            return;
                          }
                          onNavigate?.(item, event);
                        }}
                      >
                        <Icon aria-hidden="true" />
                        <span className="crm-sidebar__nav-label">{item.label}</span>
                        {item.count !== undefined ? (
                          <span
                            className="crm-sidebar__nav-count"
                            aria-label={`${item.count} rekod`}
                          >
                            {item.count}
                          </span>
                        ) : null}
                      </a>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </nav>
      </div>

      {footer ? <div className="crm-sidebar__footer">{footer}</div> : null}
    </aside>
  );
}

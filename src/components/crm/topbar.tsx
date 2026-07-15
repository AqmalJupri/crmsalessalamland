"use client";

import {
  forwardRef,
  type HTMLAttributes,
  type ReactNode,
  type Ref,
} from "react";
import { Menu } from "lucide-react";

import { cn } from "../ui/utils";

export interface TopbarUser {
  name: string;
  role?: string;
  initials?: string;
}

export interface TopbarProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  title: ReactNode;
  eyebrow?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  user?: TopbarUser;
  onMenuClick?: () => void;
  menuOpen?: boolean;
  menuControls?: string;
  menuButtonRef?: Ref<HTMLButtonElement>;
}

function initialsFor(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}

export const Topbar = forwardRef<HTMLElement, TopbarProps>(
  (
    {
      actions,
      className,
      description,
      eyebrow,
      menuButtonRef,
      menuControls,
      menuOpen,
      onMenuClick,
      title,
      user,
      ...props
    },
    ref,
  ) => (
    <header ref={ref} className={cn("crm-topbar", className)} {...props}>
      {onMenuClick ? (
        <button
          ref={menuButtonRef}
          type="button"
          className="crm-icon-button crm-topbar__menu"
          onClick={onMenuClick}
          aria-label="Buka menu navigasi"
          aria-expanded={menuOpen}
          aria-controls={menuControls}
        >
          <Menu aria-hidden="true" />
        </button>
      ) : null}

      <div className="crm-topbar__copy">
        {eyebrow ? <p className="crm-topbar__eyebrow">{eyebrow}</p> : null}
        <h1 className="crm-topbar__title">{title}</h1>
        {description ? (
          <p className="crm-topbar__description">{description}</p>
        ) : null}
      </div>

      {actions || user ? (
        <div className="crm-topbar__actions">
          {actions}
          {user ? (
            <div
              className="crm-topbar__user"
              role="group"
              aria-label={`${user.name}${user.role ? `, ${user.role}` : ""}`}
            >
              <span className="crm-topbar__avatar" aria-hidden="true">
                {user.initials ?? initialsFor(user.name)}
              </span>
              <span className="crm-topbar__user-copy">
                <span className="crm-topbar__user-name">{user.name}</span>
                {user.role ? (
                  <span className="crm-topbar__user-role">{user.role}</span>
                ) : null}
              </span>
            </div>
          ) : null}
        </div>
      ) : null}
    </header>
  ),
);

Topbar.displayName = "Topbar";

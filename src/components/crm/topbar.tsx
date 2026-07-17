"use client";

import {
  forwardRef,
  type HTMLAttributes,
  type ReactNode,
  type Ref,
} from "react";
import { Menu } from "lucide-react";

import { cn } from "../ui/utils";
import { UserMenu } from "./user-menu";

export interface TopbarUser {
  name: string;
  sessionExpiresAt: string | null;
  demo?: boolean;
}

export interface TopbarProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  title: ReactNode;
  actions?: ReactNode;
  user?: TopbarUser;
  onMenuClick?: () => void;
  menuOpen?: boolean;
  menuControls?: string;
  menuButtonRef?: Ref<HTMLButtonElement>;
}

export const Topbar = forwardRef<HTMLElement, TopbarProps>(
  (
    {
      actions,
      className,
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
        <h1 className="crm-topbar__title">{title}</h1>
      </div>

      {actions || user ? (
        <div className="crm-topbar__actions">
          {actions}
          {user ? (
            <UserMenu
              displayName={user.name}
              sessionExpiresAt={user.sessionExpiresAt}
              {...(user.demo !== undefined ? { demo: user.demo } : {})}
            />
          ) : null}
        </div>
      ) : null}
    </header>
  ),
);

Topbar.displayName = "Topbar";

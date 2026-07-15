import type { HTMLAttributes, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

import { cn } from "./utils";

export type BadgeVariant = "neutral" | "success" | "danger" | "info";

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
  icon?: LucideIcon;
  children: ReactNode;
}

export function Badge({
  children,
  className,
  icon: Icon,
  variant = "neutral",
  ...props
}: BadgeProps) {
  return (
    <span
      className={cn("crm-badge", `crm-badge--${variant}`, className)}
      {...props}
    >
      {Icon ? <Icon aria-hidden="true" /> : null}
      {children}
    </span>
  );
}

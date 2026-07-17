import {
  forwardRef,
  type HTMLAttributes,
  type ReactNode,
  type TableHTMLAttributes,
  type TdHTMLAttributes,
  type ThHTMLAttributes,
} from "react";

import { cn } from "./utils";

export type TableResponsiveMode = "scroll" | "stack";

export interface TableProps extends TableHTMLAttributes<HTMLTableElement> {
  containerLabel: string;
  containerClassName?: string;
  responsive?: TableResponsiveMode;
}

export const Table = forwardRef<HTMLTableElement, TableProps>(
  (
    {
      children,
      className,
      containerLabel,
      containerClassName,
      responsive = "scroll",
      ...props
    },
    ref,
  ) => (
    <div
      className={cn("crm-table-region", containerClassName)}
      data-responsive={responsive}
      role="region"
      aria-label={containerLabel}
      tabIndex={0}
    >
      <table ref={ref} className={cn("crm-table", className)} {...props}>
        {children}
      </table>
    </div>
  ),
);
Table.displayName = "Table";

export const TableCaption = forwardRef<
  HTMLTableCaptionElement,
  HTMLAttributes<HTMLTableCaptionElement>
>(({ className, ...props }, ref) => (
  <caption
    ref={ref}
    className={cn("crm-table__caption crm-visually-hidden", className)}
    {...props}
  />
));
TableCaption.displayName = "TableCaption";

export const TableHeader = forwardRef<
  HTMLTableSectionElement,
  HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <thead
    ref={ref}
    className={cn("crm-table__head", className)}
    {...props}
  />
));
TableHeader.displayName = "TableHeader";

export const TableBody = forwardRef<
  HTMLTableSectionElement,
  HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <tbody
    ref={ref}
    className={cn("crm-table__body", className)}
    {...props}
  />
));
TableBody.displayName = "TableBody";

export const TableFooter = forwardRef<
  HTMLTableSectionElement,
  HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <tfoot
    ref={ref}
    className={cn("crm-table__footer", className)}
    {...props}
  />
));
TableFooter.displayName = "TableFooter";

export const TableRow = forwardRef<
  HTMLTableRowElement,
  HTMLAttributes<HTMLTableRowElement>
>(({ className, ...props }, ref) => (
  <tr ref={ref} className={cn("crm-table__row", className)} {...props} />
));
TableRow.displayName = "TableRow";

export type TableCellAlign = "left" | "center" | "right";

export interface TableHeadProps
  extends ThHTMLAttributes<HTMLTableCellElement> {
  align?: TableCellAlign;
}

export const TableHead = forwardRef<HTMLTableCellElement, TableHeadProps>(
  ({ align = "left", className, scope = "col", ...props }, ref) => (
    <th
      ref={ref}
      scope={scope}
      className={cn("crm-table__head-cell", className)}
      data-align={align}
      {...props}
    />
  ),
);
TableHead.displayName = "TableHead";

export interface TableCellProps
  extends TdHTMLAttributes<HTMLTableCellElement> {
  align?: TableCellAlign;
  label?: string;
}

export const TableCell = forwardRef<HTMLTableCellElement, TableCellProps>(
  ({ align = "left", className, label, ...props }, ref) => (
    <td
      ref={ref}
      className={cn("crm-table__cell", className)}
      data-align={align}
      data-label={label}
      {...props}
    />
  ),
);
TableCell.displayName = "TableCell";

export interface TableEmptyProps
  extends TdHTMLAttributes<HTMLTableCellElement> {
  children?: ReactNode;
}

export function TableEmpty({
  children = "Tiada rekod.",
  className,
  colSpan = 100,
  ...props
}: TableEmptyProps) {
  return (
    <TableRow>
      <td
        className={cn("crm-table__cell crm-table__empty", className)}
        colSpan={colSpan}
        {...props}
      >
        {children}
      </td>
    </TableRow>
  );
}

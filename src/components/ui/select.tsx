"use client";

import {
  forwardRef,
  useId,
  type ReactNode,
  type SelectHTMLAttributes,
} from "react";
import { ChevronDown } from "lucide-react";

import { cn } from "./utils";

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  placeholder?: string;
  containerClassName?: string;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  (
    {
      "aria-describedby": ariaDescribedBy,
      "aria-invalid": ariaInvalid,
      children,
      className,
      containerClassName,
      disabled,
      error,
      hint,
      id,
      label,
      placeholder,
      required,
      ...props
    },
    ref,
  ) => {
    const generatedId = useId();
    const selectId = id ?? `crm-select-${generatedId}`;
    const hintId = hint ? `${selectId}-hint` : undefined;
    const errorId = error ? `${selectId}-error` : undefined;
    const describedBy = [ariaDescribedBy, hintId, errorId]
      .filter(Boolean)
      .join(" ") || undefined;

    return (
      <div className={cn("crm-field-group", containerClassName)}>
        {label ? (
          <label className="crm-field-label" htmlFor={selectId}>
            {label}
            {required ? (
              <span className="crm-field-required" aria-hidden="true">
                {" "}*
              </span>
            ) : null}
          </label>
        ) : null}

        <div
          className="crm-field-control"
          data-invalid={error ? "true" : undefined}
          data-disabled={disabled ? "true" : undefined}
        >
          <select
            ref={ref}
            id={selectId}
            className={cn("crm-select", className)}
            disabled={disabled}
            required={required}
            aria-invalid={error ? true : ariaInvalid}
            aria-describedby={describedBy}
            {...props}
          >
            {placeholder ? (
              <option value="" disabled>
                {placeholder}
              </option>
            ) : null}
            {children}
          </select>
          <span className="crm-field-select-icon" aria-hidden="true">
            <ChevronDown />
          </span>
        </div>

        {hint ? (
          <span id={hintId} className="crm-field-hint">
            {hint}
          </span>
        ) : null}
        {error ? (
          <span id={errorId} className="crm-field-error" role="alert">
            {error}
          </span>
        ) : null}
      </div>
    );
  },
);

Select.displayName = "Select";

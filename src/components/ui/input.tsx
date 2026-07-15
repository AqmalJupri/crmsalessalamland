"use client";

import {
  forwardRef,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
} from "react";

import { cn } from "./utils";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  leadingIcon?: ReactNode;
  containerClassName?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  (
    {
      "aria-describedby": ariaDescribedBy,
      "aria-invalid": ariaInvalid,
      className,
      containerClassName,
      disabled,
      error,
      hint,
      id,
      label,
      leadingIcon,
      required,
      ...props
    },
    ref,
  ) => {
    const generatedId = useId();
    const inputId = id ?? `crm-input-${generatedId}`;
    const hintId = hint ? `${inputId}-hint` : undefined;
    const errorId = error ? `${inputId}-error` : undefined;
    const describedBy = [ariaDescribedBy, hintId, errorId]
      .filter(Boolean)
      .join(" ") || undefined;

    return (
      <div className={cn("crm-field-group", containerClassName)}>
        {label ? (
          <label className="crm-field-label" htmlFor={inputId}>
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
          {leadingIcon ? (
            <span className="crm-field-leading" aria-hidden="true">
              {leadingIcon}
            </span>
          ) : null}
          <input
            ref={ref}
            id={inputId}
            className={cn("crm-input", className)}
            disabled={disabled}
            required={required}
            aria-invalid={error ? true : ariaInvalid}
            aria-describedby={describedBy}
            data-has-leading={leadingIcon ? "true" : undefined}
            {...props}
          />
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

Input.displayName = "Input";

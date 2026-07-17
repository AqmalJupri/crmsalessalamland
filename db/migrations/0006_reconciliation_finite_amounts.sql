-- Reject PostgreSQL numeric special values from reconciliation evidence.

ALTER TABLE reconciliation_results
  ADD CONSTRAINT reconciliation_results_finite_amounts
  CHECK (
    (
      source_amount IS NULL
      OR source_amount::text NOT IN ('NaN', 'Infinity', '-Infinity')
    )
    AND (
      target_amount IS NULL
      OR target_amount::text NOT IN ('NaN', 'Infinity', '-Infinity')
    )
  ) NOT VALID;

ALTER TABLE reconciliation_results
  VALIDATE CONSTRAINT reconciliation_results_finite_amounts;

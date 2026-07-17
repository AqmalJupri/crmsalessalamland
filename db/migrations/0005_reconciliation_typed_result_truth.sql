-- Make typed reconciliation truth a database invariant, not only a service rule.

ALTER TABLE reconciliation_results
  ADD CONSTRAINT reconciliation_results_derived_pass_truth
  CHECK (
    CASE
      WHEN check_kind = 'COUNT' THEN
        passed IS NOT DISTINCT FROM (source_count = target_count)
      WHEN check_kind IN ('AMOUNT', 'FINANCE_BALANCE') THEN
        passed IS NOT DISTINCT FROM (source_amount = target_amount)
      WHEN check_kind = 'CHECKSUM' THEN
        passed IS NOT DISTINCT FROM (source_checksum = target_checksum)
      ELSE true
    END
  ) NOT VALID;

ALTER TABLE reconciliation_results
  VALIDATE CONSTRAINT reconciliation_results_derived_pass_truth;

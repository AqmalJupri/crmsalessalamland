-- Make reconciliation tuple ordering independent of the database's default locale.

CREATE OR REPLACE FUNCTION crm_validate_reconciliation_requirements()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  requirement jsonb;
  requirement_kind text;
  requirement_unit text;
  requirement_scale integer;
  requirement_scale_numeric numeric;
  canonical_requirements jsonb;
  requirement_count integer;
  distinct_requirement_count integer;
BEGIN
  IF jsonb_typeof(NEW.required_checks) <> 'array' THEN
    RAISE EXCEPTION 'reconciliation requirements must be a JSON array'
      USING ERRCODE = '23514';
  END IF;

  IF jsonb_array_length(NEW.required_checks) <> NEW.required_check_count THEN
    RAISE EXCEPTION 'reconciliation requirement count does not match the protected set'
      USING ERRCODE = '23514';
  END IF;

  IF digest(convert_to(NEW.required_checks::text, 'UTF8'), 'sha256') <> NEW.required_checks_sha256 THEN
    RAISE EXCEPTION 'reconciliation requirement digest does not match the protected set'
      USING ERRCODE = '23514';
  END IF;

  FOR requirement IN SELECT value FROM jsonb_array_elements(NEW.required_checks) LOOP
    IF
      jsonb_typeof(requirement) <> 'object'
      OR NOT (requirement ?& ARRAY[
        'check_kind', 'check_key', 'scope_key', 'measure_unit', 'decimal_scale'
      ])
      OR requirement - ARRAY[
        'check_kind', 'check_key', 'scope_key', 'measure_unit', 'decimal_scale'
      ] <> '{}'::jsonb
    THEN
      RAISE EXCEPTION 'reconciliation requirement tuples must use the exact canonical fields'
        USING ERRCODE = '23514';
    END IF;

    IF
      jsonb_typeof(requirement -> 'check_kind') <> 'string'
      OR jsonb_typeof(requirement -> 'check_key') <> 'string'
      OR jsonb_typeof(requirement -> 'scope_key') <> 'string'
      OR jsonb_typeof(requirement -> 'measure_unit') NOT IN ('string', 'null')
      OR jsonb_typeof(requirement -> 'decimal_scale') NOT IN ('number', 'null')
    THEN
      RAISE EXCEPTION 'reconciliation requirement identity scalars must use canonical string, number, or null types'
        USING ERRCODE = '23514';
    END IF;

    requirement_kind := requirement ->> 'check_kind';
    requirement_unit := requirement ->> 'measure_unit';

    IF requirement_kind NOT IN (
      'COUNT', 'AMOUNT', 'CHECKSUM', 'UNIQUENESS', 'REFERENCE', 'TIMELINE',
      'LOT_ALLOCATION', 'FINANCE_BALANCE', 'FILE', 'SAMPLE'
    ) THEN
      RAISE EXCEPTION 'reconciliation requirement has an invalid check kind'
        USING ERRCODE = '23514';
    END IF;

    IF
      char_length(requirement ->> 'check_key') NOT BETWEEN 1 AND 127
      OR (requirement ->> 'check_key') !~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'
      OR char_length(btrim(requirement ->> 'scope_key')) NOT BETWEEN 1 AND 255
      OR (requirement ->> 'scope_key') !~ '^[a-z][a-z0-9_.:-]*$'
    THEN
      RAISE EXCEPTION 'reconciliation requirement identity is invalid'
        USING ERRCODE = '23514';
    END IF;

    IF requirement_kind IN ('AMOUNT', 'FINANCE_BALANCE') THEN
      IF
        requirement_unit IS NULL
        OR char_length(btrim(requirement_unit)) NOT BETWEEN 1 AND 32
        OR jsonb_typeof(requirement -> 'decimal_scale') <> 'number'
      THEN
        RAISE EXCEPTION 'amount reconciliation requirements need a unit and decimal scale'
          USING ERRCODE = '23514';
      END IF;
      requirement_scale_numeric := (requirement ->> 'decimal_scale')::numeric;
      requirement_scale := requirement_scale_numeric::integer;
      IF
        requirement_scale_numeric <> trunc(requirement_scale_numeric)
        OR requirement_scale NOT BETWEEN 0 AND 12
      THEN
        RAISE EXCEPTION 'reconciliation decimal scale is out of range'
          USING ERRCODE = '23514';
      END IF;
    ELSIF requirement_unit IS NOT NULL OR jsonb_typeof(requirement -> 'decimal_scale') <> 'null' THEN
      RAISE EXCEPTION 'non-amount reconciliation requirements cannot declare a unit or scale'
        USING ERRCODE = '23514';
    END IF;
  END LOOP;

  SELECT count(*), count(DISTINCT jsonb_build_array(
           value ->> 'check_kind',
           value ->> 'check_key',
           value ->> 'scope_key',
           value ->> 'measure_unit',
           (value ->> 'decimal_scale')::numeric
         ))
    INTO requirement_count, distinct_requirement_count
    FROM jsonb_array_elements(NEW.required_checks);

  IF requirement_count <> distinct_requirement_count THEN
    RAISE EXCEPTION 'reconciliation requirements contain duplicate tuple identities'
      USING ERRCODE = '23514';
  END IF;

  SELECT jsonb_agg(value ORDER BY
           (value ->> 'check_kind') COLLATE "C",
           (value ->> 'check_key') COLLATE "C",
           (value ->> 'scope_key') COLLATE "C",
           (value ->> 'measure_unit') COLLATE "C" NULLS FIRST,
           (value ->> 'decimal_scale')::numeric NULLS FIRST
         )
    INTO canonical_requirements
    FROM jsonb_array_elements(NEW.required_checks);

  IF canonical_requirements IS DISTINCT FROM NEW.required_checks THEN
    RAISE EXCEPTION 'reconciliation requirements must be in canonical bytewise order'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

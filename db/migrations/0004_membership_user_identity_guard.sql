-- Keep membership identifiers permanently bound to the person they represent.

CREATE OR REPLACE FUNCTION crm_guard_membership_user_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'membership user identity is immutable; create a new membership instead'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER memberships_guard_user_identity
BEFORE UPDATE OF user_id ON memberships
FOR EACH ROW
EXECUTE FUNCTION crm_guard_membership_user_identity();

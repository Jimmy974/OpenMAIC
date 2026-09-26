-- Read-only preflight for scripts/reassign-owner.sql (decision D27).
-- Run BEFORE stopping the app, once per (from, to) pair:
--
--   psql "$DATABASE_URL" -v from_owner='anon:<uuid>' -v to_owner='acct_<32 hex>' \
--        -f scripts/reassign-owner-preflight.sql
--
-- Prints what would move and ends with "PREFLIGHT OK". Any collision or
-- owner_material row raises an error instead: do not start the cut-over.
\set ON_ERROR_STOP on
BEGIN TRANSACTION READ ONLY;
SELECT set_config('openmaic.from_owner', :'from_owner', true),
       set_config('openmaic.to_owner', :'to_owner', true);

SELECT 'stage_meta' AS table_name, count(*) AS rows_to_move FROM stage_meta WHERE owner_id = :'from_owner'
UNION ALL SELECT 'document_stages', count(*) FROM document_stages WHERE owner_id = :'from_owner'
UNION ALL SELECT 'document_folders', count(*) FROM document_folders WHERE owner_id = :'from_owner';

DO $$
DECLARE
  f text := current_setting('openmaic.from_owner');
  t text := current_setting('openmaic.to_owner');
  n bigint;
BEGIN
  IF f = '' OR t = '' OR f = t THEN
    RAISE EXCEPTION 'from_owner and to_owner must be non-empty and different';
  END IF;
  IF t !~ '^acct_[0-9a-f]{32}$' THEN
    RAISE EXCEPTION 'to_owner must be an account owner id (acct_ + 32 hex), got %', t;
  END IF;
  IF to_regclass('owner_material') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM owner_material WHERE owner_id = $1' INTO n USING f;
    IF n > 0 THEN
      RAISE EXCEPTION '% owner_material rows for %: moving them needs a byte migration (out of scope)', n, f;
    END IF;
  END IF;
  SELECT count(*) INTO n
    FROM document_folders a
    JOIN document_folders b
      ON b.owner_id = t AND (b.id = a.id OR b.normalized_name = a.normalized_name)
   WHERE a.owner_id = f;
  IF n > 0 THEN
    RAISE EXCEPTION '% folder id or name collisions between % and %', n, f, t;
  END IF;
  IF to_regclass('agent_user_skill') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM agent_user_skill a
               JOIN agent_user_skill b
                 ON b.owner_id = $2 AND b.name = a.name AND b.deleted_at IS NULL
              WHERE a.owner_id = $1 AND a.deleted_at IS NULL'
       INTO n USING f, t;
    IF n > 0 THEN
      RAISE EXCEPTION '% live skill name collisions between % and %', n, f, t;
    END IF;
  END IF;
  RAISE NOTICE 'PREFLIGHT OK: % -> %', f, t;
END $$;
ROLLBACK;

-- Move one owner's library to another owner, in one transaction (design §7).
-- Run with the app STOPPED (the agent runner must be idle), after pg_dump and
-- after scripts/reassign-owner-preflight.sql passed for the same pair:
--
--   psql "$DATABASE_URL" -v from_owner='anon:<uuid>' -v to_owner='acct_<32 hex>' \
--        -f scripts/reassign-owner.sql
--
-- Moves stage_meta, document_stages, document_folders, agent_sessions and
-- agent_user_skill. Leaves the live sidebar feed (agent_owner_session_events
-- and its counters) in place: old rows are never read again. Session history
-- is keyed by session id and follows the session. The same checks as the
-- preflight run inside the transaction and abort it on any problem.
\set ON_ERROR_STOP on
BEGIN;
SELECT set_config('openmaic.from_owner', :'from_owner', true),
       set_config('openmaic.to_owner', :'to_owner', true);

DO $$
DECLARE
  f text := current_setting('openmaic.from_owner');
  t text := current_setting('openmaic.to_owner');
  n bigint;
  moved bigint;
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

  UPDATE stage_meta SET owner_id = t WHERE owner_id = f;
  GET DIAGNOSTICS moved = ROW_COUNT;
  RAISE NOTICE 'stage_meta: % rows', moved;
  UPDATE document_stages SET owner_id = t WHERE owner_id = f;
  GET DIAGNOSTICS moved = ROW_COUNT;
  RAISE NOTICE 'document_stages: % rows', moved;
  UPDATE document_folders SET owner_id = t WHERE owner_id = f;
  GET DIAGNOSTICS moved = ROW_COUNT;
  RAISE NOTICE 'document_folders: % rows', moved;
  IF to_regclass('agent_sessions') IS NOT NULL THEN
    EXECUTE 'UPDATE agent_sessions SET owner_id = $2 WHERE owner_id = $1' USING f, t;
    GET DIAGNOSTICS moved = ROW_COUNT;
    RAISE NOTICE 'agent_sessions: % rows', moved;
  END IF;
  IF to_regclass('agent_user_skill') IS NOT NULL THEN
    EXECUTE 'UPDATE agent_user_skill SET owner_id = $2 WHERE owner_id = $1' USING f, t;
    GET DIAGNOSTICS moved = ROW_COUNT;
    RAISE NOTICE 'agent_user_skill: % rows', moved;
  END IF;
END $$;
COMMIT;

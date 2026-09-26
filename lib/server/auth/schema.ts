/**
 * Tables owned by signed-header sign-in. Created lazily, and only in sign-in
 * mode, so a deployment without it never sees them (the upstream schema is
 * untouched). Same `IF NOT EXISTS` pattern as `lib/persistence/stage-meta.ts`.
 */
import type { Queryable } from '@openmaic/storage/document/pg';

import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';

export const AUTH_SCHEMA = `
CREATE TABLE IF NOT EXISTS auth_members (
  owner_id TEXT PRIMARY KEY,
  login TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  avatar_url TEXT,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS course_shares (
  stage_id TEXT NOT NULL REFERENCES document_stages(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  recipient_owner_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (stage_id, recipient_owner_id)
);

CREATE INDEX IF NOT EXISTS course_shares_recipient_idx
  ON course_shares (recipient_owner_id, created_at DESC);

CREATE TABLE IF NOT EXISTS export_jobs (
  job_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  stage_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS service_classrooms (
  classroom_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

// Keyed on the pool, so a re-created provider (a new pool after a failed
// initialization, or a test's fresh database) ensures the tables again.
const ensured = new WeakMap<object, Promise<void>>();

async function applySchema(queryable: Pick<Queryable, 'query'>): Promise<void> {
  for (const sql of AUTH_SCHEMA.split(';')) {
    const statement = sql.trim();
    if (statement !== '') await queryable.query(statement);
  }
}

/**
 * Idempotent, and done once per pool; a failure is retried by the next
 * caller. Pass the pool, never a transaction: DDL inside a transaction that
 * later rolls back would leave the memo set with no tables.
 */
export function ensureAuthSchema(pool: Pick<Queryable, 'query'>): Promise<void> {
  let ready = ensured.get(pool);
  if (!ready) {
    ready = applySchema(pool).catch((error) => {
      ensured.delete(pool);
      throw error;
    });
    ensured.set(pool, ready);
  }
  return ready;
}

/** The persistence pool with the sign-in tables in place. */
export async function getAuthDb(): Promise<Queryable> {
  const { pool } = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
  const queryable = pool as unknown as Queryable;
  await ensureAuthSchema(queryable);
  return queryable;
}

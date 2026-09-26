/**
 * Signed-in members (design §5). A member row is written the first time a
 * login calls `GET /api/auth/me` and refreshed on each later call, so the
 * share picker and the Family page know who uses the site.
 */
import type { Queryable } from '@openmaic/storage/document/pg';

import type { SignedIdentity } from './signed-identity';

export interface MemberRow {
  ownerId: string;
  login: string;
  name: string;
  avatarUrl: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
}

interface RawMemberRow extends Record<string, unknown> {
  owner_id: string;
  login: string;
  display_name: string;
  avatar_url: string | null;
  first_seen_at: Date | string;
  last_seen_at: Date | string;
}

const iso = (value: Date | string) =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

function toMember(row: RawMemberRow): MemberRow {
  return {
    ownerId: row.owner_id,
    login: row.login,
    name: row.display_name,
    avatarUrl: row.avatar_url,
    firstSeenAt: iso(row.first_seen_at),
    lastSeenAt: iso(row.last_seen_at),
  };
}

/** Two logins hashing to one owner id: 128 bits, effectively never, but never aliased. */
export class MemberCollisionError extends Error {
  constructor(ownerId: string) {
    super(`owner id ${ownerId} already belongs to a different login`);
    this.name = 'MemberCollisionError';
  }
}

export async function upsertMember(
  db: Pick<Queryable, 'query'>,
  identity: Pick<SignedIdentity, 'ownerId' | 'login' | 'name' | 'avatarUrl'>,
): Promise<MemberRow> {
  const result = await db.query<RawMemberRow>(
    `INSERT INTO auth_members (owner_id, login, display_name, avatar_url)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (owner_id) DO UPDATE
        SET display_name = EXCLUDED.display_name,
            avatar_url = EXCLUDED.avatar_url,
            last_seen_at = now()
      WHERE auth_members.login = EXCLUDED.login
     RETURNING owner_id, login, display_name, avatar_url, first_seen_at, last_seen_at`,
    [identity.ownerId, identity.login, identity.name, identity.avatarUrl],
  );
  const row = result.rows[0];
  if (!row) throw new MemberCollisionError(identity.ownerId);
  return toMember(row);
}

export async function listMembers(db: Pick<Queryable, 'query'>): Promise<MemberRow[]> {
  const result = await db.query<RawMemberRow>(
    `SELECT owner_id, login, display_name, avatar_url, first_seen_at, last_seen_at
       FROM auth_members
      ORDER BY lower(display_name), login`,
  );
  return result.rows.map(toMember);
}

export async function findMemberByLogin(
  db: Pick<Queryable, 'query'>,
  login: string,
): Promise<MemberRow | null> {
  const result = await db.query<RawMemberRow>(
    `SELECT owner_id, login, display_name, avatar_url, first_seen_at, last_seen_at
       FROM auth_members
      WHERE login = $1`,
    [login],
  );
  return result.rows[0] ? toMember(result.rows[0]) : null;
}

export async function findMemberByOwnerId(
  db: Pick<Queryable, 'query'>,
  ownerId: string,
): Promise<MemberRow | null> {
  const result = await db.query<RawMemberRow>(
    `SELECT owner_id, login, display_name, avatar_url, first_seen_at, last_seen_at
       FROM auth_members
      WHERE owner_id = $1`,
    [ownerId],
  );
  return result.rows[0] ? toMember(result.rows[0]) : null;
}

export interface MemberCourseSummary {
  stageId: string;
  name: string;
  updatedAt: number;
  generationComplete: boolean;
}

/** A member's live courses, newest first. */
export async function listMemberCourses(
  db: Pick<Queryable, 'query'>,
  ownerId: string,
): Promise<MemberCourseSummary[]> {
  const result = await db.query<
    {
      stage_id: string;
      name: string;
      updated_at: number | string;
      generation_complete: boolean;
    } & Record<string, unknown>
  >(
    `SELECT m.stage_id, d.name, d.updated_at, m.generation_complete
       FROM stage_meta m
       JOIN document_stages d ON d.id = m.stage_id
      WHERE m.owner_id = $1 AND m.deleted_at IS NULL
      ORDER BY d.updated_at DESC`,
    [ownerId],
  );
  return result.rows.map((row) => ({
    stageId: row.stage_id,
    name: row.name,
    updatedAt: Number(row.updated_at),
    generationComplete: row.generation_complete === true,
  }));
}

/** Live course counts per owner. */
export async function courseCountsByOwner(
  db: Pick<Queryable, 'query'>,
): Promise<Map<string, number>> {
  const result = await db.query<
    { owner_id: string; count: number | string } & Record<string, unknown>
  >(
    `SELECT owner_id, count(*) AS count
       FROM stage_meta
      WHERE deleted_at IS NULL
      GROUP BY owner_id`,
  );
  return new Map(result.rows.map((row) => [row.owner_id, Number(row.count)]));
}

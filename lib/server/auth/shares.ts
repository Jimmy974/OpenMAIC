/**
 * Course sharing between signed-in members (design §5). Owners share a live
 * course with named members; a share is a read grant checked by
 * `canReadStage` (`./access.ts`). Tombstoned courses drop out of every list,
 * and their share rows grant nothing because every read path refuses a
 * tombstone first.
 */
import type { Queryable } from '@openmaic/storage/document/pg';

export interface ShareRecipient {
  login: string;
  name: string;
  avatarUrl: string | null;
  sharedAt: string;
}

export interface IncomingShare {
  stageId: string;
  name: string;
  ownerLogin: string | null;
  ownerName: string | null;
  sharedAt: string;
  updatedAt: number;
}

const iso = (value: Date | string) =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

/** Whether `ownerId` owns the live course `stageId`. */
export async function ownsLiveStage(
  db: Pick<Queryable, 'query'>,
  stageId: string,
  ownerId: string,
): Promise<boolean> {
  const result = await db.query<{ one: number } & Record<string, unknown>>(
    `SELECT 1 AS one FROM stage_meta
      WHERE stage_id = $1 AND owner_id = $2 AND deleted_at IS NULL`,
    [stageId, ownerId],
  );
  return result.rows.length > 0;
}

export async function listShareRecipients(
  db: Pick<Queryable, 'query'>,
  stageId: string,
): Promise<ShareRecipient[]> {
  const result = await db.query<
    {
      login: string;
      display_name: string;
      avatar_url: string | null;
      created_at: Date | string;
    } & Record<string, unknown>
  >(
    `SELECT a.login, a.display_name, a.avatar_url, s.created_at
       FROM course_shares s
       JOIN auth_members a ON a.owner_id = s.recipient_owner_id
      WHERE s.stage_id = $1
      ORDER BY s.created_at`,
    [stageId],
  );
  return result.rows.map((row) => ({
    login: row.login,
    name: row.display_name,
    avatarUrl: row.avatar_url,
    sharedAt: iso(row.created_at),
  }));
}

export async function addShare(
  db: Pick<Queryable, 'query'>,
  stageId: string,
  ownerId: string,
  recipientOwnerId: string,
): Promise<void> {
  await db.query(
    `INSERT INTO course_shares (stage_id, owner_id, recipient_owner_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (stage_id, recipient_owner_id) DO NOTHING`,
    [stageId, ownerId, recipientOwnerId],
  );
}

export async function removeShare(
  db: Pick<Queryable, 'query'>,
  stageId: string,
  recipientOwnerId: string,
): Promise<boolean> {
  const result = await db.query<{ stage_id: string } & Record<string, unknown>>(
    `DELETE FROM course_shares WHERE stage_id = $1 AND recipient_owner_id = $2
     RETURNING stage_id`,
    [stageId, recipientOwnerId],
  );
  return result.rows.length > 0;
}

/** Live courses shared with a member, newest share first. */
export async function listIncomingShares(
  db: Pick<Queryable, 'query'>,
  recipientOwnerId: string,
): Promise<IncomingShare[]> {
  const result = await db.query<
    {
      stage_id: string;
      name: string;
      updated_at: number | string;
      created_at: Date | string;
      owner_login: string | null;
      owner_name: string | null;
    } & Record<string, unknown>
  >(
    `SELECT s.stage_id, d.name, d.updated_at, s.created_at,
            a.login AS owner_login, a.display_name AS owner_name
       FROM course_shares s
       JOIN stage_meta m ON m.stage_id = s.stage_id
       JOIN document_stages d ON d.id = s.stage_id
       LEFT JOIN auth_members a ON a.owner_id = m.owner_id
      WHERE s.recipient_owner_id = $1
        AND m.deleted_at IS NULL
        AND m.owner_id <> $1
      ORDER BY s.created_at DESC`,
    [recipientOwnerId],
  );
  return result.rows.map((row) => ({
    stageId: row.stage_id,
    name: row.name,
    ownerLogin: row.owner_login,
    ownerName: row.owner_name,
    sharedAt: iso(row.created_at),
    updatedAt: Number(row.updated_at),
  }));
}

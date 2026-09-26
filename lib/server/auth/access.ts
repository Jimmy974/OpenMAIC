/**
 * Course read access under signed-header sign-in (design §4).
 *
 * A course is readable by its owner, by an admin (a parent), and by members
 * it is shared with. Every other reader gets the same answer as a missing
 * course. Outside sign-in mode none of this applies: reads stay
 * capability-by-id, exactly as upstream.
 */
import type { Queryable } from '@openmaic/storage/document/pg';

import { getAuthDb } from './schema';
import {
  isAuthModeEnabled,
  normalizeLogin,
  ownerIdForLogin,
  parseAdminLogins,
} from './signed-identity';

export interface StageReadInput {
  ownerId: string;
  viewerOwnerId: string;
  viewerIsAdmin: boolean;
  isSharedWithViewer: boolean;
}

export function canReadStage(input: StageReadInput): boolean {
  return input.ownerId === input.viewerOwnerId || input.viewerIsAdmin || input.isSharedWithViewer;
}

/** Owner ids of the configured admins; admin status needs no database. */
export function adminOwnerIds(): Set<string> {
  const ids = new Set<string>();
  for (const login of parseAdminLogins(process.env.AUTH_ADMIN_LOGINS)) {
    ids.add(ownerIdForLogin(login));
  }
  return ids;
}

export function isAdminOwnerId(ownerId: string): boolean {
  return adminOwnerIds().has(ownerId);
}

export function isAdminLogin(login: string): boolean {
  return parseAdminLogins(process.env.AUTH_ADMIN_LOGINS).has(normalizeLogin(login));
}

export async function isStageSharedWith(
  queryable: Pick<Queryable, 'query'>,
  stageId: string,
  recipientOwnerId: string,
): Promise<boolean> {
  const result = await queryable.query<{ one: number } & Record<string, unknown>>(
    'SELECT 1 AS one FROM course_shares WHERE stage_id = $1 AND recipient_owner_id = $2',
    [stageId, recipientOwnerId],
  );
  return result.rows.length > 0;
}

/**
 * Decide a read of a course owned by someone other than the viewer. The
 * caller has made sure the sign-in tables exist (see {@link getAuthDb}).
 */
export async function canViewerReadForeignStage(
  queryable: Pick<Queryable, 'query'>,
  stageId: string,
  stageOwnerId: string,
  viewerOwnerId: string,
): Promise<boolean> {
  if (stageOwnerId === viewerOwnerId || isAdminOwnerId(viewerOwnerId)) return true;
  return canReadStage({
    ownerId: stageOwnerId,
    viewerOwnerId,
    viewerIsAdmin: false,
    isSharedWithViewer: await isStageSharedWith(queryable, stageId, viewerOwnerId),
  });
}

export type ForeignReadCheck = (
  queryable: Queryable,
  stageId: string,
  stageOwnerId: string,
) => Promise<boolean>;

/**
 * The foreign-read gate for a store bound to `viewerOwnerId`, or undefined
 * outside sign-in mode (upstream capability-by-id reads).
 */
export function foreignReadCheckFor(viewerOwnerId: string): ForeignReadCheck | undefined {
  if (!isAuthModeEnabled()) return undefined;
  return async (queryable, stageId, stageOwnerId) => {
    if (isAdminOwnerId(viewerOwnerId)) return true;
    // Schema on the pool, never inside the caller's read transaction: DDL
    // there would roll back with it while the once-per-process memo stayed set.
    await getAuthDb();
    return canViewerReadForeignStage(queryable, stageId, stageOwnerId, viewerOwnerId);
  };
}

/**
 * Route-level form of the read gate, for routes that resolve a course's owner
 * themselves (stage-meta, status): true outside sign-in mode.
 */
export async function viewerMayReadStage(
  stageId: string,
  stageOwnerId: string,
  viewerOwnerId: string,
): Promise<boolean> {
  if (!isAuthModeEnabled()) return true;
  if (stageOwnerId === viewerOwnerId || isAdminOwnerId(viewerOwnerId)) return true;
  return canViewerReadForeignStage(await getAuthDb(), stageId, stageOwnerId, viewerOwnerId);
}

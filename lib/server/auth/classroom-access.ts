/**
 * The skill API and file-based classrooms under signed-header sign-in
 * (design §4, decision D18).
 *
 * Callers are either a signed-in member or the external skill client, which
 * has no Tailscale identity and authenticates with
 * `Authorization: Bearer <AUTH_SERVICE_TOKEN>`.
 *
 * - Creating (generate-classroom, POST /api/classroom) and polling jobs:
 *   admins and the service token.
 * - Reading `/api/classroom?id=` and `/api/classroom-media/<id>/…`: the path
 *   id is either a persistence course (the agent runtime stores generated
 *   media under the course id), which follows the normal course read gate, or
 *   a file classroom, readable by admins, the token, and the member it is
 *   attributed to: the recorded creator, else `AUTH_SERVICE_OWNER_LOGIN`.
 *
 * Missing or wrong credentials are 401; a caller who is not allowed gets 404.
 */
import { createHash, timingSafeEqual } from 'node:crypto';

import type { Queryable } from '@openmaic/storage/document/pg';

import { viewerMayReadStage } from './access';
import { authNotFoundResponse, authRequiredResponse } from './responses';
import { getAuthDb } from './schema';
import {
  isAuthModeEnabled,
  MIN_SECRET_BYTES,
  ownerIdForLogin,
  readRequestIdentity,
  type SignedIdentity,
} from './signed-identity';

export type ClassroomCaller = { kind: 'service' } | { kind: 'member'; identity: SignedIdentity };

function serviceToken(): string | undefined {
  const token = process.env.AUTH_SERVICE_TOKEN ?? '';
  return Buffer.byteLength(token, 'utf8') >= MIN_SECRET_BYTES ? token : undefined;
}

function sameSecret(left: string, right: string): boolean {
  const a = createHash('sha256').update(left).digest();
  const b = createHash('sha256').update(right).digest();
  return timingSafeEqual(a, b);
}

/** Whether the request carries the configured service token. */
export function hasServiceToken(req: Pick<Request, 'headers'>): boolean {
  const token = serviceToken();
  const authorization = req.headers.get('authorization');
  return (
    token !== undefined && authorization !== null && sameSecret(authorization, `Bearer ${token}`)
  );
}

/** The owner id file classrooms made with the token are attributed to. */
export function serviceOwnerId(): string | undefined {
  const login = process.env.AUTH_SERVICE_OWNER_LOGIN?.trim();
  return login ? ownerIdForLogin(login) : undefined;
}

/** The caller, or the 401 to return. Only meaningful in sign-in mode. */
export function classroomCallerOr401(req: Pick<Request, 'headers'>): ClassroomCaller | Response {
  if (hasServiceToken(req)) return { kind: 'service' };
  const identity = readRequestIdentity(req.headers);
  return identity ? { kind: 'member', identity } : authRequiredResponse();
}

/**
 * Gate for creating classrooms and polling generation jobs: admins and the
 * token. Null means allowed (and always outside sign-in mode).
 */
export function skillApiWriteGate(req: Pick<Request, 'headers'>): Response | null {
  if (!isAuthModeEnabled()) return null;
  const caller = classroomCallerOr401(req);
  if (caller instanceof Response) return caller;
  if (caller.kind === 'service' || caller.identity.isAdmin) return null;
  return authNotFoundResponse();
}

/** The owner a classroom created by this caller is attributed to. */
export function classroomCreatorOwnerId(caller: ClassroomCaller): string | undefined {
  return caller.kind === 'service' ? serviceOwnerId() : caller.identity.ownerId;
}

export async function recordServiceClassroom(classroomId: string, ownerId: string): Promise<void> {
  const db = await getAuthDb();
  await db.query(
    `INSERT INTO service_classrooms (classroom_id, owner_id) VALUES ($1, $2)
     ON CONFLICT (classroom_id) DO NOTHING`,
    [classroomId, ownerId],
  );
}

async function stageOwner(
  db: Pick<Queryable, 'query'>,
  stageId: string,
): Promise<{ ownerId: string; deleted: boolean } | null> {
  const result = await db.query<
    { owner_id: string; deleted_at: unknown } & Record<string, unknown>
  >('SELECT owner_id, deleted_at FROM stage_meta WHERE stage_id = $1', [stageId]);
  const row = result.rows[0];
  return row ? { ownerId: row.owner_id, deleted: row.deleted_at !== null } : null;
}

async function attributedOwner(db: Pick<Queryable, 'query'>, classroomId: string) {
  const result = await db.query<{ owner_id: string } & Record<string, unknown>>(
    'SELECT owner_id FROM service_classrooms WHERE classroom_id = $1',
    [classroomId],
  );
  return result.rows[0]?.owner_id ?? serviceOwnerId();
}

/**
 * Gate for reading a classroom or its media. Null means allowed (and always
 * outside sign-in mode); otherwise the 401/404 to return.
 */
export async function classroomReadGate(
  req: Pick<Request, 'headers'>,
  classroomId: string,
): Promise<Response | null> {
  if (!isAuthModeEnabled()) return null;
  const caller = classroomCallerOr401(req);
  if (caller instanceof Response) return caller;
  if (caller.kind === 'service' || caller.identity.isAdmin) return null;

  const db = await getAuthDb();
  const owner = await stageOwner(db, classroomId);
  if (owner) {
    if (owner.deleted) return authNotFoundResponse();
    return (await viewerMayReadStage(classroomId, owner.ownerId, caller.identity.ownerId))
      ? null
      : authNotFoundResponse();
  }
  return (await attributedOwner(db, classroomId)) === caller.identity.ownerId
    ? null
    : authNotFoundResponse();
}

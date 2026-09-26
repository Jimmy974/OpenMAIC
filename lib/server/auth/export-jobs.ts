/**
 * Server-rendered video exports under signed-header sign-in (decision D24).
 *
 * The render service knows nothing about members: anyone holding a job id
 * could poll, download or cancel it. With sign-in on, the submit route
 * records which member started each job, and status, download and cancel
 * are allowed only for that member or an admin; anyone else gets 404. A
 * member keeps their own exports even after a course share is removed.
 */
import { authNotFoundResponse, identityOr401 } from './responses';
import { getAuthDb } from './schema';
import { isAuthModeEnabled, type SignedIdentity } from './signed-identity';

/** The member allowed to start a render, or the 401 to return; null outside sign-in mode. */
export function exportSubmitter(req: Pick<Request, 'headers'>): SignedIdentity | Response | null {
  if (!isAuthModeEnabled()) return null;
  return identityOr401(req);
}

export async function recordExportJob(
  jobId: string,
  ownerId: string,
  stageId: string | null,
): Promise<void> {
  const db = await getAuthDb();
  await db.query(
    `INSERT INTO export_jobs (job_id, owner_id, stage_id) VALUES ($1, $2, $3)
     ON CONFLICT (job_id) DO NOTHING`,
    [jobId, ownerId, stageId],
  );
}

/** Null when the caller may use this job (and always outside sign-in mode). */
export async function exportJobGate(
  req: Pick<Request, 'headers'>,
  jobId: string,
): Promise<Response | null> {
  if (!isAuthModeEnabled()) return null;
  const identity = identityOr401(req);
  if (identity instanceof Response) return identity;
  if (identity.isAdmin) return null;
  const db = await getAuthDb();
  const result = await db.query<{ owner_id: string } & Record<string, unknown>>(
    'SELECT owner_id FROM export_jobs WHERE job_id = $1',
    [jobId],
  );
  return result.rows[0]?.owner_id === identity.ownerId ? null : authNotFoundResponse();
}

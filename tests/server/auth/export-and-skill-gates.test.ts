/**
 * Video export jobs (D24) and the skill API / file classrooms (D18) under
 * signed-header sign-in, over PGlite.
 */
import { randomUUID } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import { createOwnerBoundDocumentStore } from '@/lib/persistence/owner-bound-document-store';
import { ownerIdForLogin, signedIdentityHeaders } from '@/lib/server/auth/signed-identity';

const SECRET = 'gates-test-secret-0123456789abcdef0123456789ab';
const TOKEN = 'service-token-0123456789abcdef0123456789abcdef';
const PARENT = 'parent@example.com';
const STUDENT = 'student@example.com';
const THIRD = 'third@example.com';

class PGlitePool {
  constructor(readonly db: PGlite) {}
  query(text: string, params?: unknown[]) {
    return this.db.query(text, params);
  }
  async connect() {
    return {
      query: (text: string, params?: unknown[]) => this.db.query(text, params),
      release() {},
    };
  }
  async end() {
    await this.db.close();
  }
}

const as = (login: string | null, extra: Record<string, string> = {}) =>
  new Request('http://localhost/x', {
    headers: { ...(login ? signedIdentityHeaders({ login }, SECRET) : {}), ...extra },
  });

describe('export jobs and skill API gates', () => {
  let pool: PGlitePool;

  beforeEach(async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('DATABASE_URL', `postgres://auth-gates-${randomUUID()}`);
    vi.stubEnv('ASSET_S3_BUCKET', '');
    vi.stubEnv('AUTH_MODE', 'signed-header');
    vi.stubEnv('AUTH_IDENTITY_SECRET', SECRET);
    vi.stubEnv('AUTH_ADMIN_LOGINS', PARENT);
    vi.stubEnv('AUTH_SERVICE_TOKEN', TOKEN);
    vi.stubEnv('AUTH_SERVICE_OWNER_LOGIN', STUDENT);
    const db = new PGlite();
    await db.waitReady;
    pool = new PGlitePool(db);
    const { getServerPersistenceProvider } = await import('@/lib/persistence/server-provider');
    await getServerPersistenceProvider(process.env.DATABASE_URL!, () => pool as never);
  });

  afterEach(async () => {
    await pool.end();
    vi.unstubAllEnvs();
  });

  it('limits a render job to the member who started it and admins', async () => {
    const { exportJobGate, exportSubmitter, recordExportJob } =
      await import('@/lib/server/auth/export-jobs');
    expect((exportSubmitter(as(null)) as Response).status).toBe(401);
    const submitter = exportSubmitter(as(STUDENT));
    expect(submitter).toMatchObject({ ownerId: ownerIdForLogin(STUDENT) });

    await recordExportJob('job-1', ownerIdForLogin(STUDENT), null);
    expect(await exportJobGate(as(STUDENT), 'job-1')).toBeNull();
    expect(await exportJobGate(as(PARENT), 'job-1')).toBeNull();
    expect((await exportJobGate(as(THIRD), 'job-1'))?.status).toBe(404);
    expect((await exportJobGate(as(STUDENT), 'job-unknown'))?.status).toBe(404);
    expect((await exportJobGate(as(null), 'job-1'))?.status).toBe(401);

    vi.stubEnv('AUTH_MODE', '');
    expect(exportSubmitter(as(null))).toBeNull();
    expect(await exportJobGate(as(null), 'job-1')).toBeNull();
  });

  it('lets admins and the token create and poll, and nobody else', async () => {
    const { skillApiWriteGate } = await import('@/lib/server/auth/classroom-access');
    expect(skillApiWriteGate(as(PARENT))).toBeNull();
    expect(skillApiWriteGate(as(null, { authorization: `Bearer ${TOKEN}` }))).toBeNull();
    expect(skillApiWriteGate(as(STUDENT))?.status).toBe(404);
    expect(skillApiWriteGate(as(null))?.status).toBe(401);
    expect(skillApiWriteGate(as(null, { authorization: 'Bearer wrong-token' }))?.status).toBe(401);
    expect(skillApiWriteGate(as(null, { authorization: TOKEN }))?.status).toBe(401);

    const { POST } = await import('@/app/api/generate-classroom/route');
    const refused = await POST(
      new (await import('next/server')).NextRequest('http://localhost/api/generate-classroom', {
        method: 'POST',
        headers: {
          ...signedIdentityHeaders({ login: THIRD }, SECRET),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ requirement: 'x' }),
      }),
    );
    expect(refused.status).toBe(404);
  });

  it('gates classroom reads by course access or attribution', async () => {
    const { classroomReadGate, recordServiceClassroom } =
      await import('@/lib/server/auth/classroom-access');
    // A persistence course (agent media lives under its id).
    await createOwnerBoundDocumentStore({
      pool,
      ownerId: ownerIdForLogin(THIRD),
      validateScene: validateAppScene,
      validateStage: validateAppStage,
    }).saveDocument({
      stage: { id: 'stage-third', name: 'Third', createdAt: 1, updatedAt: 1 },
      scenes: [],
      outline: {
        outlines: [],
        requirement: 'x',
        generationComplete: false,
        createdAt: 1,
        updatedAt: 1,
      },
    });
    expect(await classroomReadGate(as(THIRD), 'stage-third')).toBeNull();
    expect(await classroomReadGate(as(PARENT), 'stage-third')).toBeNull();
    expect((await classroomReadGate(as(STUDENT), 'stage-third'))?.status).toBe(404);

    // File classrooms: attributed creator, else the service owner (STUDENT here).
    await recordServiceClassroom('file-by-third', ownerIdForLogin(THIRD));
    expect(await classroomReadGate(as(THIRD), 'file-by-third')).toBeNull();
    expect((await classroomReadGate(as(STUDENT), 'file-by-third'))?.status).toBe(404);
    expect(await classroomReadGate(as(STUDENT), 'file-unrecorded')).toBeNull();
    expect((await classroomReadGate(as(THIRD), 'file-unrecorded'))?.status).toBe(404);
    expect(
      await classroomReadGate(as(null, { authorization: `Bearer ${TOKEN}` }), 'file-by-third'),
    ).toBeNull();
    expect((await classroomReadGate(as(null), 'file-by-third'))?.status).toBe(401);

    vi.stubEnv('AUTH_MODE', '');
    expect(await classroomReadGate(as(null), 'file-by-third')).toBeNull();
  });
});

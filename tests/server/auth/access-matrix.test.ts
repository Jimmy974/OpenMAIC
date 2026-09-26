/**
 * Signed-header sign-in, end to end through the real routes over PGlite:
 * owner resolution, the course read gate on every read path (design §4,
 * amendments R2-4/R2-10), the runtime principal and merge rule (§6).
 */
import { randomUUID } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import { createOwnerBoundDocumentStore } from '@/lib/persistence/owner-bound-document-store';
import { ownerIdForLogin, signedIdentityHeaders } from '@/lib/server/auth/signed-identity';

const SECRET = 'matrix-test-secret-0123456789abcdef0123456789';
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

function courseDocument(id: string, name = 'Course') {
  const now = 1_800_000_000_000;
  return {
    stage: { id, name, createdAt: now, updatedAt: now },
    scenes: [],
    outline: {
      outlines: [],
      requirement: name,
      generationComplete: false,
      createdAt: now,
      updatedAt: now,
    },
  };
}

function as(login: string | null, extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...(login ? signedIdentityHeaders({ login, name: login.split('@')[0] }, SECRET) : {}),
    ...extra,
  };
}

function req(
  url: string,
  login: string | null,
  init: RequestInit & { extra?: Record<string, string> } = {},
) {
  return new NextRequest(`http://localhost${url}`, {
    ...init,
    headers: as(login, {
      ...(init.extra ?? {}),
      ...((init.headers as Record<string, string>) ?? {}),
    }),
  } as ConstructorParameters<typeof NextRequest>[1]);
}

const params = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) });

describe('signed-header sign-in access matrix', () => {
  let pool: PGlitePool;
  const parentStage = 'stage-parent-course';
  const studentStage = 'stage-student-course';

  beforeEach(async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('DATABASE_URL', `postgres://auth-matrix-${randomUUID()}`);
    vi.stubEnv('PERSISTENCE_DEV_TOKEN', '');
    vi.stubEnv('ASSET_S3_BUCKET', '');
    vi.stubEnv('OPENMAIC_AGENT_RUNTIME_ENABLED', 'true');
    vi.stubEnv('AUTH_MODE', 'signed-header');
    vi.stubEnv('AUTH_IDENTITY_SECRET', SECRET);
    vi.stubEnv('AUTH_ADMIN_LOGINS', PARENT);
    const db = new PGlite();
    await db.waitReady;
    pool = new PGlitePool(db);
    const { getServerPersistenceProvider } = await import('@/lib/persistence/server-provider');
    await getServerPersistenceProvider(process.env.DATABASE_URL!, () => pool as never);
    const store = (ownerId: string) =>
      createOwnerBoundDocumentStore({
        pool,
        ownerId,
        validateScene: validateAppScene,
        validateStage: validateAppStage,
      });
    await store(ownerIdForLogin(PARENT)).saveDocument(courseDocument(parentStage, 'Physics'));
    await store(ownerIdForLogin(STUDENT)).saveDocument(courseDocument(studentStage, 'Biology'));
  });

  afterEach(async () => {
    await pool.end();
    vi.unstubAllEnvs();
  });

  async function share(stageId: string, ownerLogin: string, recipientLogin: string) {
    const { getAuthDb } = await import('@/lib/server/auth/schema');
    const db = await getAuthDb();
    await db.query(
      'INSERT INTO course_shares (stage_id, owner_id, recipient_owner_id) VALUES ($1, $2, $3)',
      [stageId, ownerIdForLogin(ownerLogin), ownerIdForLogin(recipientLogin)],
    );
  }

  async function readStatuses(stageId: string, login: string | null) {
    const { handlePersistenceRequest } = await import('@/app/api/persistence/[...path]/route');
    const stageRoute = await import('@/app/api/stages/[id]/route');
    const metaRoute = await import('@/app/api/stage-meta/[stageId]/route');
    const statusRoute = await import('@/app/api/stages/[id]/status/route');
    const manifestRoute = await import('@/app/api/stages/[id]/manifest/route');
    const freshnessRoute = await import('@/app/api/stages/[id]/freshness/route');
    const persistence = await handlePersistenceRequest(
      new Request(`http://localhost/api/persistence/documents/${stageId}`, { headers: as(login) }),
    );
    const stage = await stageRoute.GET(
      req(`/api/stages/${stageId}`, login),
      params({ id: stageId }),
    );
    const meta = await metaRoute.GET(req(`/api/stage-meta/${stageId}`, login), params({ stageId }));
    const status = await statusRoute.GET(
      req(`/api/stages/${stageId}/status`, login),
      params({ id: stageId }),
    );
    const manifest = await manifestRoute.GET(
      req(`/api/stages/${stageId}/manifest`, login),
      params({ id: stageId }),
    );
    const freshness = await freshnessRoute.GET(
      req(`/api/stages/${stageId}/freshness`, login),
      params({ id: stageId }),
    );
    await freshness.body?.cancel();
    return {
      persistence: persistence.status,
      stage: stage.status,
      meta: meta.status,
      status: status.status,
      manifest: manifest.status,
      freshness: freshness.status,
    };
  }

  const all = (code: number) => ({
    persistence: code,
    stage: code,
    meta: code,
    status: code,
    manifest: code,
    freshness: code,
  });

  it('lets the owner read everything and refuses an unshared member with 404 everywhere', async () => {
    expect(await readStatuses(parentStage, PARENT)).toEqual(all(200));
    expect(await readStatuses(parentStage, STUDENT)).toEqual(all(404));
    expect(await readStatuses(parentStage, THIRD)).toEqual(all(404));
    expect(await readStatuses(studentStage, THIRD)).toEqual(all(404));
  });

  it('answers 401 without an identity, with a forged one, and with forged Tailscale headers', async () => {
    expect(await readStatuses(parentStage, null)).toEqual(all(401));

    const { handlePersistenceRequest } = await import('@/app/api/persistence/[...path]/route');
    const forged = signedIdentityHeaders(
      { login: PARENT },
      'a-different-secret-that-is-long-enough',
    );
    const forgedRead = await handlePersistenceRequest(
      new Request(`http://localhost/api/persistence/documents/${parentStage}`, { headers: forged }),
    );
    expect(forgedRead.status).toBe(401);
    await expect(forgedRead.json()).resolves.toMatchObject({ errorCode: 'AUTH_REQUIRED' });

    const tailscaleForged = await handlePersistenceRequest(
      new Request(`http://localhost/api/persistence/documents/${parentStage}`, {
        headers: { 'tailscale-user-login': PARENT, 'x-openmaic-identity-login': PARENT },
      }),
    );
    expect(tailscaleForged.status).toBe(401);
  });

  it('lets an admin read a member course, with isOwner false', async () => {
    const statuses = await readStatuses(studentStage, PARENT);
    // The manifest and freshness stream stay owner-only at the SQL level.
    expect(statuses).toEqual({ ...all(200), manifest: 404, freshness: 404 });
    const metaRoute = await import('@/app/api/stage-meta/[stageId]/route');
    const meta = await metaRoute.GET(
      req(`/api/stage-meta/${studentStage}`, PARENT),
      params({ stageId: studentStage }),
    );
    await expect(meta.json()).resolves.toMatchObject({ isOwner: false });
  });

  it('opens a shared course to its recipient only, and closes it after unsharing', async () => {
    await share(parentStage, PARENT, STUDENT);
    expect(await readStatuses(parentStage, STUDENT)).toEqual({
      ...all(200),
      manifest: 404,
      freshness: 404,
    });
    expect(await readStatuses(parentStage, THIRD)).toEqual(all(404));

    const { getAuthDb } = await import('@/lib/server/auth/schema');
    await (await getAuthDb()).query('DELETE FROM course_shares WHERE stage_id = $1', [parentStage]);
    expect(await readStatuses(parentStage, STUDENT)).toEqual(all(404));
  });

  it('refuses writes by a recipient and hides a tombstoned shared course', async () => {
    await share(parentStage, PARENT, STUDENT);
    const stageRoute = await import('@/app/api/stages/[id]/route');
    const rename = await stageRoute.PATCH(
      req(`/api/stages/${parentStage}`, STUDENT, {
        method: 'PATCH',
        body: JSON.stringify({ name: 'Hijacked' }),
        extra: { 'content-type': 'application/json' },
      }),
      params({ id: parentStage }),
    );
    expect(rename.status).toBeGreaterThanOrEqual(400);

    const del = await stageRoute.DELETE(
      req(`/api/stages/${parentStage}`, PARENT, { method: 'DELETE' }),
      params({ id: parentStage }),
    );
    expect(del.status).toBeLessThan(300);
    expect((await readStatuses(parentStage, STUDENT)).persistence).toBe(404);
  });

  it('disables publish and unpublish', async () => {
    const publish = await import('@/app/api/stages/[id]/publish/route');
    const unpublish = await import('@/app/api/stages/[id]/unpublish/route');
    expect(
      (
        await publish.POST(
          req(`/api/stages/${parentStage}/publish`, PARENT, { method: 'POST' }),
          params({ id: parentStage }),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await unpublish.POST(
          req(`/api/stages/${parentStage}/unpublish`, PARENT, { method: 'POST' }),
          params({ id: parentStage }),
        )
      ).status,
    ).toBe(404);
  });

  it('binds the runtime partition to the account and merges only anon keys into it', async () => {
    const { handlePersistenceRequest } = await import('@/app/api/persistence/[...path]/route');
    const student = ownerIdForLogin(STUDENT);
    const own = await handlePersistenceRequest(
      new Request(
        `http://localhost/api/persistence/runtime/stages/${studentStage}/learners/${student}/sessions`,
        { headers: as(STUDENT, { 'x-learner-key': 'anon:spoofed' }) },
      ),
    );
    expect(own.status).toBe(200);

    const foreign = await handlePersistenceRequest(
      new Request(
        `http://localhost/api/persistence/runtime/stages/${studentStage}/learners/${ownerIdForLogin(THIRD)}/sessions`,
        { headers: as(STUDENT, { 'x-learner-key': ownerIdForLogin(THIRD) }) },
      ),
    );
    expect(foreign.status).toBe(403);

    const merge = (from: string, to: string) =>
      handlePersistenceRequest(
        new Request('http://localhost/api/persistence/runtime/learners/merge', {
          method: 'POST',
          headers: as(STUDENT, { 'content-type': 'application/json' }),
          body: JSON.stringify({ fromLearnerKey: from, toLearnerKey: to }),
        }),
      );
    const anon = `anon:${randomUUID()}`;
    const ok = await merge(anon, student);
    expect(ok.status).toBe(200);
    await expect(ok.json()).resolves.toEqual({ moved: 0 });
    expect((await merge(anon, ownerIdForLogin(THIRD))).status).toBe(403);
    expect((await merge(ownerIdForLogin(THIRD), student)).status).toBe(403);
  });
});

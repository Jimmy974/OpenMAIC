import { randomUUID } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ownerIdForLogin } from '@/lib/server/auth/signed-identity';

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

const PARENT = 'parent@example.com';
const KID = 'kid@example.com';

describe('classroom API results in a member library', () => {
  let pool: PGlitePool;

  beforeEach(async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('DATABASE_URL', `postgres://library-${randomUUID()}`);
    vi.stubEnv('ASSET_S3_BUCKET', '');
    vi.stubEnv('AUTH_MODE', 'signed-header');
    vi.stubEnv('AUTH_IDENTITY_SECRET', 'library-test-secret-0123456789abcdef0123456');
    vi.stubEnv('AUTH_ADMIN_LOGINS', PARENT);
    const db = new PGlite();
    await db.waitReady;
    pool = new PGlitePool(db);
    const { getServerPersistenceProvider } = await import('@/lib/persistence/server-provider');
    await getServerPersistenceProvider(process.env.DATABASE_URL!, () => pool as never);
    const { getAuthDb } = await import('@/lib/server/auth/schema');
    const { upsertMember } = await import('@/lib/server/auth/members');
    await upsertMember(await getAuthDb(), {
      ownerId: ownerIdForLogin(KID),
      login: KID,
      name: 'Kid',
      avatarUrl: null,
    });
  });

  afterEach(async () => {
    await pool.end();
    vi.unstubAllEnvs();
  });

  it('resolves owner and share targets, refusing members who never signed in', async () => {
    const { resolveLibraryTarget } = await import('@/lib/server/auth/library');
    const parent = ownerIdForLogin(PARENT);
    await expect(
      resolveLibraryTarget({ defaultOwnerId: parent, shareWith: ['Kid@Example.com', KID] }),
    ).resolves.toEqual({
      ownerId: parent,
      shareWithOwnerIds: [ownerIdForLogin(KID)],
    });
    await expect(
      resolveLibraryTarget({ defaultOwnerId: parent, owner: KID, shareWith: [KID] }),
    ).resolves.toEqual({
      ownerId: ownerIdForLogin(KID),
      shareWithOwnerIds: [],
    });
    await expect(
      resolveLibraryTarget({ defaultOwnerId: parent, shareWith: ['stranger@x.y'] }),
    ).rejects.toThrow(/has not opened the site yet/);
    await expect(
      resolveLibraryTarget({ defaultOwnerId: parent, shareWith: 'kid' }),
    ).rejects.toThrow(/list of logins/);
  });

  it('saves a finished classroom as a course the owner lists and the recipient can read', async () => {
    const { saveClassroomToLibrary } = await import('@/lib/server/auth/library');
    const stageId = 'apiclass01';
    const now = Date.now();
    await saveClassroomToLibrary(
      {
        stage: { id: stageId, name: 'Negatives via API', createdAt: now, updatedAt: now },
        scenes: [],
        outlines: [],
        requirement: 'Teach negatives',
        producerRef: 'job-1',
      },
      { ownerId: ownerIdForLogin(PARENT), shareWithOwnerIds: [ownerIdForLogin(KID)] },
    );

    const { getOwnerScopedDocumentStore } =
      await import('@/lib/server/agent-runtime/owner-scoped-documents');
    const parentStore = await getOwnerScopedDocumentStore(ownerIdForLogin(PARENT));
    expect((await parentStore.listDocuments()).map((doc) => doc.id)).toContain(stageId);
    const document = await parentStore.loadDocument(stageId);
    expect(document?.outline).toMatchObject({
      generationComplete: true,
      producer: 'server-job',
      producerRef: 'job-1',
      requirement: 'Teach negatives',
    });

    const kidStore = await getOwnerScopedDocumentStore(ownerIdForLogin(KID));
    expect(await kidStore.loadDocument(stageId)).not.toBeNull();
    const { getAuthDb } = await import('@/lib/server/auth/schema');
    const { listIncomingShares } = await import('@/lib/server/auth/shares');
    expect(
      (await listIncomingShares(await getAuthDb(), ownerIdForLogin(KID))).map((s) => s.stageId),
    ).toEqual([stageId]);
    const meta = await pool.query(
      'SELECT generation_complete FROM stage_meta WHERE stage_id = $1',
      [stageId],
    );
    expect(meta.rows[0]).toEqual({ generation_complete: true });

    const strangerStore = await getOwnerScopedDocumentStore(ownerIdForLogin('stranger@x.y'));
    expect(await strangerStore.loadDocument(stageId)).toBeNull();
  });
});

describe('library media URLs', () => {
  it('rewrites this classroom media to relative paths and leaves everything else', async () => {
    const { relativizeClassroomMedia } = await import('@/lib/server/auth/library');
    const scenes = [
      {
        actions: [
          {
            type: 'speech',
            audioUrl: 'http://127.0.0.1:3000/api/classroom-media/abc/audio/tts_1.wav',
          },
          {
            type: 'speech',
            audioUrl: 'http://debian.example.ts.net/api/classroom-media/abc/audio/tts_2.wav',
          },
          { type: 'speech', audioUrl: '/api/classroom-media/abc/audio/tts_3.wav' },
        ],
        content: {
          elements: [
            { src: 'https://127.0.0.1:3000/api/classroom-media/abc/media/source-x.webp' },
            { src: 'https://cdn.example.com/api/classroom-media/abc/elsewhere.png/extra' },
            { src: 'http://127.0.0.1:3000/api/classroom-media/other/media/y.webp' },
            { src: 'https://images.example.com/cat.png' },
          ],
        },
      },
    ];
    const out = relativizeClassroomMedia(scenes, 'abc');
    expect(out[0]!.actions.map((a) => a.audioUrl)).toEqual([
      '/api/classroom-media/abc/audio/tts_1.wav',
      '/api/classroom-media/abc/audio/tts_2.wav',
      '/api/classroom-media/abc/audio/tts_3.wav',
    ]);
    expect(out[0]!.content.elements.map((e) => e.src)).toEqual([
      '/api/classroom-media/abc/media/source-x.webp',
      '/api/classroom-media/abc/elsewhere.png/extra',
      'http://127.0.0.1:3000/api/classroom-media/other/media/y.webp',
      'https://images.example.com/cat.png',
    ]);
  });
});

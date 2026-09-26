/**
 * Members, sharing, the admin (Family) routes and quiz results over PGlite
 * (design §5, decisions D21/D26).
 */
import { randomUUID } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import { createOwnerBoundDocumentStore } from '@/lib/persistence/owner-bound-document-store';
import { quizFingerprint, quizTotalPoints } from '@/lib/quiz/snapshot';
import { ownerIdForLogin, signedIdentityHeaders } from '@/lib/server/auth/signed-identity';

const SECRET = 'members-test-secret-0123456789abcdef012345678';
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

function courseDocument(id: string, name: string) {
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

function req(url: string, login: string | null, init: { method?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = login
    ? signedIdentityHeaders({ login, name: login.split('@')[0] }, SECRET)
    : {};
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  return new NextRequest(`http://localhost${url}`, {
    method: init.method ?? 'GET',
    headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
}

const params = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) });

describe('members, shares and the Family routes', () => {
  let pool: PGlitePool;
  const physics = 'stage-physics';
  const chemistry = 'stage-chemistry';
  const studentCourse = 'stage-student-own';

  beforeEach(async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('DATABASE_URL', `postgres://auth-members-${randomUUID()}`);
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
    await store(ownerIdForLogin(PARENT)).saveDocument(courseDocument(physics, 'Physics'));
    await store(ownerIdForLogin(PARENT)).saveDocument(courseDocument(chemistry, 'Chemistry'));
    await store(ownerIdForLogin(STUDENT)).saveDocument(courseDocument(studentCourse, 'My notes'));
  });

  afterEach(async () => {
    await pool.end();
    vi.unstubAllEnvs();
  });

  async function signIn(login: string) {
    const { GET } = await import('@/app/api/auth/me/route');
    const response = await GET(req('/api/auth/me', login));
    expect(response.status).toBe(200);
    return (await response.json()) as { member: Record<string, unknown> };
  }

  it('records members on /api/auth/me and lists them for the picker', async () => {
    const me = await signIn(PARENT);
    expect(me.member).toEqual({
      login: PARENT,
      name: 'parent',
      avatarUrl: null,
      ownerId: ownerIdForLogin(PARENT),
      learnerKey: ownerIdForLogin(PARENT),
      isAdmin: true,
    });
    expect((await signIn(STUDENT)).member.isAdmin).toBe(false);

    const { GET } = await import('@/app/api/auth/members/route');
    const listed = await (await GET(req('/api/auth/members', THIRD))).json();
    expect(listed.members.map((member: { login: string }) => member.login).sort()).toEqual([
      PARENT,
      STUDENT,
    ]);
    expect((await GET(req('/api/auth/members', null))).status).toBe(401);
  });

  it('shares, lists incoming, refuses non-owners, and unshares', async () => {
    await signIn(PARENT);
    await signIn(STUDENT);
    await signIn(THIRD);
    const shares = await import('@/app/api/stages/[id]/shares/route');
    const incoming = await import('@/app/api/shares/incoming/route');

    const add = await shares.POST(
      req(`/api/stages/${physics}/shares`, PARENT, {
        method: 'POST',
        body: { login: 'Student@Example.com' },
      }),
      params({ id: physics }),
    );
    expect(add.status).toBe(200);
    expect((await add.json()).recipients.map((r: { login: string }) => r.login)).toEqual([STUDENT]);

    const studentIncoming = await (await incoming.GET(req('/api/shares/incoming', STUDENT))).json();
    expect(studentIncoming.shares).toEqual([
      expect.objectContaining({ stageId: physics, name: 'Physics', ownerLogin: PARENT }),
    ]);
    expect((await (await incoming.GET(req('/api/shares/incoming', THIRD))).json()).shares).toEqual(
      [],
    );

    // Not the owner: the recipient, a third member, and even an admin get 404.
    for (const login of [STUDENT, THIRD]) {
      const response = await shares.GET(
        req(`/api/stages/${physics}/shares`, login),
        params({ id: physics }),
      );
      expect(response.status).toBe(404);
    }
    expect(
      (
        await shares.GET(
          req(`/api/stages/${studentCourse}/shares`, PARENT),
          params({ id: studentCourse }),
        )
      ).status,
    ).toBe(404);

    // Bad recipients.
    const unknown = await shares.POST(
      req(`/api/stages/${physics}/shares`, PARENT, {
        method: 'POST',
        body: { login: 'nobody@x.y' },
      }),
      params({ id: physics }),
    );
    expect(unknown.status).toBe(400);
    const self = await shares.POST(
      req(`/api/stages/${physics}/shares`, PARENT, { method: 'POST', body: { login: PARENT } }),
      params({ id: physics }),
    );
    expect(self.status).toBe(400);

    const removed = await shares.DELETE(
      req(`/api/stages/${physics}/shares?login=${encodeURIComponent(STUDENT)}`, PARENT, {
        method: 'DELETE',
      }),
      params({ id: physics }),
    );
    expect((await removed.json()).recipients).toEqual([]);
    expect(
      (await (await incoming.GET(req('/api/shares/incoming', STUDENT))).json()).shares,
    ).toEqual([]);
  });

  it('drops a deleted course from incoming shares', async () => {
    await signIn(PARENT);
    await signIn(STUDENT);
    const shares = await import('@/app/api/stages/[id]/shares/route');
    await shares.POST(
      req(`/api/stages/${chemistry}/shares`, PARENT, { method: 'POST', body: { login: STUDENT } }),
      params({ id: chemistry }),
    );
    const stageRoute = await import('@/app/api/stages/[id]/route');
    await stageRoute.DELETE(
      req(`/api/stages/${chemistry}`, PARENT, { method: 'DELETE' }),
      params({ id: chemistry }),
    );
    const incoming = await import('@/app/api/shares/incoming/route');
    expect(
      (await (await incoming.GET(req('/api/shares/incoming', STUDENT))).json()).shares,
    ).toEqual([]);
  });

  it('lets admins list members, courses and quiz results, and 404s everyone else', async () => {
    await signIn(PARENT);
    await signIn(STUDENT);
    const members = await import('@/app/api/admin/members/route');
    const stages = await import('@/app/api/admin/members/[ownerId]/stages/route');
    const quiz = await import('@/app/api/admin/members/[ownerId]/quiz-results/route');
    const student = ownerIdForLogin(STUDENT);

    expect((await members.GET(req('/api/admin/members', STUDENT))).status).toBe(404);
    expect((await members.GET(req('/api/admin/members', null))).status).toBe(401);
    expect(
      (
        await stages.GET(
          req(`/api/admin/members/${student}/stages`, STUDENT),
          params({ ownerId: student }),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await quiz.GET(
          req(`/api/admin/members/${student}/quiz-results`, THIRD),
          params({ ownerId: student }),
        )
      ).status,
    ).toBe(404);

    const listed = await (await members.GET(req('/api/admin/members', PARENT))).json();
    expect(listed.members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ login: PARENT, isAdmin: true, courseCount: 2 }),
        expect.objectContaining({ login: STUDENT, isAdmin: false, courseCount: 1 }),
      ]),
    );
    const courses = await (
      await stages.GET(
        req(`/api/admin/members/${student}/stages`, PARENT),
        params({ ownerId: student }),
      )
    ).json();
    expect(courses.courses).toEqual([
      expect.objectContaining({ stageId: studentCourse, name: 'My notes' }),
    ]);
    expect(
      (
        await stages.GET(
          req('/api/admin/members/acct_unknown/stages', PARENT),
          params({ ownerId: 'acct_unknown' }),
        )
      ).status,
    ).toBe(404);
  });

  it('reports quiz results with snapshot totals, legacy totals, changes and deleted courses', async () => {
    await signIn(PARENT);
    await signIn(STUDENT);
    const student = ownerIdForLogin(STUDENT);
    const questions = [
      { id: 'q1', type: 'single', question: 'One?', options: [], answer: ['A'], points: 2 },
      { id: 'q2', type: 'single', question: 'Two?', options: [], answer: ['B'] },
    ];
    const insertScene = (stageId: string, sceneId: string, qs: unknown[]) =>
      pool.query(
        `INSERT INTO document_scenes (stage_id, id, scene_order, data) VALUES ($1, $2, 0, $3::jsonb)
         ON CONFLICT (stage_id, id) DO UPDATE SET data = EXCLUDED.data`,
        [
          stageId,
          sceneId,
          JSON.stringify({
            id: sceneId,
            stageId,
            title: 'Check-in',
            order: 0,
            type: 'quiz',
            content: { type: 'quiz', questions: qs },
          }),
        ],
      );
    await insertScene(physics, 'quiz-1', questions);
    await insertScene(chemistry, 'quiz-2', questions);

    let seq = 0;
    const attempt = async (
      id: string,
      stageId: string,
      sceneId: string,
      payload: Record<string, unknown>,
    ) => {
      const at = new Date(Date.UTC(2026, 8, 26, 10, seq)).toISOString();
      await pool.query(
        `INSERT INTO runtime_sessions (id, stage_id, learner_key, kind, status, created_at, updated_at, data)
         VALUES ($1, $2, $3, 'quizAttempt', 'completed', $4, $4, '{}'::jsonb)`,
        [id, stageId, student, at],
      );
      await pool.query(
        `INSERT INTO runtime_records (id, session_id, seq, scene_id, created_at, data)
         VALUES ($1, $2, 0, $3, $4, $5::jsonb)`,
        [
          `rec-${id}`,
          id,
          sceneId,
          at,
          JSON.stringify({ payload: { payloadVersion: 1, ...payload } }),
        ],
      );
      seq += 1;
    };
    const snapshot = {
      totalPoints: quizTotalPoints(questions),
      quizFingerprint: quizFingerprint(questions),
    };
    const results = [
      { questionId: 'q1', correct: true, status: 'correct', earned: 2 },
      { questionId: 'q2', correct: false, status: 'incorrect', earned: 0 },
    ];
    await attempt('a-snapshot', physics, 'quiz-1', {
      phase: 'reviewed',
      answers: { q1: 'A', q2: 'A' },
      results,
      ...snapshot,
    });
    await attempt('a-legacy', physics, 'quiz-1', {
      phase: 'reviewed',
      answers: { q1: 'A', q2: 'A' },
      results,
    });
    await attempt('a-progress', physics, 'quiz-1', {
      phase: 'submitted',
      answers: { q1: 'A' },
      ...snapshot,
    });
    await attempt('a-empty-draft', physics, 'quiz-1', { phase: 'draft', answers: {} });
    await attempt('a-deleted', chemistry, 'quiz-2', {
      phase: 'reviewed',
      answers: { q1: 'A' },
      results,
      ...snapshot,
    });

    // Points changed after the snapshot, same ids.
    await insertScene(physics, 'quiz-1', [{ ...questions[0], points: 5 }, questions[1]]);
    const stageRoute = await import('@/app/api/stages/[id]/route');
    await stageRoute.DELETE(
      req(`/api/stages/${chemistry}`, PARENT, { method: 'DELETE' }),
      params({ id: chemistry }),
    );

    const quiz = await import('@/app/api/admin/members/[ownerId]/quiz-results/route');
    const body = await (
      await quiz.GET(
        req(`/api/admin/members/${student}/quiz-results`, PARENT),
        params({ ownerId: student }),
      )
    ).json();
    const byId = Object.fromEntries(
      (body.results as Array<{ attemptId: string }>).map((row) => [row.attemptId, row]),
    );
    expect(Object.keys(byId).sort()).toEqual(['a-deleted', 'a-legacy', 'a-progress', 'a-snapshot']);
    expect(byId['a-snapshot']).toMatchObject({
      earned: 2,
      total: 3,
      quizChanged: true,
      courseDeleted: false,
      stageName: 'Physics',
      sceneTitle: 'Check-in',
    });
    expect(byId['a-legacy']).toMatchObject({ earned: 2, total: null, quizChanged: false });
    expect(byId['a-progress']).toMatchObject({ inProgress: true, earned: null, total: 3 });
    expect(byId['a-deleted']).toMatchObject({
      courseDeleted: true,
      stageName: 'Chemistry',
      earned: 2,
      total: 3,
    });
  });

  it('answers 404 on every sign-in route with sign-in off', async () => {
    vi.stubEnv('AUTH_MODE', '');
    const routes = [
      (await import('@/app/api/auth/me/route')).GET(req('/api/auth/me', null)),
      (await import('@/app/api/auth/members/route')).GET(req('/api/auth/members', null)),
      (await import('@/app/api/shares/incoming/route')).GET(req('/api/shares/incoming', null)),
      (await import('@/app/api/admin/members/route')).GET(req('/api/admin/members', null)),
      (await import('@/app/api/stages/[id]/shares/route')).GET(
        req(`/api/stages/${physics}/shares`, null),
        params({ id: physics }),
      ),
    ];
    for (const response of await Promise.all(routes)) expect(response.status).toBe(404);
  });
});

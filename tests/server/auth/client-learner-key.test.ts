import { beforeEach, describe, expect, it, vi } from 'vitest';

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, String(value)),
  } as Storage;
}

const ACCOUNT = 'acct_0123456789abcdef0123456789abcdef';

describe('client learner key with signed-header sign-in', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.stubEnv('NEXT_PUBLIC_PERSISTENCE', '1');
    vi.stubEnv('NEXT_PUBLIC_PERSISTENCE_TOKEN', 'dev-token');
    vi.stubGlobal('window', {});
    vi.stubGlobal('localStorage', memoryStorage());
  });

  it('uses the account key from /api/auth/me and merges the device key into it once', async () => {
    vi.stubEnv('NEXT_PUBLIC_AUTH_MODE', 'signed-header');
    const { BrowserKVStore } = await import('@openmaic/storage');
    const { LEARNER_KEY_KV_KEY } = await import('@/lib/runtime/learner-key');
    const kv = new BrowserKVStore();
    await kv.set(LEARNER_KEY_KV_KEY, 'anon:device-key', 'device');

    const calls: Array<{ url: string; body?: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, body: typeof init?.body === 'string' ? init.body : undefined });
        if (url.endsWith('/api/auth/me')) {
          return Response.json({
            member: { login: 'kid@x.y', learnerKey: ACCOUNT, ownerId: ACCOUNT },
          });
        }
        if (url.endsWith('/runtime/learners/merge')) return Response.json({ moved: 2 });
        return new Response('unexpected', { status: 500 });
      }),
    );

    const { getPersistenceLearnerKey, getPersistenceRequestHeaders } =
      await import('@/lib/persistence/bootstrap');
    await expect(getPersistenceLearnerKey()).resolves.toBe(ACCOUNT);
    await expect(getPersistenceRequestHeaders()).resolves.toMatchObject({
      'x-learner-key': ACCOUNT,
    });
    await vi.waitFor(async () => {
      expect(await kv.get(LEARNER_KEY_KV_KEY, 'device')).toBeNull();
    });
    const merge = calls.find((call) => call.url.endsWith('/runtime/learners/merge'));
    expect(JSON.parse(merge!.body!)).toEqual({
      fromLearnerKey: 'anon:device-key',
      toLearnerKey: ACCOUNT,
    });
    expect(calls.filter((call) => call.url.endsWith('/api/auth/me'))).toHaveLength(1);
  });

  it('keeps the device key and makes no auth request with sign-in off', async () => {
    vi.stubEnv('NEXT_PUBLIC_AUTH_MODE', '');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const { getPersistenceLearnerKey } = await import('@/lib/persistence/bootstrap');
    await expect(getPersistenceLearnerKey()).resolves.toMatch(/^anon:/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('stores the quiz snapshot only in a sign-in build', async () => {
    const questions = [{ id: 'q1', points: 2 }, { id: 'q2' }];
    vi.stubEnv('NEXT_PUBLIC_AUTH_MODE', '');
    const off = await import('@/lib/quiz/snapshot');
    expect(off.quizSnapshotForSubmit(questions)).toBeUndefined();
    vi.stubEnv('NEXT_PUBLIC_AUTH_MODE', 'signed-header');
    expect(off.quizSnapshotForSubmit(questions)).toEqual({
      totalPoints: 3,
      quizFingerprint: off.quizFingerprint(questions),
    });
    expect(off.quizFingerprint(questions)).not.toBe(
      off.quizFingerprint([{ id: 'q1', points: 5 }, { id: 'q2' }]),
    );
  });
});

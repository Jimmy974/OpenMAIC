import { BrowserRuntimeStore } from '@openmaic/storage';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';

import { quizAttemptId, recordQuizAttempt } from '@/lib/quiz/runtime';

describe('quiz attempt payload snapshot (D26)', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'IDBKeyRange', { configurable: true, value: IDBKeyRange });
  });

  async function payloads(snapshot?: { totalPoints: number; quizFingerprint: string }) {
    const store = new BrowserRuntimeStore({
      indexedDB: new IDBFactory(),
      dbName: `quiz-snapshot-${Math.random()}`,
    });
    let tick = 0;
    const deps = {
      store,
      learnerKey: 'acct_x',
      now: () => new Date(Date.UTC(2026, 8, 26, 12, 0, tick++)).toISOString(),
      mintRecordId: () => `record-${tick}`,
    };
    const attemptId = quizAttemptId('stage-1', 'scene-1', 'acct_x');
    const base = { stageId: 'stage-1', sceneId: 'scene-1', attemptId, answers: { q1: 'A' } };
    await recordQuizAttempt({ ...base, phase: 'draft', snapshot }, deps);
    await recordQuizAttempt({ ...base, phase: 'submitted', snapshot }, deps);
    await recordQuizAttempt(
      {
        ...base,
        phase: 'reviewed',
        results: [{ questionId: 'q1', correct: true, status: 'correct', earned: 2 }],
        snapshot,
      },
      deps,
    );
    return (await store.listRecords(attemptId)).map(
      (record) => record.payload as Record<string, unknown>,
    );
  }

  it('adds totalPoints and quizFingerprint to submitted and reviewed payloads only', async () => {
    const [draft, submitted, reviewed] = await payloads({
      totalPoints: 3,
      quizFingerprint: 'v1:abc',
    });
    expect(draft).not.toHaveProperty('totalPoints');
    expect(submitted).toMatchObject({
      phase: 'submitted',
      totalPoints: 3,
      quizFingerprint: 'v1:abc',
    });
    expect(reviewed).toMatchObject({
      phase: 'reviewed',
      totalPoints: 3,
      quizFingerprint: 'v1:abc',
    });
  });

  it('writes the upstream payload unchanged without a snapshot', async () => {
    const all = await payloads(undefined);
    for (const payload of all) {
      expect(Object.keys(payload).sort()).toEqual(
        payload.phase === 'reviewed'
          ? ['answers', 'payloadVersion', 'phase', 'results']
          : ['answers', 'payloadVersion', 'phase'],
      );
    }
  });
});

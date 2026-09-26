/**
 * A member's quiz attempts for the Family page (design §5, decisions D21/D26).
 *
 * Every `quizAttempt` runtime session in the member's learner partition, on
 * any course (their own or one shared with them), reduced to its latest
 * lifecycle record:
 *
 * - `earned` is the sum of `results[].earned`; an attempt without results is
 *   still in progress. Grading happens in the browser upstream, so this is
 *   the learner's own client's grade (a known residual).
 * - `total` is the snapshot written at submit (`totalPoints`, D26). Attempts
 *   from before the snapshot existed have no trustworthy total: null ("—").
 * - `quizChanged` flags an attempt whose quiz scene is gone, whose snapshot
 *   fingerprint differs from the scene now, or (legacy attempts) whose
 *   answered questions are no longer in the scene (D21).
 * - Attempts on a deleted course are listed, labelled `courseDeleted`.
 */
import type { Queryable } from '@openmaic/storage/document/pg';

import { quizFingerprint, type SnapshotQuestion } from '@/lib/quiz/snapshot';

export interface QuizResultRow {
  attemptId: string;
  stageId: string;
  stageName: string | null;
  courseDeleted: boolean;
  sceneId: string | null;
  sceneTitle: string | null;
  phase: 'draft' | 'submitted' | 'reviewed';
  inProgress: boolean;
  earned: number | null;
  total: number | null;
  quizChanged: boolean;
  /** ISO 8601 of the latest lifecycle record. */
  at: string;
}

interface RawAttemptRow extends Record<string, unknown> {
  session_id: string;
  stage_id: string;
  scene_id: string | null;
  record_at: string;
  payload: unknown;
  stage_name: string | null;
  deleted_at: Date | string | null;
  has_meta: boolean;
  questions: unknown;
  scene_title: string | null;
  scene_found: boolean;
}

interface AttemptPayload {
  phase?: unknown;
  answers?: unknown;
  results?: unknown;
  totalPoints?: unknown;
  quizFingerprint?: unknown;
}

const ATTEMPTS_SQL = `
  SELECT s.id AS session_id,
         s.stage_id,
         r.scene_id,
         r.created_at AS record_at,
         r.data -> 'payload' AS payload,
         d.name AS stage_name,
         m.deleted_at,
         (m.stage_id IS NOT NULL) AS has_meta,
         sc.data -> 'content' -> 'questions' AS questions,
         sc.data ->> 'title' AS scene_title,
         (sc.id IS NOT NULL) AS scene_found
    FROM runtime_sessions s
    JOIN LATERAL (
          SELECT scene_id, created_at, data
            FROM runtime_records
           WHERE session_id = s.id
           ORDER BY seq DESC
           LIMIT 1
         ) r ON true
    LEFT JOIN document_stages d ON d.id = s.stage_id
    LEFT JOIN stage_meta m ON m.stage_id = s.stage_id
    LEFT JOIN document_scenes sc ON sc.stage_id = s.stage_id AND sc.id = r.scene_id
   WHERE s.learner_key = $1 AND s.kind = 'quizAttempt'
   ORDER BY r.created_at DESC
   LIMIT 500
`;

function asObject(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try {
      return asObject(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] | null {
  if (typeof value === 'string') {
    try {
      return asArray(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return Array.isArray(value) ? value : null;
}

function sceneQuestions(value: unknown): SnapshotQuestion[] | null {
  const list = asArray(value);
  if (!list) return null;
  const questions: SnapshotQuestion[] = [];
  for (const item of list) {
    const question = asObject(item);
    if (!question || typeof question.id !== 'string') return null;
    questions.push({
      id: question.id,
      ...(typeof question.points === 'number' ? { points: question.points } : {}),
    });
  }
  return questions;
}

function earnedFrom(results: unknown): number | null {
  const list = asArray(results);
  if (!list) return null;
  let sum = 0;
  for (const item of list) {
    const earned = asObject(item)?.earned;
    if (typeof earned === 'number' && Number.isFinite(earned)) sum += earned;
  }
  return sum;
}

function answeredIds(payload: AttemptPayload): string[] {
  const ids = new Set(Object.keys(asObject(payload.answers) ?? {}));
  for (const item of asArray(payload.results) ?? []) {
    const id = asObject(item)?.questionId;
    if (typeof id === 'string') ids.add(id);
  }
  return [...ids];
}

export function summarizeAttempt(row: RawAttemptRow): QuizResultRow | null {
  const payload = asObject(row.payload) as AttemptPayload | null;
  if (!payload) return null;
  const phase = payload.phase;
  if (phase !== 'draft' && phase !== 'submitted' && phase !== 'reviewed') return null;
  const answers = asObject(payload.answers) ?? {};
  // An untouched draft is a page view, not an attempt.
  if (phase === 'draft' && Object.keys(answers).length === 0) return null;

  const questions = row.scene_found ? sceneQuestions(row.questions) : null;
  let quizChanged: boolean;
  if (!questions) {
    quizChanged = true;
  } else if (typeof payload.quizFingerprint === 'string') {
    quizChanged = payload.quizFingerprint !== quizFingerprint(questions);
  } else {
    const current = new Set(questions.map((question) => question.id));
    quizChanged = answeredIds(payload).some((id) => !current.has(id));
  }

  const earned = phase === 'reviewed' ? earnedFrom(payload.results) : null;
  const total =
    typeof payload.totalPoints === 'number' && Number.isFinite(payload.totalPoints)
      ? payload.totalPoints
      : null;
  return {
    attemptId: row.session_id,
    stageId: row.stage_id,
    stageName: row.stage_name,
    courseDeleted: row.stage_name === null || !row.has_meta || row.deleted_at !== null,
    sceneId: row.scene_id,
    sceneTitle: row.scene_title,
    phase,
    inProgress: earned === null,
    earned,
    total,
    quizChanged,
    at: row.record_at,
  };
}

export async function listQuizResults(
  db: Pick<Queryable, 'query'>,
  learnerKey: string,
): Promise<QuizResultRow[]> {
  const result = await db.query<RawAttemptRow>(ATTEMPTS_SQL, [learnerKey]);
  const rows: QuizResultRow[] = [];
  for (const raw of result.rows) {
    const summary = summarizeAttempt(raw);
    if (summary) rows.push(summary);
  }
  return rows;
}

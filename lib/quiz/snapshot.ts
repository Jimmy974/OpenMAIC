/**
 * What a quiz looked like when an attempt was submitted (decision D26): the
 * total points and a fingerprint of the question ids and points. Stored in the
 * attempt payload only with signed-header sign-in, so the Family page can show
 * an attempt against the total it was actually taken against, and flag a quiz
 * that changed since.
 *
 * Client-safe and synchronous; the server computes the same fingerprint for
 * the current quiz scene.
 */
import { isClientAuthModeEnabled } from '@/lib/auth/public-mode';

export interface SnapshotQuestion {
  id: string;
  points?: number;
}

function points(question: SnapshotQuestion): number {
  return typeof question.points === 'number' && Number.isFinite(question.points)
    ? question.points
    : 1;
}

export function quizTotalPoints(questions: readonly SnapshotQuestion[]): number {
  return questions.reduce((sum, question) => sum + points(question), 0);
}

/** `v1:` + FNV-1a (32-bit, hex) over `id:points` pairs in question order. */
export function quizFingerprint(questions: readonly SnapshotQuestion[]): string {
  const canonical = questions.map((question) => `${question.id}:${points(question)}`).join('|');
  let hash = 0x811c9dc5;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `v1:${hash.toString(16).padStart(8, '0')}`;
}

export interface QuizSnapshot {
  totalPoints: number;
  quizFingerprint: string;
}

/**
 * The snapshot to store with a submitted attempt: only in a sign-in build,
 * so payloads without sign-in stay byte-for-byte what upstream writes.
 */
export function quizSnapshotForSubmit(
  questions: readonly SnapshotQuestion[],
): QuizSnapshot | undefined {
  if (!isClientAuthModeEnabled()) return undefined;
  return { totalPoints: quizTotalPoints(questions), quizFingerprint: quizFingerprint(questions) };
}

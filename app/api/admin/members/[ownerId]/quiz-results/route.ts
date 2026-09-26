/**
 * GET /api/admin/members/[ownerId]/quiz-results — one member's quiz attempts
 * on every course, their own or shared with them (design §5, D21/D26).
 * Admins only; anyone else, and an unknown member, gets 404.
 */
import { NextResponse } from 'next/server';

import { findMemberByOwnerId } from '@/lib/server/auth/members';
import { listQuizResults } from '@/lib/server/auth/quiz-results';
import { adminOr404, authNotFoundResponse } from '@/lib/server/auth/responses';
import { getAuthDb } from '@/lib/server/auth/schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ ownerId: string }> };

export async function GET(req: Request, { params }: Params) {
  const admin = adminOr404(req);
  if (admin instanceof Response) return admin;
  const { ownerId } = await params;
  try {
    const db = await getAuthDb();
    const member = await findMemberByOwnerId(db, ownerId);
    if (!member) return authNotFoundResponse();
    // A member's learner key is their owner id (design §1).
    return NextResponse.json({ results: await listQuizResults(db, member.ownerId) });
  } catch (error) {
    console.error('[auth] failed to list quiz results', error);
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}

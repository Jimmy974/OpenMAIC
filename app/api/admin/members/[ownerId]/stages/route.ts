/**
 * GET /api/admin/members/[ownerId]/stages — one member's live courses.
 * Admins only; anyone else, and an unknown member, gets 404.
 */
import { NextResponse } from 'next/server';

import { findMemberByOwnerId, listMemberCourses } from '@/lib/server/auth/members';
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
    if (!(await findMemberByOwnerId(db, ownerId))) return authNotFoundResponse();
    return NextResponse.json({ courses: await listMemberCourses(db, ownerId) });
  } catch (error) {
    console.error('[auth] failed to list member courses', error);
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}

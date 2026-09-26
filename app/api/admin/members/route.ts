/**
 * GET /api/admin/members — every member with their live course count, for the
 * Family page (design §5). Admins only; anyone else gets 404.
 */
import { NextResponse } from 'next/server';

import { courseCountsByOwner, listMembers } from '@/lib/server/auth/members';
import { adminOr404 } from '@/lib/server/auth/responses';
import { getAuthDb } from '@/lib/server/auth/schema';
import { isAdminOwnerId } from '@/lib/server/auth/access';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const admin = adminOr404(req);
  if (admin instanceof Response) return admin;
  try {
    const db = await getAuthDb();
    const [members, counts] = await Promise.all([listMembers(db), courseCountsByOwner(db)]);
    return NextResponse.json({
      members: members.map((member) => ({
        ownerId: member.ownerId,
        login: member.login,
        name: member.name,
        avatarUrl: member.avatarUrl,
        isAdmin: isAdminOwnerId(member.ownerId),
        courseCount: counts.get(member.ownerId) ?? 0,
        lastSeenAt: member.lastSeenAt,
      })),
    });
  } catch (error) {
    console.error('[auth] failed to list members for admin', error);
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}

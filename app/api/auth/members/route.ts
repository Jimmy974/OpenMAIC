/**
 * GET /api/auth/members — every member who has signed in, for the share
 * picker (design §5). Signed-in members only.
 */
import { NextResponse } from 'next/server';

import { listMembers } from '@/lib/server/auth/members';
import { identityOr401 } from '@/lib/server/auth/responses';
import { getAuthDb } from '@/lib/server/auth/schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const identity = identityOr401(req);
  if (identity instanceof Response) return identity;
  try {
    const members = await listMembers(await getAuthDb());
    return NextResponse.json({
      members: members.map((member) => ({
        login: member.login,
        name: member.name,
        avatarUrl: member.avatarUrl,
      })),
    });
  } catch (error) {
    console.error('[auth] failed to list members', error);
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}

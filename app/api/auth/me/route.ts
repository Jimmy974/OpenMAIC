/**
 * GET /api/auth/me — the signed-in member (design §5).
 *
 * Also records the member (first and last seen), which is how the share
 * picker and the Family page learn who uses the site. 404 outside sign-in
 * mode, 401 without a valid signed identity.
 */
import { NextResponse } from 'next/server';

import { MemberCollisionError, upsertMember } from '@/lib/server/auth/members';
import { identityOr401 } from '@/lib/server/auth/responses';
import { getAuthDb } from '@/lib/server/auth/schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const identity = identityOr401(req);
  if (identity instanceof Response) return identity;
  try {
    const member = await upsertMember(await getAuthDb(), identity);
    return NextResponse.json(
      {
        member: {
          login: identity.login,
          name: member.name,
          avatarUrl: member.avatarUrl,
          ownerId: identity.ownerId,
          learnerKey: identity.learnerKey,
          isAdmin: identity.isAdmin,
        },
      },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (error) {
    if (error instanceof MemberCollisionError) {
      console.error('[auth] owner id collision; refusing to alias two logins', error.message);
    } else {
      console.error('[auth] failed to record member', error);
    }
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}

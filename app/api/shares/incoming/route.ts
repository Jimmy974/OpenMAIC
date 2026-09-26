/**
 * GET /api/shares/incoming — live courses other members shared with the
 * signed-in member ("Shared with me", design §5).
 */
import { NextResponse } from 'next/server';

import { identityOr401 } from '@/lib/server/auth/responses';
import { getAuthDb } from '@/lib/server/auth/schema';
import { listIncomingShares } from '@/lib/server/auth/shares';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const identity = identityOr401(req);
  if (identity instanceof Response) return identity;
  try {
    return NextResponse.json({
      shares: await listIncomingShares(await getAuthDb(), identity.ownerId),
    });
  } catch (error) {
    console.error('[auth] failed to list incoming shares', error);
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}

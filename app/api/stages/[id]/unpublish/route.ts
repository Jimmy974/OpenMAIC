/**
 * POST /api/stages/[id]/unpublish — make a document-backed course private.
 *
 * Owner-only; anonymous owners are refused with the reference's
 * `login_required` (same rationale as publish).
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { isAgentRuntimeConfigured } from '@/lib/config/feature-flags';
import { setStagePublished } from '@/lib/persistence/stage-meta';
import { getStageAccessDb, resolveStageAccess } from '@/lib/server/stage-access';
import { withRequestOwnerId } from '@/lib/server/agent-runtime/with-owner';
import { isAuthModeEnabled } from '@/lib/server/auth/signed-identity';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Params) {
  if (!isAgentRuntimeConfigured()) return new Response('Not found', { status: 404 });
  // Signed-header sign-in shares courses with named members instead; a
  // public flag would be a read grant outside that model (design §4).
  if (isAuthModeEnabled()) return new Response('Not found', { status: 404 });

  return withRequestOwnerId(req, async (ownerId, responseHeaders) => {
    const { id: stageId } = await params;
    try {
      if (ownerId.startsWith('anon:')) {
        return NextResponse.json(
          { error: 'login_required' },
          { status: 401, headers: responseHeaders },
        );
      }

      const access = await resolveStageAccess(stageId);
      if (!access) {
        return NextResponse.json({ error: 'not_found' }, { status: 404, headers: responseHeaders });
      }
      if (access.ownerId !== ownerId) {
        return NextResponse.json({ error: 'forbidden' }, { status: 403, headers: responseHeaders });
      }

      const db = await getStageAccessDb();
      await setStagePublished(db, stageId, false, null);

      console.info('Stage unpublished', { stageId, ownerId });
      return NextResponse.json({ success: true }, { status: 200, headers: responseHeaders });
    } catch (error) {
      console.error('Failed to unpublish stage', {
        stageId,
        error: error instanceof Error ? error.message : String(error),
      });
      return NextResponse.json(
        { error: 'internal_error' },
        { status: 500, headers: responseHeaders },
      );
    }
  });
}

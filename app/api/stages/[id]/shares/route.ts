/**
 * /api/stages/[id]/shares — who a course is shared with (design §5).
 *
 *   GET                       → { recipients: [{ login, name, avatarUrl, sharedAt }] }
 *   POST   { login }          → share with a registered member
 *   DELETE ?login=<login>     → stop sharing
 *
 * Owner only: anyone else (admins included) gets the same 404 as a missing
 * course. The recipient must be a registered member and not the owner (400).
 * 404 outside sign-in mode, 401 without a valid signed identity.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { findMemberByLogin } from '@/lib/server/auth/members';
import { authNotFoundResponse, identityOr401 } from '@/lib/server/auth/responses';
import { getAuthDb } from '@/lib/server/auth/schema';
import {
  addShare,
  listShareRecipients,
  ownsLiveStage,
  removeShare,
} from '@/lib/server/auth/shares';
import { normalizeLogin, type SignedIdentity } from '@/lib/server/auth/signed-identity';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

function badRequest(error: string): Response {
  return NextResponse.json({ error }, { status: 400 });
}

async function ownerContext(
  req: NextRequest,
  params: Params['params'],
): Promise<{ identity: SignedIdentity; stageId: string } | Response> {
  const identity = identityOr401(req);
  if (identity instanceof Response) return identity;
  const { id: stageId } = await params;
  if (!(await ownsLiveStage(await getAuthDb(), stageId, identity.ownerId))) {
    return authNotFoundResponse();
  }
  return { identity, stageId };
}

async function handle(
  req: NextRequest,
  params: Params['params'],
  body: (context: { identity: SignedIdentity; stageId: string }) => Promise<Response>,
): Promise<Response> {
  try {
    const context = await ownerContext(req, params);
    if (context instanceof Response) return context;
    return await body(context);
  } catch (error) {
    console.error('[auth] course share request failed', error);
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}

export async function GET(req: NextRequest, { params }: Params) {
  return handle(req, params, async ({ stageId }) =>
    NextResponse.json({ recipients: await listShareRecipients(await getAuthDb(), stageId) }),
  );
}

export async function POST(req: NextRequest, { params }: Params) {
  return handle(req, params, async ({ identity, stageId }) => {
    let login: unknown;
    try {
      login = ((await req.json()) as { login?: unknown })?.login;
    } catch {
      return badRequest('invalid_json');
    }
    if (typeof login !== 'string' || !normalizeLogin(login)) return badRequest('login_required');
    const db = await getAuthDb();
    const recipient = await findMemberByLogin(db, normalizeLogin(login));
    if (!recipient) return badRequest('unknown_member');
    if (recipient.ownerId === identity.ownerId) return badRequest('cannot_share_with_owner');
    await addShare(db, stageId, identity.ownerId, recipient.ownerId);
    return NextResponse.json({ recipients: await listShareRecipients(db, stageId) });
  });
}

export async function DELETE(req: NextRequest, { params }: Params) {
  return handle(req, params, async ({ stageId }) => {
    const login = new URL(req.url).searchParams.get('login');
    if (!login || !normalizeLogin(login)) return badRequest('login_required');
    const db = await getAuthDb();
    const recipient = await findMemberByLogin(db, normalizeLogin(login));
    if (recipient) await removeShare(db, stageId, recipient.ownerId);
    return NextResponse.json({ recipients: await listShareRecipients(db, stageId) });
  });
}

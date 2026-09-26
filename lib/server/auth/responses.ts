/**
 * Route-level helpers for signed-header sign-in (design §2, amendment R2-10).
 *
 * One rule for every route that needs a member: a missing, forged or stale
 * identity is 401 `AUTH_REQUIRED`; a member who fails an access check gets the
 * same 404 as a missing resource, so existence is never disclosed.
 */
import { NextResponse } from 'next/server';

import { resolveRequestOwnerId } from '@/lib/server/agent-runtime/owner';

import {
  isAuthModeEnabled,
  readRequestIdentity,
  UnauthenticatedError,
  type SignedIdentity,
} from './signed-identity';

export function authRequiredResponse(headers?: HeadersInit): Response {
  return NextResponse.json(
    { success: false, errorCode: 'AUTH_REQUIRED', error: 'Sign-in required' },
    { status: 401, headers },
  );
}

export function authNotFoundResponse(headers?: HeadersInit): Response {
  return NextResponse.json({ error: 'not_found' }, { status: 404, headers });
}

/**
 * The owner for a route that resolves one directly (the SSE routes), or the
 * 401 to return. Outside sign-in mode this is exactly `resolveRequestOwnerId`.
 */
export function ownerIdOr401(
  req: Pick<Request, 'headers'>,
  responseHeaders: Headers,
): string | Response {
  try {
    return resolveRequestOwnerId(req, responseHeaders);
  } catch (error) {
    if (error instanceof UnauthenticatedError) return authRequiredResponse(responseHeaders);
    throw error;
  }
}

/**
 * The verified member for a sign-in-only route. Outside sign-in mode those
 * routes do not exist, so this answers 404 rather than 401.
 */
export function identityOr401(req: Pick<Request, 'headers'>): SignedIdentity | Response {
  if (!isAuthModeEnabled()) return authNotFoundResponse();
  return readRequestIdentity(req.headers) ?? authRequiredResponse();
}

/** Like {@link identityOr401}, and a non-admin member gets 404. */
export function adminOr404(req: Pick<Request, 'headers'>): SignedIdentity | Response {
  const identity = identityOr401(req);
  if (identity instanceof Response) return identity;
  return identity.isAdmin ? identity : authNotFoundResponse();
}

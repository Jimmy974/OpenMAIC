import { authRequiredResponse } from '@/lib/server/auth/responses';
import { UnauthenticatedError } from '@/lib/server/auth/signed-identity';

import { resolveRequestOwnerId } from './owner';

/**
 * Resolve the anonymous owner identity and run a handler with its response
 * headers.
 *
 * The Set-Cookie minted by resolveRequestOwnerId must ride every response,
 * including 4xx and 5xx: a client that retries after an error keeps the same
 * owner partition, while a 500 that dropped the cookie would silently make
 * the retry a different anonymous owner.
 *
 * With signed-header sign-in on, a request without a valid identity never
 * reaches the handler: it is answered 401 `AUTH_REQUIRED`.
 */
export async function withRequestOwnerId(
  req: Pick<Request, 'headers'>,
  handler: (ownerId: string, responseHeaders: Headers) => Promise<Response>,
): Promise<Response> {
  const responseHeaders = new Headers();
  let ownerId: string;
  try {
    ownerId = resolveRequestOwnerId(req, responseHeaders);
  } catch (error) {
    if (error instanceof UnauthenticatedError) return authRequiredResponse(responseHeaders);
    throw error;
  }
  try {
    return await handler(ownerId, responseHeaders);
  } catch (error) {
    if (error instanceof UnauthenticatedError) return authRequiredResponse(responseHeaders);
    console.error('[agent-runtime] request failed under an anonymous owner', error);
    return new Response('Internal Server Error', { status: 500, headers: responseHeaders });
  }
}

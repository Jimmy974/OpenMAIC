/**
 * The signed-in member, as the browser sees it (design §5, §6).
 *
 * Only active when the build set `NEXT_PUBLIC_AUTH_MODE`; otherwise every
 * function here answers "no member" without a request, so a build without
 * sign-in makes no auth calls. The identity itself is added to every request
 * by the front proxy, so the browser holds no credential: `/api/auth/me`
 * simply reports who the proxy says is signed in.
 */
import { isClientAuthModeEnabled } from './public-mode';

export interface ClientMember {
  login: string;
  name: string;
  avatarUrl: string | null;
  ownerId: string;
  learnerKey: string;
  isAdmin: boolean;
}

let memberPromise: Promise<ClientMember | null> | undefined;

async function requestMember(fetchImpl: typeof fetch): Promise<ClientMember | null> {
  const response = await fetchImpl('/api/auth/me', { cache: 'no-store' });
  if (response.status === 401 || response.status === 404) return null;
  if (!response.ok) throw new Error(`GET /api/auth/me failed with ${response.status}`);
  const body = (await response.json()) as { member?: ClientMember };
  if (!body.member || typeof body.member.learnerKey !== 'string') {
    throw new Error('GET /api/auth/me returned no member');
  }
  return body.member;
}

/**
 * The signed-in member, or null when there is none (or sign-in is off).
 * Memoised for the page's lifetime; a failed request is not cached.
 */
export function getSignedInMember(fetchImpl: typeof fetch = fetch): Promise<ClientMember | null> {
  if (!isClientAuthModeEnabled()) return Promise.resolve(null);
  memberPromise ??= requestMember(fetchImpl).catch((error) => {
    memberPromise = undefined;
    throw error;
  });
  return memberPromise;
}

/** @internal */
export function resetSignedInMemberForTests(): void {
  memberPromise = undefined;
}

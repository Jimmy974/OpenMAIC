/**
 * Decision D23 revisited (2026-09-27): with signed-header sign-in the Pi chat
 * whiteboard, its visibility callback and server asset resolution take the
 * learner from the signed identity, never from the development token or the
 * client's x-learner-key.
 */
import type { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { queryWhiteboardVisibility } from '@/lib/chat/pi/whiteboard-visibility';
import {
  authenticatePersistenceHeaders,
  authenticatePersistenceRequest,
} from '@/lib/persistence/server-auth';
import { ownerIdForLogin, signedIdentityHeaders } from '@/lib/server/auth/signed-identity';

const SECRET = 'whiteboard-test-secret-0123456789abcdef0123';
const KID = 'kid@example.com';
const SIBLING = 'sibling@example.com';

beforeEach(() => {
  vi.stubEnv('AUTH_MODE', 'signed-header');
  vi.stubEnv('AUTH_IDENTITY_SECRET', SECRET);
  vi.stubEnv('AUTH_ADMIN_LOGINS', 'parent@example.com');
  vi.stubEnv('PERSISTENCE_DEV_TOKEN', 'public-dev-token');
});
afterEach(() => vi.unstubAllEnvs());

describe('persistence principal with signed-header sign-in', () => {
  it('uses the signed account key and ignores a spoofed x-learner-key', async () => {
    const headers = new Headers({
      ...signedIdentityHeaders({ login: KID }, SECRET),
      authorization: 'Bearer public-dev-token',
      'x-learner-key': ownerIdForLogin(SIBLING),
    });
    expect(authenticatePersistenceHeaders(headers)).toEqual({
      key: 'shared',
      learnerKey: ownerIdForLogin(KID),
    });
    const nodeRequest = {
      headers: Object.fromEntries(headers.entries()),
    } as unknown as import('node:http').IncomingMessage;
    await expect(authenticatePersistenceRequest(nodeRequest)).resolves.toEqual({
      key: 'shared',
      learnerKey: ownerIdForLogin(KID),
    });
  });

  it('gives no principal for the development token alone', () => {
    const headers = new Headers({
      authorization: 'Bearer public-dev-token',
      'x-learner-key': ownerIdForLogin(SIBLING),
    });
    expect(authenticatePersistenceHeaders(headers)).toBeUndefined();
  });

  it('keeps the development token path with sign-in off', () => {
    vi.stubEnv('AUTH_MODE', '');
    const headers = new Headers({
      authorization: 'Bearer public-dev-token',
      'x-learner-key': 'anon:1',
    });
    expect(authenticatePersistenceHeaders(headers)).toEqual({
      key: 'shared',
      learnerKey: 'anon:1',
    });
  });
});

describe('whiteboard visibility callback with signed-header sign-in', () => {
  function request(login: string | null, body: unknown, extra: Record<string, string> = {}) {
    return new Request('http://localhost/api/chat/pi/whiteboard-visibility', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(login ? signedIdentityHeaders({ login }, SECRET) : {}),
        ...extra,
      },
      body: JSON.stringify(body),
    }) as unknown as NextRequest;
  }

  it('lets only the signed-in learner settle their own pending query', async () => {
    let queryId = '';
    const pending = queryWhiteboardVisibility({
      stageId: 'stage-1',
      learnerKey: ownerIdForLogin(SIBLING),
      timeoutMs: 1_000,
      dispatch: async (id) => {
        queryId = id;
      },
    });
    await vi.waitFor(() => expect(queryId).not.toBe(''));
    const { POST } = await import('@/app/api/chat/pi/whiteboard-visibility/route');
    const body = { queryId, stageId: 'stage-1', visibility: 'closed' };

    // The dev token plus the sibling's (derivable) key no longer works.
    expect(
      (
        await POST(
          request(null, body, {
            authorization: 'Bearer public-dev-token',
            'x-learner-key': ownerIdForLogin(SIBLING),
          }),
        )
      ).status,
    ).toBe(401);
    // Another signed-in member claiming the sibling's key is still themselves.
    expect(
      (await POST(request(KID, body, { 'x-learner-key': ownerIdForLogin(SIBLING) }))).status,
    ).toBe(404);
    expect((await POST(request(SIBLING, body))).status).toBe(204);
    await expect(pending).resolves.toBe('closed');
  });
});

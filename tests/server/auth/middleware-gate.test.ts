import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { signedIdentityHeaders } from '@/lib/server/auth/signed-identity';
import { middleware } from '@/middleware';

const request = (path: string, headers: Record<string, string> = {}) =>
  new NextRequest(`http://localhost${path}`, { headers });

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('signed-header sign-in middleware gate', () => {
  it('is inert when the build has sign-in off', async () => {
    vi.stubEnv('NEXT_PUBLIC_AUTH_MODE', '');
    expect((await middleware(request('/api/stages'))).status).toBe(200);
    expect((await middleware(request('/'))).status).toBe(200);
  });

  describe('with sign-in on', () => {
    it('answers 401 JSON for APIs and a notice page for pages without an identity', async () => {
      vi.stubEnv('NEXT_PUBLIC_AUTH_MODE', 'signed-header');
      const api = await middleware(request('/api/stages'));
      expect(api.status).toBe(401);
      await expect(api.json()).resolves.toMatchObject({ errorCode: 'AUTH_REQUIRED' });

      const page = await middleware(request('/classroom/abc'));
      expect(page.status).toBe(401);
      expect(page.headers.get('content-type')).toContain('text/html');
      await expect(page.text()).resolves.toContain('Tailscale');
    });

    it('keeps the health check open and passes any request carrying a signature', async () => {
      vi.stubEnv('NEXT_PUBLIC_AUTH_MODE', 'signed-header');
      expect((await middleware(request('/api/health'))).status).toBe(200);
      // Presence only: the route verifies (a forged value is refused there).
      const signed = await middleware(
        request('/api/stages', { 'x-openmaic-identity-signature': 'forged' }),
      );
      expect(signed.status).toBe(200);
    });

    it('lets a Bearer token through to the skill API only', async () => {
      vi.stubEnv('NEXT_PUBLIC_AUTH_MODE', 'signed-header');
      const bearer = { authorization: 'Bearer something' };
      for (const path of [
        '/api/generate-classroom',
        '/api/generate-classroom/job1',
        '/api/classroom',
        '/api/classroom-media/c1/media/a.png',
      ]) {
        expect((await middleware(request(path, bearer))).status).toBe(200);
      }
      expect((await middleware(request('/api/stages', bearer))).status).toBe(401);
      expect((await middleware(request('/api/persistence/documents/x', bearer))).status).toBe(401);
    });

    it('verifies the signature itself when the secret is visible', async () => {
      const secret = 'm'.repeat(48);
      vi.stubEnv('NEXT_PUBLIC_AUTH_MODE', 'signed-header');
      vi.stubEnv('AUTH_IDENTITY_SECRET', secret);
      const good = signedIdentityHeaders({ login: 'kid@x.y', name: '小明' }, secret);
      expect((await middleware(request('/api/chat', good))).status).toBe(200);

      const forged = signedIdentityHeaders({ login: 'kid@x.y' }, 'f'.repeat(48));
      expect((await middleware(request('/api/chat', forged))).status).toBe(401);
      expect((await middleware(request('/', forged))).status).toBe(401);
      const stale = signedIdentityHeaders(
        { login: 'kid@x.y', timestamp: Math.floor(Date.now() / 1000) - 3600 },
        secret,
      );
      expect((await middleware(request('/api/chat', stale))).status).toBe(401);
    });

    it('refuses unsafe cross-site requests even with a valid identity', async () => {
      const secret = 'm'.repeat(48);
      vi.stubEnv('NEXT_PUBLIC_AUTH_MODE', 'signed-header');
      vi.stubEnv('AUTH_IDENTITY_SECRET', secret);
      const headers = signedIdentityHeaders({ login: 'kid@x.y' }, secret);
      const post = (extra: Record<string, string>) =>
        middleware(
          new NextRequest('http://localhost/api/agent/sessions', {
            method: 'POST',
            headers: { ...headers, ...extra },
          }),
        );
      expect((await post({ 'sec-fetch-site': 'cross-site' })).status).toBe(403);
      expect((await post({ origin: 'https://evil.example' })).status).toBe(403);
      expect((await post({ 'sec-fetch-site': 'same-origin' })).status).toBe(200);
      expect((await post({})).status).toBe(200);
    });
  });
});

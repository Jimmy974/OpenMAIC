import { afterEach, describe, expect, it, vi } from 'vitest';

import vectors from '@/tests/fixtures/signed-identity-vectors.json';
import {
  IDENTITY_HEADERS,
  normalizeLogin,
  ownerIdForLogin,
  parseAdminLogins,
  readRequestIdentity,
  requireRequestIdentity,
  signedIdentityHeaders,
  UnauthenticatedError,
  verifySignedIdentity,
} from '@/lib/server/auth/signed-identity';

type Vector = (typeof vectors.vectors)[number];

function headersFor(vector: Vector): Headers {
  const headers = new Headers();
  const values = vector.headers as Record<string, string | undefined>;
  for (const field of ['login', 'name', 'avatar', 'timestamp', 'signature'] as const) {
    const value = values[field];
    if (value !== undefined) headers.set(IDENTITY_HEADERS[field], value);
  }
  return headers;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('shared signed-identity vectors', () => {
  it.each(vectors.vectors.map((vector) => [vector.name, vector] as const))(
    '%s',
    (_name, vector) => {
      const result = verifySignedIdentity(headersFor(vector), {
        secret: vectors.secret,
        adminLogins: new Set(['parent@example.com']),
        maxSkewSeconds: vectors.maxSkewSeconds,
        now: vectors.now,
      });
      const expected = vector.expect as {
        ok: boolean;
        reason?: string;
        login?: string;
        name?: string;
        avatarUrl?: string | null;
        ownerId?: string;
      };
      if (!expected.ok) {
        expect(result).toEqual({ ok: false, reason: expected.reason });
        return;
      }
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.identity).toEqual({
        login: expected.login,
        name: expected.name,
        avatarUrl: expected.avatarUrl,
        ownerId: expected.ownerId,
        learnerKey: expected.ownerId,
        isAdmin: expected.login === 'parent@example.com',
      });
    },
  );
});

describe('owner ids and logins', () => {
  it('derives a 37-character acct_ id from the normalised login', () => {
    const id = ownerIdForLogin('  Parent@Example.COM ');
    expect(id).toBe(ownerIdForLogin('parent@example.com'));
    expect(id).toMatch(/^acct_[0-9a-f]{32}$/);
    expect(id).toHaveLength(37);
  });

  it('parses admin logins, ignoring blanks and case', () => {
    expect([...parseAdminLogins(' Parent@Example.com, ,kid@x.y ,')]).toEqual([
      'parent@example.com',
      'kid@x.y',
    ]);
    expect(parseAdminLogins(undefined).size).toBe(0);
    expect(normalizeLogin(' A@B ')).toBe('a@b');
  });

  it('refuses a present signature without a login, and a non-https avatar is not shown', () => {
    const secret = vectors.secret;
    const signed = signedIdentityHeaders(
      { login: 'x@y.z', avatar: 'http://insecure.example/a.png', timestamp: vectors.now },
      secret,
    );
    const result = verifySignedIdentity(new Headers(signed), {
      secret,
      adminLogins: new Set(),
      now: vectors.now,
    });
    expect(result.ok && result.identity.avatarUrl).toBeNull();

    const headers = new Headers(signed);
    headers.delete(IDENTITY_HEADERS.login);
    expect(
      verifySignedIdentity(headers, { secret, adminLogins: new Set(), now: vectors.now }),
    ).toEqual({ ok: false, reason: 'malformed' });
  });

  it('treats a forged Tailscale-User-Login header as no identity at all', () => {
    const headers = new Headers({ 'tailscale-user-login': 'parent@example.com' });
    expect(
      verifySignedIdentity(headers, {
        secret: vectors.secret,
        adminLogins: new Set(),
        now: vectors.now,
      }),
    ).toEqual({ ok: false, reason: 'absent' });
  });
});

describe('request identity from the server configuration', () => {
  const secret = 'x'.repeat(40);

  function enable() {
    vi.stubEnv('AUTH_MODE', 'signed-header');
    vi.stubEnv('AUTH_IDENTITY_SECRET', secret);
    vi.stubEnv('AUTH_ADMIN_LOGINS', 'parent@example.com');
  }

  it('is null and never verifies with sign-in off', () => {
    vi.stubEnv('AUTH_MODE', '');
    const headers = new Headers(signedIdentityHeaders({ login: 'parent@example.com' }, secret));
    expect(readRequestIdentity(headers)).toBeNull();
    expect(() => requireRequestIdentity(headers)).toThrow(UnauthenticatedError);
  });

  it('verifies with the configured secret and admin list', () => {
    enable();
    const identity = readRequestIdentity(
      new Headers(signedIdentityHeaders({ login: 'Parent@Example.com', name: '爸爸' }, secret)),
    );
    expect(identity).toMatchObject({
      login: 'parent@example.com',
      name: '爸爸',
      isAdmin: true,
      ownerId: ownerIdForLogin('parent@example.com'),
    });
  });

  it('refuses a stale identity and logs the reason without the header values', () => {
    enable();
    vi.stubEnv('AUTH_MAX_SKEW_SECONDS', '60');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const headers = new Headers(
      signedIdentityHeaders(
        { login: 'kid@example.com', timestamp: Math.floor(Date.now() / 1000) - 120 },
        secret,
      ),
    );
    expect(readRequestIdentity(headers)).toBeNull();
    expect(() => requireRequestIdentity(headers)).toThrow(UnauthenticatedError);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('kid@example.com');
  });

  it('refuses everything when the configured secret is too short', () => {
    enable();
    vi.stubEnv('AUTH_IDENTITY_SECRET', 'short');
    const headers = new Headers(signedIdentityHeaders({ login: 'parent@example.com' }, 'short'));
    expect(readRequestIdentity(headers)).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';

import { validateAuthConfig, type AuthConfigInput } from '@/lib/server/auth/config';

const valid: AuthConfigInput = {
  AUTH_MODE: 'signed-header',
  NEXT_PUBLIC_AUTH_MODE: 'signed-header',
  NEXT_PUBLIC_PERSISTENCE: '1',
  DATABASE_URL: 'postgres://db/openmaic',
  AUTH_IDENTITY_SECRET: 'a'.repeat(64),
  AUTH_ADMIN_LOGINS: 'parent@example.com',
};

describe('validateAuthConfig', () => {
  it('accepts the feature off, with nothing set', () => {
    expect(() => validateAuthConfig({})).not.toThrow();
    expect(() =>
      validateAuthConfig({ AUTH_MODE: ' ', NEXT_PUBLIC_AUTH_MODE: '', DATABASE_URL: '' }),
    ).not.toThrow();
  });

  it('accepts a complete sign-in configuration', () => {
    expect(() => validateAuthConfig(valid)).not.toThrow();
    expect(() =>
      validateAuthConfig({
        ...valid,
        AUTH_MAX_SKEW_SECONDS: '120',
        AUTH_SERVICE_TOKEN: 't'.repeat(40),
        AUTH_SERVICE_OWNER_LOGIN: 'parent@example.com',
      }),
    ).not.toThrow();
  });

  it.each<[string, AuthConfigInput, RegExp]>([
    [
      'unknown mode',
      { ...valid, AUTH_MODE: 'oidc', NEXT_PUBLIC_AUTH_MODE: 'oidc' },
      /not supported/,
    ],
    ['runtime on, build off', { ...valid, NEXT_PUBLIC_AUTH_MODE: undefined }, /must match/],
    ['build on, runtime off', { ...valid, AUTH_MODE: undefined }, /must match/],
    [
      'no persistence build',
      { ...valid, NEXT_PUBLIC_PERSISTENCE: undefined },
      /NEXT_PUBLIC_PERSISTENCE=1/,
    ],
    ['no database', { ...valid, DATABASE_URL: ' ' }, /DATABASE_URL/],
    ['missing secret', { ...valid, AUTH_IDENTITY_SECRET: undefined }, /at least 32 bytes/],
    ['short secret', { ...valid, AUTH_IDENTITY_SECRET: 'x'.repeat(31) }, /at least 32 bytes/],
    ['empty admin list', { ...valid, AUTH_ADMIN_LOGINS: ' , ' }, /AUTH_ADMIN_LOGINS/],
    [
      'shared owner',
      { ...valid, PERSISTENCE_SHARED_OWNER_ID: 'family' },
      /PERSISTENCE_SHARED_OWNER_ID/,
    ],
    ['bad skew', { ...valid, AUTH_MAX_SKEW_SECONDS: '0' }, /AUTH_MAX_SKEW_SECONDS/],
    [
      'short service token',
      { ...valid, AUTH_SERVICE_TOKEN: 'short', AUTH_SERVICE_OWNER_LOGIN: 'p@x' },
      /AUTH_SERVICE_TOKEN/,
    ],
    [
      'service token without owner',
      { ...valid, AUTH_SERVICE_TOKEN: 't'.repeat(40) },
      /AUTH_SERVICE_OWNER_LOGIN/,
    ],
  ])('fails boot: %s', (_name, env, message) => {
    expect(() => validateAuthConfig(env)).toThrow(message);
  });
});

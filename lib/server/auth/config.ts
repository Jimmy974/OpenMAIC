/**
 * Startup validation for signed-header sign-in (design §1, decisions D18/D19).
 *
 * Called from `instrumentation.ts` before the server is ready, so a
 * misconfigured deployment fails to boot instead of answering every request
 * with 401 or, worse, silently splitting learner data between device and
 * account keys. With `AUTH_MODE` and `NEXT_PUBLIC_AUTH_MODE` both unset this
 * is a no-op: upstream behaviour is unchanged.
 */
import { AUTH_MODE_SIGNED_HEADER, MIN_SECRET_BYTES, parseAdminLogins } from './signed-identity';

export interface AuthConfigInput {
  AUTH_MODE?: string;
  AUTH_IDENTITY_SECRET?: string;
  AUTH_ADMIN_LOGINS?: string;
  AUTH_MAX_SKEW_SECONDS?: string;
  AUTH_SERVICE_TOKEN?: string;
  AUTH_SERVICE_OWNER_LOGIN?: string;
  PERSISTENCE_SHARED_OWNER_ID?: string;
  DATABASE_URL?: string;
  /** The build-inlined value; see `lib/auth/public-mode.ts`. */
  NEXT_PUBLIC_AUTH_MODE?: string;
  /** The build-inlined value. */
  NEXT_PUBLIC_PERSISTENCE?: string;
}

function present(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** Throws with a message naming the variables when the combination cannot work. */
export function validateAuthConfig(env: AuthConfigInput): void {
  const mode = present(env.AUTH_MODE);
  const publicMode = present(env.NEXT_PUBLIC_AUTH_MODE);

  if (mode === undefined && publicMode === undefined) return;

  if (mode !== undefined && mode !== AUTH_MODE_SIGNED_HEADER) {
    throw new Error(
      `AUTH_MODE=${JSON.stringify(mode)} is not supported; the only mode is ` +
        `"${AUTH_MODE_SIGNED_HEADER}". Unset AUTH_MODE to run without sign-in.`,
    );
  }
  if (mode !== publicMode) {
    throw new Error(
      `AUTH_MODE (${JSON.stringify(mode ?? '')}) and the build-time NEXT_PUBLIC_AUTH_MODE ` +
        `(${JSON.stringify(publicMode ?? '')}) must match. Rebuild the image with ` +
        'NEXT_PUBLIC_AUTH_MODE set to the same value, or change AUTH_MODE. A mismatch sends ' +
        'learner data to the wrong partition.',
    );
  }
  if (env.NEXT_PUBLIC_PERSISTENCE?.trim() !== '1') {
    throw new Error(
      'NEXT_PUBLIC_AUTH_MODE requires a build with NEXT_PUBLIC_PERSISTENCE=1: members, shares ' +
        'and cross-device quiz results live in server persistence.',
    );
  }
  if (!present(env.DATABASE_URL)) {
    throw new Error('AUTH_MODE requires DATABASE_URL (server persistence).');
  }
  if (Buffer.byteLength(env.AUTH_IDENTITY_SECRET ?? '', 'utf8') < MIN_SECRET_BYTES) {
    throw new Error(
      `AUTH_IDENTITY_SECRET must be at least ${MIN_SECRET_BYTES} bytes ` +
        '(for example `openssl rand -hex 32`), and identical in the identity bridge.',
    );
  }
  if (parseAdminLogins(env.AUTH_ADMIN_LOGINS).size === 0) {
    throw new Error(
      'AUTH_ADMIN_LOGINS must list at least one login (comma-separated) so a parent can see ' +
        'the Family page.',
    );
  }
  if (present(env.PERSISTENCE_SHARED_OWNER_ID)) {
    throw new Error(
      'AUTH_MODE cannot be combined with PERSISTENCE_SHARED_OWNER_ID: sign-in gives every ' +
        'member their own library. Unset PERSISTENCE_SHARED_OWNER_ID.',
    );
  }
  const skew = present(env.AUTH_MAX_SKEW_SECONDS);
  if (skew !== undefined) {
    const parsed = Number(skew);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 3600) {
      throw new Error(`AUTH_MAX_SKEW_SECONDS must be an integer from 1 to 3600, got ${skew}.`);
    }
  }
  const serviceToken = env.AUTH_SERVICE_TOKEN ?? '';
  if (serviceToken !== '') {
    if (Buffer.byteLength(serviceToken, 'utf8') < MIN_SECRET_BYTES) {
      throw new Error(`AUTH_SERVICE_TOKEN must be at least ${MIN_SECRET_BYTES} bytes when set.`);
    }
    if (!present(env.AUTH_SERVICE_OWNER_LOGIN)) {
      throw new Error(
        'AUTH_SERVICE_TOKEN requires AUTH_SERVICE_OWNER_LOGIN: the member who owns the ' +
          'classrooms the skill API creates.',
      );
    }
  }
}

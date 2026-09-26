/**
 * Signed identity: the provider-neutral sign-in contract (design
 * `docs/designs/tailscale-identity-login.md` §1).
 *
 * The app never talks to an identity provider. A trusted front proxy (the
 * identity bridge in `scripts/identity-bridge.mjs` for the Tailscale
 * deployment) reads the provider's identity, and forwards it as five headers
 * signed with a secret the app shares:
 *
 *   X-OpenMAIC-Identity-Login       normalised login (trimmed, lower-case)
 *   X-OpenMAIC-Identity-Name        display name, UTF-8 percent-encoded
 *   X-OpenMAIC-Identity-Avatar      avatar URL, or empty
 *   X-OpenMAIC-Identity-Timestamp   epoch seconds, decimal
 *   X-OpenMAIC-Identity-Signature   lower-case hex HMAC-SHA256
 *
 * The signed input is `v1\n<login>\n<name>\n<avatar>\n<timestamp>` over the
 * values exactly as transmitted, with an absent header read as the empty
 * string. The key is the UTF-8 bytes of `AUTH_IDENTITY_SECRET`. The shared
 * vectors in `tests/fixtures/signed-identity-vectors.json` pin all of this for
 * both this module and the bridge.
 *
 * Everything here is synchronous `node:crypto`, so route handlers and server
 * actions can call it; middleware deliberately does not (see `middleware.ts`).
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const AUTH_MODE_SIGNED_HEADER = 'signed-header';

export const IDENTITY_HEADERS = {
  login: 'x-openmaic-identity-login',
  name: 'x-openmaic-identity-name',
  avatar: 'x-openmaic-identity-avatar',
  timestamp: 'x-openmaic-identity-timestamp',
  signature: 'x-openmaic-identity-signature',
} as const;

export const DEFAULT_MAX_SKEW_SECONDS = 300;
export const MIN_SECRET_BYTES = 32;

const SIGNATURE_PATTERN = /^[0-9a-f]{64}$/;
const TIMESTAMP_PATTERN = /^[0-9]{1,12}$/;
const MAX_LOGIN_LENGTH = 254;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export interface IdentityHeaderValues {
  login: string;
  name: string;
  avatar: string;
  timestamp: string;
}

export interface SignedIdentity {
  /** Normalised login: the stable account key. */
  login: string;
  /** Decoded display name; the login when the proxy sent none. */
  name: string;
  /** An `https:` avatar URL, or null. */
  avatarUrl: string | null;
  /** `acct_` + 32 hex characters; see {@link ownerIdForLogin}. */
  ownerId: string;
  /** The runtime learner partition; the same string as `ownerId`. */
  learnerKey: string;
  isAdmin: boolean;
}

export type IdentityRefusal = 'absent' | 'malformed' | 'stale' | 'bad-signature';

export type IdentityVerification =
  | { ok: true; identity: SignedIdentity }
  | { ok: false; reason: IdentityRefusal };

export interface VerifyOptions {
  secret: string;
  adminLogins: ReadonlySet<string>;
  maxSkewSeconds?: number;
  /** Epoch seconds; defaults to the wall clock. */
  now?: number;
}

/** A request that needs a signed-in member arrived without a valid identity. */
export class UnauthenticatedError extends Error {
  constructor(readonly reason: IdentityRefusal | 'disabled' = 'absent') {
    super(`authentication required (${reason})`);
    this.name = 'UnauthenticatedError';
  }
}

/** Whether this server runs in signed-header mode. Read per call, like the other env gates. */
export function isAuthModeEnabled(): boolean {
  return process.env.AUTH_MODE?.trim() === AUTH_MODE_SIGNED_HEADER;
}

export function normalizeLogin(login: string): string {
  return login.trim().toLowerCase();
}

/**
 * The owner id (and learner key) for a login: `acct_` plus the first 32 hex
 * characters of SHA-256 over the normalised login. 128 bits, never in the
 * `anon:` namespace, and made only of characters the material key sanitiser
 * keeps.
 */
export function ownerIdForLogin(login: string): string {
  const digest = createHash('sha256').update(normalizeLogin(login), 'utf8').digest('hex');
  return `acct_${digest.slice(0, 32)}`;
}

export function canonicalIdentityPayload(values: IdentityHeaderValues): string {
  return `v1\n${values.login}\n${values.name}\n${values.avatar}\n${values.timestamp}`;
}

export function signIdentity(values: IdentityHeaderValues, secret: string): string {
  return createHmac('sha256', Buffer.from(secret, 'utf8'))
    .update(canonicalIdentityPayload(values), 'utf8')
    .digest('hex');
}

/**
 * Header values for a login, signed now. Used by tests and the smoke script;
 * production headers come from the bridge.
 */
export function signedIdentityHeaders(
  identity: { login: string; name?: string; avatar?: string; timestamp?: number },
  secret: string,
): Record<string, string> {
  const values: IdentityHeaderValues = {
    login: normalizeLogin(identity.login),
    name: identity.name ? encodeURIComponent(identity.name) : '',
    avatar: identity.avatar ?? '',
    timestamp: String(identity.timestamp ?? Math.floor(Date.now() / 1000)),
  };
  return {
    [IDENTITY_HEADERS.login]: values.login,
    [IDENTITY_HEADERS.name]: values.name,
    [IDENTITY_HEADERS.avatar]: values.avatar,
    [IDENTITY_HEADERS.timestamp]: values.timestamp,
    [IDENTITY_HEADERS.signature]: signIdentity(values, secret),
  };
}

export function parseAdminLogins(raw: string | undefined): Set<string> {
  const logins = new Set<string>();
  for (const item of (raw ?? '').split(',')) {
    const login = normalizeLogin(item);
    if (login) logins.add(login);
  }
  return logins;
}

function decodeName(encoded: string, login: string): string {
  if (!encoded) return login;
  try {
    const decoded = decodeURIComponent(encoded).trim();
    return decoded && !CONTROL_CHARACTERS.test(decoded) ? decoded : login;
  } catch {
    return login;
  }
}

function displayAvatar(avatar: string): string | null {
  if (!avatar) return null;
  try {
    return new URL(avatar).protocol === 'https:' ? avatar : null;
  } catch {
    return null;
  }
}

function signaturesEqual(expected: string, received: string): boolean {
  return timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(received, 'utf8'));
}

export function verifySignedIdentity(
  headers: Pick<Headers, 'get'>,
  options: VerifyOptions,
): IdentityVerification {
  const signature = headers.get(IDENTITY_HEADERS.signature);
  const rawLogin = headers.get(IDENTITY_HEADERS.login);
  if (signature === null && rawLogin === null) return { ok: false, reason: 'absent' };
  if (signature === null || rawLogin === null) return { ok: false, reason: 'malformed' };

  const values: IdentityHeaderValues = {
    login: rawLogin,
    name: headers.get(IDENTITY_HEADERS.name) ?? '',
    avatar: headers.get(IDENTITY_HEADERS.avatar) ?? '',
    timestamp: headers.get(IDENTITY_HEADERS.timestamp) ?? '',
  };
  const login = normalizeLogin(values.login);
  if (
    !SIGNATURE_PATTERN.test(signature) ||
    !TIMESTAMP_PATTERN.test(values.timestamp) ||
    !login ||
    login.length > MAX_LOGIN_LENGTH ||
    CONTROL_CHARACTERS.test(login)
  ) {
    return { ok: false, reason: 'malformed' };
  }

  // Signature before freshness: an unsigned timestamp says nothing, so the
  // reason reported for a forged stale header is the forgery.
  if (!signaturesEqual(signIdentity(values, options.secret), signature)) {
    return { ok: false, reason: 'bad-signature' };
  }

  const now = options.now ?? Math.floor(Date.now() / 1000);
  const skew = options.maxSkewSeconds ?? DEFAULT_MAX_SKEW_SECONDS;
  if (Math.abs(now - Number(values.timestamp)) > skew) return { ok: false, reason: 'stale' };

  const ownerId = ownerIdForLogin(login);
  return {
    ok: true,
    identity: {
      login,
      name: decodeName(values.name, login),
      avatarUrl: displayAvatar(values.avatar),
      ownerId,
      learnerKey: ownerId,
      isAdmin: options.adminLogins.has(login),
    },
  };
}

function configuredMaxSkewSeconds(): number {
  const raw = process.env.AUTH_MAX_SKEW_SECONDS?.trim();
  if (!raw) return DEFAULT_MAX_SKEW_SECONDS;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_SKEW_SECONDS;
}

let lastLoggedRefusal = 0;

/**
 * The verified identity on this request, using the server's configuration, or
 * null when there is none or it does not verify. Never logs header values:
 * a refusal is logged by reason only, at most once a minute.
 */
export function readRequestIdentity(headers: Pick<Headers, 'get'>): SignedIdentity | null {
  if (!isAuthModeEnabled()) return null;
  const secret = process.env.AUTH_IDENTITY_SECRET ?? '';
  if (Buffer.byteLength(secret, 'utf8') < MIN_SECRET_BYTES) return null;
  const result = verifySignedIdentity(headers, {
    secret,
    adminLogins: parseAdminLogins(process.env.AUTH_ADMIN_LOGINS),
    maxSkewSeconds: configuredMaxSkewSeconds(),
  });
  if (result.ok) return result.identity;
  if (result.reason !== 'absent' && Date.now() - lastLoggedRefusal > 60_000) {
    lastLoggedRefusal = Date.now();
    console.warn(
      `[auth] refused a signed identity (${result.reason}). A "stale" refusal usually means the ` +
        'bridge and app clocks disagree; "bad-signature" means AUTH_IDENTITY_SECRET differs ' +
        'between the bridge and the app, or the headers were forged.',
    );
  }
  return null;
}

/** Like {@link readRequestIdentity}, but throws {@link UnauthenticatedError} when there is none. */
export function requireRequestIdentity(headers: Pick<Headers, 'get'>): SignedIdentity {
  if (!isAuthModeEnabled()) throw new UnauthenticatedError('disabled');
  const identity = readRequestIdentity(headers);
  if (!identity) throw new UnauthenticatedError();
  return identity;
}

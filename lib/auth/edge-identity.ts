/**
 * Middleware-side checks for signed-header sign-in, in Web Crypto so they run
 * in either middleware runtime. Routes still verify with `node:crypto`
 * (`lib/server/auth/signed-identity.ts`); this lets middleware refuse forged
 * identities before they reach routes that do no check of their own (LLM and
 * media routes), whenever the secret is visible to it.
 */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const SIGNATURE_PATTERN = /^[0-9a-f]{64}$/;
const TIMESTAMP_PATTERN = /^[0-9]{1,12}$/;
const encoder = new TextEncoder();

function hexBytes(hex: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/** True when the signed identity headers verify against `secret` and are fresh. */
export async function verifyIdentityHeadersEdge(
  headers: Headers,
  secret: string,
  maxSkewSeconds: number,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  const signature = headers.get('x-openmaic-identity-signature');
  const login = headers.get('x-openmaic-identity-login');
  const timestamp = headers.get('x-openmaic-identity-timestamp') ?? '';
  if (!signature || !login || !SIGNATURE_PATTERN.test(signature)) return false;
  if (!TIMESTAMP_PATTERN.test(timestamp)) return false;
  if (Math.abs(nowSeconds - Number(timestamp)) > maxSkewSeconds) return false;
  const payload =
    `v1\n${login}\n${headers.get('x-openmaic-identity-name') ?? ''}\n` +
    `${headers.get('x-openmaic-identity-avatar') ?? ''}\n${timestamp}`;
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  return crypto.subtle.verify('HMAC', key, hexBytes(signature), encoder.encode(payload));
}

/**
 * Whether an unsafe request came from another site. With sign-in the front
 * proxy attaches the member's identity to every request their browser makes,
 * so a cross-site form post would otherwise act as them.
 */
export function isCrossSiteUnsafeRequest(method: string, headers: Headers): boolean {
  if (SAFE_METHODS.has(method.toUpperCase())) return false;
  const site = headers.get('sec-fetch-site');
  if (site) return site !== 'same-origin' && site !== 'none';
  const origin = headers.get('origin');
  if (origin === null) return false;
  try {
    const originHost = new URL(origin).host;
    return originHost !== headers.get('host') && originHost !== headers.get('x-forwarded-host');
  } catch {
    return true;
  }
}

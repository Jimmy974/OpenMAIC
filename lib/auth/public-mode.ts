/**
 * The build-time half of the sign-in switch (design §1).
 *
 * `NEXT_PUBLIC_AUTH_MODE` is inlined by Next at build time into the client
 * bundle and the server bundle alike, so this is also how server code learns
 * what the browser was built with (startup validation compares it with the
 * runtime `AUTH_MODE`). The literal `process.env.NEXT_PUBLIC_AUTH_MODE` access
 * is what Next replaces, so it must stay spelled out here.
 *
 * With it unset the client makes no auth requests at all.
 */
export const PUBLIC_AUTH_MODE_SIGNED_HEADER = 'signed-header';

export function publicAuthModeBuildValue(): string | undefined {
  const value = process.env.NEXT_PUBLIC_AUTH_MODE?.trim();
  return value ? value : undefined;
}

export function isClientAuthModeEnabled(): boolean {
  return publicAuthModeBuildValue() === PUBLIC_AUTH_MODE_SIGNED_HEADER;
}

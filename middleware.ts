import { NextRequest, NextResponse } from 'next/server';

import { isCrossSiteUnsafeRequest, verifyIdentityHeadersEdge } from '@/lib/auth/edge-identity';
import { isClientAuthModeEnabled } from '@/lib/auth/public-mode';
import { isAgentRuntimeConfigured, isProWorkbenchEnabled } from '@/lib/config/feature-flags';
import { verifyAccessTokenEdge } from '@/lib/server/access-token-edge';

const IDENTITY_SIGNATURE_HEADER = 'x-openmaic-identity-signature';

/** The skill API, which an external client may call with the service token (D18). */
function isSkillApiPath(pathname: string): boolean {
  return (
    pathname === '/api/generate-classroom' ||
    pathname.startsWith('/api/generate-classroom/') ||
    pathname === '/api/classroom' ||
    pathname.startsWith('/api/classroom-media/')
  );
}

const SIGN_IN_NOTICE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in through Tailscale</title>
<style>body{font-family:system-ui,sans-serif;max-width:34rem;margin:15vh auto;padding:0 1rem;line-height:1.6;color:#1f2937}
h1{font-size:1.4rem}code{background:#f3f4f6;padding:.1rem .3rem;border-radius:.25rem}</style></head>
<body><h1>Open this site through Tailscale while signed in</h1>
<p>OpenMAIC here knows who you are from your Tailscale sign-in. Open it from a device that is signed in to Tailscale with your own account (not a shared or tagged device).</p>
<p lang="zh-Hant">請喺已經用你自己 Tailscale 帳戶登入嘅裝置打開呢個網址。</p></body></html>`;

function configuredSkewSeconds(): number {
  const parsed = Number(process.env.AUTH_MAX_SKEW_SECONDS);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 300;
}

/**
 * Signed-header sign-in's gate (design §3). Routes verify the identity
 * themselves; this turns the "not signed in" case into a readable page and,
 * when the secret is visible to middleware, refuses forged or stale
 * identities before they reach routes that do no check of their own. Where
 * it is not visible, only the presence of a signature is checked.
 *
 * It also refuses unsafe cross-site requests: the front proxy signs every
 * request a member's browser makes, whichever site started it.
 */
async function signInGate(request: NextRequest): Promise<NextResponse | undefined> {
  if (!isClientAuthModeEnabled()) return undefined;
  const { pathname } = request.nextUrl;
  if (pathname === '/api/health') return undefined;
  if (isCrossSiteUnsafeRequest(request.method, request.headers)) {
    return NextResponse.json(
      { success: false, errorCode: 'CROSS_SITE_REQUEST', error: 'Cross-site request refused' },
      { status: 403 },
    );
  }
  if (isSkillApiPath(pathname) && request.headers.get('authorization')?.startsWith('Bearer ')) {
    return undefined;
  }
  if (request.headers.has(IDENTITY_SIGNATURE_HEADER)) {
    const secret = process.env.AUTH_IDENTITY_SECRET ?? '';
    if (
      new TextEncoder().encode(secret).length < 32 ||
      (await verifyIdentityHeadersEdge(request.headers, secret, configuredSkewSeconds()))
    ) {
      return undefined;
    }
  }
  if (pathname.startsWith('/api/')) {
    return NextResponse.json(
      { success: false, errorCode: 'AUTH_REQUIRED', error: 'Sign-in required' },
      { status: 401 },
    );
  }
  return new NextResponse(SIGN_IN_NOTICE, {
    status: 401,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Return an actual server-side 404 when either half of the workbench is off.
  // Edge middleware cannot reliably inspect server-only deployment variables,
  // so it enforces the public gate and leaves the complete runtime/database
  // check to Node. A Node-hosted middleware uses the same gate as startup.
  const canInspectServerRuntime = process.env.NEXT_RUNTIME !== 'edge';
  const workbenchEnabled =
    isProWorkbenchEnabled() && (!canInspectServerRuntime || isAgentRuntimeConfigured());
  if (!workbenchEnabled && (pathname === '/workbench' || pathname.startsWith('/workbench/'))) {
    return new NextResponse('Not found', { status: 404 });
  }

  const signIn = await signInGate(request);
  if (signIn) return signIn;

  const accessCode = process.env.ACCESS_CODE;
  if (!accessCode) {
    return NextResponse.next();
  }

  // Whitelist: access-code endpoints, health check
  if (pathname.startsWith('/api/access-code/') || pathname === '/api/health') {
    return NextResponse.next();
  }

  // Check cookie — validate HMAC signature, not just existence
  const cookie = request.cookies.get('openmaic_access');
  if (cookie?.value && (await verifyAccessTokenEdge(cookie.value, accessCode))) {
    return NextResponse.next();
  }

  // API requests without valid cookie → 401
  if (pathname.startsWith('/api/')) {
    return NextResponse.json(
      { success: false, errorCode: 'INVALID_REQUEST', error: 'Access code required' },
      { status: 401 },
    );
  }

  // Page requests → let through, frontend shows modal
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|logos/).*)'],
};

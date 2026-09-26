import { createHmac } from 'node:crypto';

import type { APIRequestContext, BrowserContext, Page } from '@playwright/test';

const SECRET = process.env.AUTH_IDENTITY_SECRET ?? '';
export const PARENT = (process.env.AUTH_E2E_PARENT_LOGIN ?? '').trim().toLowerCase();
export const STUDENT = 'e2e-student@openmaic.test';
export const THIRD = 'e2e-third@openmaic.test';

export function requireConfig(): void {
  if (Buffer.byteLength(SECRET) < 32 || !PARENT) {
    throw new Error(
      'Set AUTH_IDENTITY_SECRET and AUTH_E2E_PARENT_LOGIN (an AUTH_ADMIN_LOGINS entry)',
    );
  }
}

/** Signed identity headers for a login, exactly as the bridge sends them. */
export function signedHeaders(login: string, name = login.split('@')[0]): Record<string, string> {
  const values = {
    login: login.trim().toLowerCase(),
    name: encodeURIComponent(name),
    avatar: '',
    timestamp: String(Math.floor(Date.now() / 1000)),
  };
  const signature = createHmac('sha256', Buffer.from(SECRET, 'utf8'))
    .update(`v1\n${values.login}\n${values.name}\n${values.avatar}\n${values.timestamp}`, 'utf8')
    .digest('hex');
  return {
    'x-openmaic-identity-login': values.login,
    'x-openmaic-identity-name': values.name,
    'x-openmaic-identity-avatar': values.avatar,
    'x-openmaic-identity-timestamp': values.timestamp,
    'x-openmaic-identity-signature': signature,
  };
}

/** Sign every request this browser context makes as `login` (fresh timestamp each time). */
export async function actAs(context: BrowserContext, login: string, name?: string): Promise<void> {
  await context.route('**/*', (route) =>
    route.continue({ headers: { ...route.request().headers(), ...signedHeaders(login, name) } }),
  );
}

export async function api(
  request: APIRequestContext,
  login: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  data?: unknown,
) {
  return request.fetch(url, {
    method,
    headers: {
      ...signedHeaders(login),
      ...(data === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(data === undefined ? {} : { data: JSON.stringify(data) }),
  });
}

/** A minimal course owned by `login`, created through the persistence API. */
export async function createCourse(
  request: APIRequestContext,
  login: string,
  name: string,
): Promise<string> {
  const id = `e2e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();
  const response = await api(request, login, 'PUT', `/api/persistence/documents/${id}`, {
    stage: { id, name, createdAt: now, updatedAt: now },
    scenes: [],
    outline: {
      outlines: [],
      requirement: name,
      generationComplete: true,
      createdAt: now,
      updatedAt: now,
    },
  });
  if (!response.ok())
    throw new Error(`create course → ${response.status()} ${await response.text()}`);
  return id;
}

export async function deleteCourse(request: APIRequestContext, login: string, id: string) {
  await api(request, login, 'DELETE', `/api/persistence/documents/${id}`);
}

export async function signIn(request: APIRequestContext, login: string) {
  const response = await api(request, login, 'GET', '/api/auth/me');
  if (!response.ok()) throw new Error(`sign in ${login} → ${response.status()}`);
}

export async function openAs(page: Page, login: string, path: string, name?: string) {
  await actAs(page.context(), login, name);
  await page.goto(path);
}

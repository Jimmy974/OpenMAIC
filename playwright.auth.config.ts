import { defineConfig, devices } from '@playwright/test';

/**
 * Signed-header sign-in E2E (docs/auth-signed-identity.md), run against a
 * deployed sign-in build — not part of the default suite, whose dev server
 * has sign-in off. Every request is signed per member with the deployment's
 * secret, the way the identity bridge would.
 *
 *   AUTH_IDENTITY_SECRET=… AUTH_E2E_PARENT_LOGIN=parent@… \
 *   AUTH_E2E_BASE_URL=http://127.0.0.1:3000 pnpm exec playwright test -c playwright.auth.config.ts
 */
export default defineConfig({
  testDir: './e2e/auth',
  testMatch: /auth-.*\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  timeout: 90_000,
  use: {
    baseURL: process.env.AUTH_E2E_BASE_URL ?? 'http://127.0.0.1:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});

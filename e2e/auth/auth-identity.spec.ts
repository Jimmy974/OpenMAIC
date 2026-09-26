import { expect, test } from '@playwright/test';

import { openAs, PARENT, requireConfig, signIn, STUDENT } from './members';

test.beforeAll(() => requireConfig());

test('a request without a signed identity gets the Tailscale notice page', async ({ page }) => {
  const response = await page.goto('/');
  expect(response?.status()).toBe(401);
  await expect(page.getByRole('heading', { name: /through Tailscale/i })).toBeVisible();
});

test('the parent sees their chip, the Parent badge and the Family link', async ({ page }) => {
  await openAs(page, PARENT, '/', 'Parent E2E');
  const chip = page.getByTestId('identity-chip');
  await expect(chip).toBeVisible();
  await expect(chip).toContainText('Parent E2E');
  await expect(page.getByTestId('family-link')).toBeVisible();
});

test('a student sees their own chip without the Family link', async ({ page, request }) => {
  await signIn(request, STUDENT);
  await openAs(page, STUDENT, '/', 'Student E2E');
  await expect(page.getByTestId('identity-chip')).toContainText('Student E2E');
  await expect(page.getByTestId('family-link')).toHaveCount(0);
});

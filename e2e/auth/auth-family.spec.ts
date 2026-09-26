import { expect, test } from '@playwright/test';

import { openAs, PARENT, requireConfig, signIn, STUDENT } from './members';

test.beforeAll(async ({ request }) => {
  requireConfig();
  await signIn(request, PARENT);
  await signIn(request, STUDENT);
});

test('the parent sees members, a member’s courses and quiz results on the Family page', async ({
  page,
}) => {
  await openAs(page, PARENT, '/family');
  await expect(page.getByTestId('family-page')).toBeVisible();
  const members = page.getByTestId('family-members');
  await expect(members).toContainText(STUDENT.split('@')[0]);
  await members.getByText(STUDENT.split('@')[0]).click();
  await expect(page.getByTestId('family-courses')).toBeVisible();
  await expect(page.getByTestId('family-quiz-results')).toBeVisible();
});

test('a student is told the Family page is for parents', async ({ page }) => {
  await openAs(page, STUDENT, '/family');
  await expect(page.getByText(/Only parents can see this page/i)).toBeVisible();
});

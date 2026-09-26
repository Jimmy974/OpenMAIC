import { expect, test } from '@playwright/test';

import {
  api,
  createCourse,
  deleteCourse,
  openAs,
  PARENT,
  requireConfig,
  signIn,
  STUDENT,
  THIRD,
} from './members';

let courseId = '';
const courseName = `E2E shared course ${Date.now().toString(36)}`;

test.beforeAll(async ({ request }) => {
  requireConfig();
  await signIn(request, PARENT);
  await signIn(request, STUDENT);
  await signIn(request, THIRD);
  courseId = await createCourse(request, PARENT, courseName);
});

test.afterAll(async ({ request }) => {
  if (courseId) await deleteCourse(request, PARENT, courseId);
});

test('share a course from the classroom header, open it as the recipient, then unshare', async ({
  browser,
  request,
}) => {
  // Before sharing: the student cannot read it.
  expect(
    (await api(request, STUDENT, 'GET', `/api/persistence/documents/${courseId}`)).status(),
  ).toBe(404);

  const parent = await browser.newPage();
  await openAs(parent, PARENT, `/classroom/${courseId}`);
  const shareButton = parent.getByTestId('share-course-button');
  await expect(shareButton).toBeVisible({ timeout: 30_000 });
  await shareButton.click();
  await parent.getByTestId('share-member-select').selectOption(STUDENT);
  await parent.getByTestId('share-add').click();
  await expect(parent.getByTestId('share-recipients')).toContainText(STUDENT);

  const student = await browser.newPage();
  await openAs(student, STUDENT, '/');
  const shared = student.getByTestId('shared-with-me');
  await expect(shared).toContainText(courseName, { timeout: 30_000 });
  await shared.getByText(courseName).click();
  await expect(student).toHaveURL(new RegExp(`/classroom/${courseId}`));
  // A recipient reads; only the owner gets the Share button.
  expect(
    (await api(request, STUDENT, 'GET', `/api/persistence/documents/${courseId}`)).status(),
  ).toBe(200);
  await expect(student.getByTestId('share-course-button')).toHaveCount(0);

  // A third member still cannot read it.
  expect(
    (await api(request, THIRD, 'GET', `/api/persistence/documents/${courseId}`)).status(),
  ).toBe(404);

  await parent.getByRole('button', { name: new RegExp(`${STUDENT.split('@')[0]}`) }).click();
  await expect(parent.getByTestId('share-recipients')).toHaveCount(0);
  expect(
    (await api(request, STUDENT, 'GET', `/api/persistence/documents/${courseId}`)).status(),
  ).toBe(404);
});

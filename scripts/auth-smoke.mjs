#!/usr/bin/env node
/**
 * Live smoke test for signed-header sign-in (docs/auth-signed-identity.md).
 * Signs requests for three members directly with the deployment secret and
 * checks the access matrix against a running app (design success criteria).
 *
 *   AUTH_IDENTITY_SECRET=… AUTH_SMOKE_PARENT_LOGIN=parent@… \
 *     node scripts/auth-smoke.mjs [base-url, default http://127.0.0.1:3000]
 *
 * Creates one throwaway course as the parent and deletes it at the end. The
 * two synthetic members (smoke-student@openmaic.test, smoke-third@openmaic.test)
 * stay registered; remove them with
 *   DELETE FROM auth_members WHERE login LIKE 'smoke-%@openmaic.test';
 */
import { createHmac } from 'node:crypto';

const base = (process.argv[2] ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
const secret = process.env.AUTH_IDENTITY_SECRET ?? '';
const parent = (process.env.AUTH_SMOKE_PARENT_LOGIN ?? '').trim().toLowerCase();
if (Buffer.byteLength(secret) < 32 || !parent) {
  console.error('Set AUTH_IDENTITY_SECRET and AUTH_SMOKE_PARENT_LOGIN (an admin login).');
  process.exit(2);
}
const student = 'smoke-student@openmaic.test';
const third = 'smoke-third@openmaic.test';

function signed(login, key = secret) {
  const values = {
    login,
    name: encodeURIComponent(login.split('@')[0]),
    avatar: '',
    timestamp: String(Math.floor(Date.now() / 1000)),
  };
  const signature = createHmac('sha256', Buffer.from(key, 'utf8'))
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

async function call(login, method, path, body, extraHeaders = {}) {
  const headers = { ...(login ? signed(login) : {}), ...extraHeaders };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, json };
}

const results = [];
function check(name, actual, expected) {
  const ok = Array.isArray(expected) ? expected.includes(actual) : actual === expected;
  results.push({ ok, name, actual, expected });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (got ${actual}, want ${expected})`);
}

const readPaths = (id) => [
  ['persistence document', `/api/persistence/documents/${id}`],
  ['stage document', `/api/stages/${id}`],
  ['stage-meta', `/api/stage-meta/${id}`],
  ['status', `/api/stages/${id}/status`],
];

async function main() {
  // Unsigned, forged, and Tailscale-forged requests never sign anyone in.
  check('unsigned /api/stages', (await call(null, 'GET', '/api/stages')).status, 401);
  check(
    'forged signature (wrong secret)',
    (await call(null, 'GET', '/api/stages', undefined, signed(parent, 'x'.repeat(40)))).status,
    401,
  );
  check(
    'forged Tailscale-User-Login',
    (
      await call(null, 'GET', '/api/stages', undefined, {
        'tailscale-user-login': parent,
        'x-openmaic-identity-signature': '0'.repeat(64),
      })
    ).status,
    401,
  );

  for (const login of [parent, student, third]) {
    const me = await call(login, 'GET', '/api/auth/me');
    check(`/api/auth/me ${login}`, me.status, 200);
    if (login === parent) check('parent is admin', me.json?.member?.isAdmin, true);
    if (login === student) check('student is not admin', me.json?.member?.isAdmin, false);
  }

  const id = `smoke-${Date.now().toString(36)}`;
  const now = Date.now();
  const created = await call(parent, 'PUT', `/api/persistence/documents/${id}`, {
    stage: { id, name: 'Smoke course', createdAt: now, updatedAt: now },
    scenes: [],
    outline: {
      outlines: [],
      requirement: 'smoke',
      generationComplete: true,
      createdAt: now,
      updatedAt: now,
    },
  });
  check('parent creates a course', created.status, [200, 201, 204]);

  try {
    for (const [name, path] of readPaths(id)) {
      check(`owner reads ${name}`, (await call(parent, 'GET', path)).status, 200);
      check(`student reads unshared ${name}`, (await call(student, 'GET', path)).status, 404);
      check(`third reads unshared ${name}`, (await call(third, 'GET', path)).status, 404);
    }
    check(
      'student cannot list shares',
      (await call(student, 'GET', `/api/stages/${id}/shares`)).status,
      404,
    );

    const shared = await call(parent, 'POST', `/api/stages/${id}/shares`, { login: student });
    check('parent shares with student', shared.status, 200);
    for (const [name, path] of readPaths(id)) {
      check(`student reads shared ${name}`, (await call(student, 'GET', path)).status, 200);
      check(
        `third reads shared-with-student ${name}`,
        (await call(third, 'GET', path)).status,
        404,
      );
    }
    const incoming = await call(student, 'GET', '/api/shares/incoming');
    check(
      'incoming lists the course',
      incoming.json?.shares?.some((s) => s.stageId === id),
      true,
    );
    check(
      'student cannot rename a shared course',
      (await call(student, 'PATCH', `/api/stages/${id}`, { name: 'hijack' })).status >= 400,
      true,
    );

    const members = await call(parent, 'GET', '/api/admin/members');
    check('admin lists members', members.status, 200);
    const studentRow = members.json?.members?.find((m) => m.login === student);
    check('student is on the Family page', Boolean(studentRow), true);
    if (studentRow) {
      check(
        'admin reads student quiz results',
        (await call(parent, 'GET', `/api/admin/members/${studentRow.ownerId}/quiz-results`)).status,
        200,
      );
      check(
        'student cannot read admin routes',
        (await call(student, 'GET', `/api/admin/members/${studentRow.ownerId}/stages`)).status,
        404,
      );
    }
    check(
      'publish is disabled',
      (await call(parent, 'POST', `/api/stages/${id}/publish`)).status,
      404,
    );

    const unshared = await call(
      parent,
      'DELETE',
      `/api/stages/${id}/shares?login=${encodeURIComponent(student)}`,
    );
    check('parent unshares', unshared.status, 200);
    check(
      'student reads after unshare',
      (await call(student, 'GET', `/api/persistence/documents/${id}`)).status,
      404,
    );
  } finally {
    const removed = await call(parent, 'DELETE', `/api/persistence/documents/${id}`);
    check('parent deletes the smoke course', removed.status, [200, 204]);
  }

  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

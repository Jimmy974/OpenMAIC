import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { signedIdentityHeaders, ownerIdForLogin } from '@/lib/server/auth/signed-identity';

const mocks = vi.hoisted(() => ({
  after: vi.fn(),
  buildRequestOrigin: vi.fn(),
  createClassroomGenerationJob: vi.fn(),
  runClassroomGenerationJob: vi.fn(),
  resolveLibraryTarget: vi.fn(),
  getServerProviders: vi.fn(),
}));

vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/server')>();
  return { ...actual, after: mocks.after };
});
vi.mock('@/lib/server/classroom-job-store', () => ({
  createClassroomGenerationJob: mocks.createClassroomGenerationJob,
}));
vi.mock('@/lib/server/classroom-job-runner', () => ({
  runClassroomGenerationJob: mocks.runClassroomGenerationJob,
}));
vi.mock('@/lib/server/classroom-storage', () => ({ buildRequestOrigin: mocks.buildRequestOrigin }));
vi.mock('@/lib/server/auth/library', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/auth/library')>()),
  resolveLibraryTarget: mocks.resolveLibraryTarget,
}));
vi.mock('@/lib/server/provider-config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/provider-config')>()),
  getServerProviders: mocks.getServerProviders,
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const SECRET = 'api-test-secret-0123456789abcdef0123456789ab';
const TOKEN = 'service-token-0123456789abcdef0123456789abcd';

async function post(body: BodyInit, headers: Record<string, string> = {}) {
  const { POST } = await import('@/app/api/generate-classroom/route');
  return POST(
    new NextRequest('http://localhost/api/generate-classroom', { method: 'POST', headers, body }),
  );
}

function multipart(fields: Record<string, unknown>, files: File[] = []) {
  const form = new FormData();
  form.set('request', JSON.stringify(fields));
  for (const file of files) form.append('files', file);
  return form;
}

beforeEach(() => {
  vi.resetModules();
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.buildRequestOrigin.mockReturnValue('http://localhost');
  mocks.createClassroomGenerationJob.mockResolvedValue({
    status: 'queued',
    step: 'queued',
    message: 'queued',
  });
  mocks.getServerProviders.mockReturnValue({
    openai: { models: ['grok-4.7-low', 'grok-4.7-medium', 'grok-4.7-high'] },
  });
});
afterEach(() => vi.unstubAllEnvs());

describe('POST /api/generate-classroom with attachments, model and profile', () => {
  it('accepts multipart files and reports what was read', async () => {
    const res = await post(
      multipart(
        { requirement: 'Teach this', model: 'grok-4.7-medium', studentProfile: ' UK Year 8 ' },
        [new File(['Negative numbers: 5 + (-3) = 2'], 'notes.txt', { type: 'text/plain' })],
      ),
    );
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.attachments).toEqual({ files: 1, textChars: 30, images: 0 });
    const input = mocks.createClassroomGenerationJob.mock.calls[0]![1];
    expect(input).toMatchObject({
      requirement: 'Teach this',
      modelString: 'openai:grok-4.7-medium',
      studentProfile: 'UK Year 8',
      jobId: body.jobId,
    });
    expect(input.attachments.text).toContain('5 + (-3) = 2');
    expect(mocks.after).toHaveBeenCalledOnce();
  });

  it('accepts JSON with base64 attachments', async () => {
    const res = await post(
      JSON.stringify({
        requirement: 'Teach this',
        attachments: [{ name: 'a.md', data: Buffer.from('# Fractions').toString('base64') }],
      }),
      { 'content-type': 'application/json' },
    );
    expect(res.status).toBe(202);
    expect((await res.json()).attachments.files).toBe(1);
  });

  it('rejects unknown models, bad profiles, unsupported files and too many files', async () => {
    const bad = await post(multipart({ requirement: 'x', model: 'gpt-9' }));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(
      /model must be one of: grok-4.7-low, grok-4.7-medium, grok-4.7-high/,
    );

    expect(
      (await post(multipart({ requirement: 'x', model: 'openai:grok-4.7-high' }))).status,
    ).toBe(202);
    expect((await post(multipart({ requirement: 'x', studentProfile: 5 }))).status).toBe(400);
    const ppt = await post(multipart({ requirement: 'x' }, [new File(['x'], 'old.ppt')]));
    expect(ppt.status).toBe(400);
    expect((await ppt.json()).error).toMatch(/\.pptx/);
    const many = await post(
      multipart(
        { requirement: 'x' },
        Array.from({ length: 6 }, (_, i) => new File(['x'], `${i}.txt`)),
      ),
    );
    expect(many.status).toBe(400);
    expect(mocks.createClassroomGenerationJob).toHaveBeenCalledTimes(1);
  });

  it('refuses owner/shareWith with sign-in off', async () => {
    const res = await post(multipart({ requirement: 'x', shareWith: ['a@b.c'] }));
    expect(res.status).toBe(400);
  });

  describe('with sign-in on', () => {
    beforeEach(() => {
      vi.stubEnv('AUTH_MODE', 'signed-header');
      vi.stubEnv('AUTH_IDENTITY_SECRET', SECRET);
      vi.stubEnv('AUTH_ADMIN_LOGINS', 'parent@example.com');
      vi.stubEnv('AUTH_SERVICE_TOKEN', TOKEN);
      vi.stubEnv('AUTH_SERVICE_OWNER_LOGIN', 'parent@example.com');
    });

    it('defaults the owner to the service owner for the token and to the caller for an admin', async () => {
      mocks.resolveLibraryTarget.mockImplementation(async ({ defaultOwnerId }) => ({
        ownerId: defaultOwnerId,
        shareWithOwnerIds: [],
      }));
      await post(multipart({ requirement: 'x', shareWith: ['kid@example.com'] }), {
        authorization: `Bearer ${TOKEN}`,
      });
      expect(mocks.resolveLibraryTarget).toHaveBeenLastCalledWith({
        defaultOwnerId: ownerIdForLogin('parent@example.com'),
        owner: undefined,
        shareWith: ['kid@example.com'],
      });
      expect(mocks.createClassroomGenerationJob.mock.calls[0]![1].library).toEqual({
        ownerId: ownerIdForLogin('parent@example.com'),
        shareWithOwnerIds: [],
      });

      vi.stubEnv('AUTH_ADMIN_LOGINS', 'parent@example.com,other-parent@example.com');
      await post(
        multipart({ requirement: 'x' }),
        signedIdentityHeaders({ login: 'other-parent@example.com' }, SECRET),
      );
      expect(mocks.resolveLibraryTarget.mock.calls.at(-1)![0].defaultOwnerId).toBe(
        ownerIdForLogin('other-parent@example.com'),
      );
    });

    it('turns a library target error into 400 and still refuses non-admins and no credentials', async () => {
      const { LibraryTargetError } = await import('@/lib/server/auth/library');
      mocks.resolveLibraryTarget.mockRejectedValue(
        new LibraryTargetError('shareWith: "x" has not opened the site yet'),
      );
      const res = await post(multipart({ requirement: 'x', shareWith: ['x@y.z'] }), {
        authorization: `Bearer ${TOKEN}`,
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/has not opened the site/);

      expect((await post(multipart({ requirement: 'x' }))).status).toBe(401);
      expect(
        (
          await post(
            multipart({ requirement: 'x' }),
            signedIdentityHeaders({ login: 'kid@example.com' }, SECRET),
          )
        ).status,
      ).toBe(404);
    });
  });
});

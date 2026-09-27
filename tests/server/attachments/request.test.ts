import { describe, expect, it } from 'vitest';

import { readClassroomRequest } from '@/lib/server/attachments/request';

describe('classroom API request body', () => {
  it('reads multipart: a JSON request part and repeated files', async () => {
    const form = new FormData();
    form.set('request', JSON.stringify({ requirement: 'Teach this', model: 'm1' }));
    form.append('files', new File(['hello'], 'a.txt', { type: 'text/plain' }));
    form.append('files', new File([new Uint8Array([1, 2, 3])], 'b.png', { type: 'image/png' }));
    const body = await readClassroomRequest(
      new Request('http://x/api', { method: 'POST', body: form }),
    );
    expect(body.fields).toEqual({ requirement: 'Teach this', model: 'm1' });
    expect(body.files.map((file) => [file.name, file.mimeType, file.bytes.byteLength])).toEqual([
      ['a.txt', 'text/plain', 5],
      ['b.png', 'image/png', 3],
    ]);
  });

  it('reads plain multipart fields when there is no request part', async () => {
    const form = new FormData();
    form.set('requirement', 'Teach fractions');
    const body = await readClassroomRequest(
      new Request('http://x/api', { method: 'POST', body: form }),
    );
    expect(body.fields).toEqual({ requirement: 'Teach fractions' });
  });

  it('reads JSON with base64 attachments', async () => {
    const body = await readClassroomRequest(
      new Request('http://x/api', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          requirement: 'Teach this',
          attachments: [
            { name: 'a.txt', mimeType: 'text/plain', data: Buffer.from('hi').toString('base64') },
          ],
        }),
      }),
    );
    expect(body.fields).toEqual({ requirement: 'Teach this' });
    expect(body.files[0]).toMatchObject({ name: 'a.txt', mimeType: 'text/plain' });
    expect(body.files[0]!.bytes.toString()).toBe('hi');
  });

  it('rejects bad bodies with a message', async () => {
    const post = (body: string, type = 'application/json') =>
      readClassroomRequest(
        new Request('http://x/api', { method: 'POST', headers: { 'content-type': type }, body }),
      );
    await expect(post('{')).rejects.toThrow(/Invalid JSON/);
    await expect(post('[]')).rejects.toThrow(/JSON object/);
    await expect(
      post(JSON.stringify({ attachments: [{ name: 'a', data: '***' }] })),
    ).rejects.toThrow(/base64/);
    await expect(post(JSON.stringify({ attachments: {} }))).rejects.toThrow(/array/);
    const form = new FormData();
    form.set('request', 'not json');
    await expect(
      readClassroomRequest(new Request('http://x/api', { method: 'POST', body: form })),
    ).rejects.toThrow(/JSON object/);
  });
});

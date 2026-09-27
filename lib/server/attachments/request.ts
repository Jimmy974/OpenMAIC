/**
 * Request body for `POST /api/generate-classroom`, in either shape:
 *
 * - `multipart/form-data`: a `request` part holding the JSON fields, and
 *   repeated `files` parts;
 * - `application/json`: the fields, plus optional
 *   `attachments: [{ name, mimeType?, data: <base64> }]`.
 */
import { AttachmentError, type AttachmentFile, MAX_ATTACHMENT_FILES } from './extract';

export interface ClassroomRequestBody {
  fields: Record<string, unknown>;
  files: AttachmentFile[];
}

const BASE64 = /^[A-Za-z0-9+/\s]*={0,2}\s*$/;

function jsonAttachments(value: unknown): AttachmentFile[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new AttachmentError('attachments must be an array');
  if (value.length > MAX_ATTACHMENT_FILES) {
    throw new AttachmentError(`At most ${MAX_ATTACHMENT_FILES} files per classroom`);
  }
  return value.map((item, index) => {
    const entry = item as { name?: unknown; mimeType?: unknown; data?: unknown };
    if (!entry || typeof entry !== 'object') {
      throw new AttachmentError(`attachments[${index}] must be an object`);
    }
    if (typeof entry.name !== 'string' || !entry.name.trim()) {
      throw new AttachmentError(`attachments[${index}].name is required`);
    }
    if (typeof entry.data !== 'string' || !BASE64.test(entry.data)) {
      throw new AttachmentError(`attachments[${index}].data must be base64`);
    }
    return {
      name: entry.name.trim(),
      ...(typeof entry.mimeType === 'string' ? { mimeType: entry.mimeType } : {}),
      bytes: Buffer.from(entry.data.replace(/\s/g, ''), 'base64'),
    };
  });
}

export async function readClassroomRequest(req: Request): Promise<ClassroomRequestBody> {
  const contentType = req.headers.get('content-type') ?? '';
  if (contentType.includes('multipart/form-data')) {
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      throw new AttachmentError('Invalid multipart/form-data body');
    }
    const raw = form.get('request');
    let fields: Record<string, unknown> = {};
    if (typeof raw === 'string' && raw.trim()) {
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
        fields = parsed as Record<string, unknown>;
      } catch {
        throw new AttachmentError('The "request" part must be a JSON object');
      }
    } else {
      // Plain form fields are accepted too (requirement=...).
      for (const [key, value] of form.entries()) {
        if (typeof value === 'string' && key !== 'request') fields[key] = value;
      }
    }
    const uploads = form
      .getAll('files')
      .filter((value): value is File => typeof value !== 'string');
    if (uploads.length > MAX_ATTACHMENT_FILES) {
      throw new AttachmentError(`At most ${MAX_ATTACHMENT_FILES} files per classroom`);
    }
    const files: AttachmentFile[] = [];
    for (const upload of uploads) {
      files.push({
        name: upload.name || 'attachment',
        ...(upload.type ? { mimeType: upload.type } : {}),
        bytes: Buffer.from(await upload.arrayBuffer()),
      });
    }
    return { fields, files };
  }

  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    throw new AttachmentError('Invalid JSON body');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AttachmentError('The body must be a JSON object');
  }
  const { attachments, ...fields } = parsed as Record<string, unknown>;
  return { fields, files: jsonAttachments(attachments) };
}

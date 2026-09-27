/**
 * Attachments for the classroom API (`POST /api/generate-classroom`), read the
 * way the web page reads course material: the text, and the pictures the AI
 * can look at (photographed or scanned worksheets included).
 *
 * Files are merged with the web page's own bundler (`buildDocumentBundle`),
 * so text budgets, image ids (`img_1`…) and the choice of which pictures the
 * model sees are identical to a lesson started from the home page.
 */
import { MAX_PDF_CONTENT_CHARS } from '@/lib/constants/generation';
import { buildDocumentBundle, type ParsedDocumentPart } from '@/lib/document/bundle';
import { prepareDerivedImage } from '@/lib/document/extractors/images';
import { parsePDF } from '@/lib/pdf/pdf-providers';
import type { PdfImage } from '@/lib/types/generation';

import { extractDocx, extractPptx } from './office';

export const MAX_ATTACHMENT_FILES = 5;
export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
export const MAX_ATTACHMENTS_TOTAL_BYTES = 150 * 1024 * 1024;
/** Pictures kept per bundle (the model sees at most MAX_VISION_IMAGES of them). */
const MAX_BUNDLE_PICTURES = 60;

export type AttachmentKind = 'pdf' | 'image' | 'pptx' | 'docx' | 'text';

export interface AttachmentFile {
  name: string;
  mimeType?: string;
  bytes: Buffer;
}

export interface AttachmentBundle {
  /** Merged text with one section per file, capped like the web page's. */
  text: string;
  /** Pictures with `src` as data URLs (for the model), in bundle id order. */
  images: PdfImage[];
  summary: { files: number; textChars: number; images: number };
}

export class AttachmentError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 413 = 400,
  ) {
    super(message);
    this.name = 'AttachmentError';
  }
}

const EXTENSION_KINDS: Record<string, AttachmentKind> = {
  pdf: 'pdf',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  webp: 'image',
  gif: 'image',
  pptx: 'pptx',
  docx: 'docx',
  txt: 'text',
  md: 'text',
  markdown: 'text',
};

const MIME_KINDS: Record<string, AttachmentKind> = {
  'application/pdf': 'pdf',
  'image/png': 'image',
  'image/jpeg': 'image',
  'image/webp': 'image',
  'image/gif': 'image',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'text/plain': 'text',
  'text/markdown': 'text',
  'text/x-markdown': 'text',
};

export function attachmentKind(file: Pick<AttachmentFile, 'name' | 'mimeType'>): AttachmentKind {
  const extension = file.name.toLowerCase().split('.').pop() ?? '';
  const kind =
    EXTENSION_KINDS[extension] ?? MIME_KINDS[(file.mimeType ?? '').split(';')[0]!.trim()];
  if (kind) return kind;
  if (extension === 'ppt' || extension === 'doc') {
    throw new AttachmentError(
      `"${file.name}": old binary .${extension} files are not supported; save it as .${extension}x`,
    );
  }
  throw new AttachmentError(
    `"${file.name}": unsupported file type. Use PDF, PNG/JPEG/WebP/GIF images, PPTX, DOCX, TXT or MD.`,
  );
}

export function assertAttachmentLimits(files: readonly AttachmentFile[]): void {
  if (files.length > MAX_ATTACHMENT_FILES) {
    throw new AttachmentError(`At most ${MAX_ATTACHMENT_FILES} files per classroom`);
  }
  let total = 0;
  for (const file of files) {
    if (file.bytes.byteLength === 0) throw new AttachmentError(`"${file.name}" is empty`);
    if (file.bytes.byteLength > MAX_ATTACHMENT_BYTES) {
      throw new AttachmentError(`"${file.name}" is larger than 50 MB`, 413);
    }
    total += file.bytes.byteLength;
    attachmentKind(file);
  }
  if (total > MAX_ATTACHMENTS_TOTAL_BYTES) {
    throw new AttachmentError('Attachments are larger than 150 MB in total', 413);
  }
}

async function pictureDataUrl(bytes: Buffer): Promise<{
  src: string;
  width?: number;
  height?: number;
} | null> {
  const prepared = await prepareDerivedImage(bytes).catch(() => null);
  if (!prepared) return null;
  return {
    src: `data:${prepared.mime};base64,${prepared.buffer.toString('base64')}`,
    ...(prepared.width ? { width: prepared.width } : {}),
    ...(prepared.height ? { height: prepared.height } : {}),
  };
}

async function picturesToImages(
  pictures: Array<{ bytes: Buffer; pageNumber: number; description?: string }>,
): Promise<ParsedDocumentPart['images']> {
  const images: ParsedDocumentPart['images'] = [];
  for (const [index, picture] of pictures.entries()) {
    const prepared = await pictureDataUrl(picture.bytes);
    if (!prepared) continue;
    images.push({
      id: `pic_${index + 1}`,
      pageNumber: picture.pageNumber,
      ...(picture.description ? { description: picture.description } : {}),
      ...prepared,
    });
  }
  return images;
}

async function extractOne(file: AttachmentFile, order: number): Promise<ParsedDocumentPart> {
  const kind = attachmentKind(file);
  const source = {
    id: `attachment_${order + 1}`,
    name: file.name,
    size: file.bytes.byteLength,
    mimeType: file.mimeType,
    order,
  };

  if (kind === 'text') {
    const text = file.bytes.toString('utf8');
    return { source, text, rawTextLength: text.length, images: [] };
  }

  if (kind === 'image') {
    const images = await picturesToImages([
      { bytes: file.bytes, pageNumber: 1, description: `Picture: ${file.name}` },
    ]);
    if (images.length === 0) throw new AttachmentError(`"${file.name}" is not a readable image`);
    return { source, text: '', rawTextLength: 0, pageCount: 1, images };
  }

  if (kind === 'pdf') {
    const parsed = await parsePDF({ providerId: 'unpdf' }, file.bytes, {
      fileName: file.name,
      mimeType: 'application/pdf',
    }).catch((error: unknown) => {
      throw new AttachmentError(
        `"${file.name}" could not be read as a PDF (${error instanceof Error ? error.message : 'unknown error'})`,
      );
    });
    const pdfImages = parsed.metadata?.pdfImages ?? [];
    const pictures: Array<{ bytes: Buffer; pageNumber: number; description?: string }> = [];
    for (const image of pdfImages) {
      const match = image.src.match(/^data:[^;]+;base64,(.+)$/);
      if (match) {
        pictures.push({
          bytes: Buffer.from(match[1]!, 'base64'),
          pageNumber: image.pageNumber,
          ...(image.description ? { description: image.description } : {}),
        });
      }
    }
    const text = parsed.text ?? '';
    return {
      source,
      text,
      rawTextLength: text.length,
      pageCount: parsed.metadata?.pageCount,
      images: await picturesToImages(pictures.slice(0, MAX_BUNDLE_PICTURES)),
    };
  }

  const office = await (kind === 'pptx' ? extractPptx(file.bytes) : extractDocx(file.bytes)).catch(
    () => {
      throw new AttachmentError(`"${file.name}" could not be read as .${kind}`);
    },
  );
  const text = office.sections
    .map((section) =>
      kind === 'pptx' ? `### ${section.label}\n${section.text}`.trim() : section.text,
    )
    .filter(Boolean)
    .join('\n\n');
  const pictures = office.sections.flatMap((section, index) =>
    section.pictures.map((bytes) => ({
      bytes,
      pageNumber: index + 1,
      description: `Picture on ${section.label}`,
    })),
  );
  return {
    source,
    text,
    rawTextLength: text.length,
    pageCount: office.sections.length,
    images: await picturesToImages(pictures.slice(0, MAX_BUNDLE_PICTURES)),
  };
}

/** Read every attachment and merge them exactly as the web page does. */
export async function buildAttachmentBundle(
  files: readonly AttachmentFile[],
): Promise<AttachmentBundle> {
  assertAttachmentLimits(files);
  const parts: ParsedDocumentPart[] = [];
  for (const [order, file] of files.entries()) parts.push(await extractOne(file, order));
  const bundle = buildDocumentBundle(parts, { maxChars: MAX_PDF_CONTENT_CHARS });
  const hasText = parts.some((part) => part.text.trim().length > 0);
  const images: PdfImage[] = bundle.images.slice(0, MAX_BUNDLE_PICTURES).map((image) => ({
    id: image.id,
    src: image.src,
    pageNumber: image.pageNumber,
    ...(image.description ? { description: image.description } : {}),
    ...(image.width ? { width: image.width } : {}),
    ...(image.height ? { height: image.height } : {}),
    ...(image.sourceDocumentName ? { sourceDocumentName: image.sourceDocumentName } : {}),
    visionPriority: image.visionPriority,
  }));
  return {
    text: hasText || images.length > 0 ? bundle.text : '',
    images,
    summary: {
      files: files.length,
      textChars: parts.reduce((sum, part) => sum + part.text.trim().length, 0),
      images: images.length,
    },
  };
}

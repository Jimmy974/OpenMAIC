import JSZip from 'jszip';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import {
  AttachmentError,
  attachmentKind,
  buildAttachmentBundle,
} from '@/lib/server/attachments/extract';

async function png(color: string): Promise<Buffer> {
  return sharp({ create: { width: 64, height: 48, channels: 3, background: color } })
    .png()
    .toBuffer();
}

async function pptx(slides: Array<{ text: string[]; picture?: Buffer }>): Promise<Buffer> {
  const zip = new JSZip();
  slides.forEach((slide, index) => {
    const n = index + 1;
    const paragraphs = slide.text
      .map(
        (line) =>
          `<a:p><a:r><a:t>${line.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</a:t></a:r></a:p>`,
      )
      .join('');
    zip.file(
      `ppt/slides/slide${n}.xml`,
      `<p:sld><p:cSld><p:spTree><p:sp><p:txBody>${paragraphs}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
    );
    if (slide.picture) {
      zip.file(`ppt/media/image${n}.png`, slide.picture);
      zip.file(
        `ppt/slides/_rels/slide${n}.xml.rels`,
        `<Relationships><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image${n}.png"/></Relationships>`,
      );
    }
  });
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function docx(lines: string[], picture?: Buffer): Promise<Buffer> {
  const zip = new JSZip();
  const body = lines
    .map((line) => `<w:p><w:r><w:t xml:space="preserve">${line}</w:t></w:r></w:p>`)
    .join('');
  zip.file('word/document.xml', `<w:document><w:body>${body}</w:body></w:document>`);
  if (picture) {
    zip.file('word/media/image1.png', picture);
    zip.file(
      'word/_rels/document.xml.rels',
      '<Relationships><Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/></Relationships>',
    );
  }
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function pdf(text: string, picture?: Buffer): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 300]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText(text, { x: 20, y: 250, size: 14, font });
  if (picture) {
    const image = await doc.embedPng(picture);
    page.drawImage(image, { x: 20, y: 20, width: 200, height: 150 });
  }
  return Buffer.from(await doc.save());
}

describe('classroom API attachments', () => {
  it('classifies supported files and rejects old binary Office files', () => {
    expect(attachmentKind({ name: 'Worksheet.PDF' })).toBe('pdf');
    expect(attachmentKind({ name: 'photo', mimeType: 'image/jpeg' })).toBe('image');
    expect(attachmentKind({ name: 'deck.pptx' })).toBe('pptx');
    expect(attachmentKind({ name: 'notes.docx' })).toBe('docx');
    expect(attachmentKind({ name: 'notes.md' })).toBe('text');
    expect(() => attachmentKind({ name: 'old.ppt' })).toThrow(/save it as \.pptx/);
    expect(() => attachmentKind({ name: 'movie.mp4' })).toThrow(AttachmentError);
  });

  it('reads a picture as an image the model can look at', async () => {
    const bundle = await buildAttachmentBundle([{ name: 'page.png', bytes: await png('#ff0000') }]);
    expect(bundle.summary).toEqual({ files: 1, textChars: 0, images: 1 });
    expect(bundle.images[0]).toMatchObject({ id: 'img_1', pageNumber: 1 });
    expect(bundle.images[0]!.src).toMatch(/^data:image\/webp;base64,/);
  });

  it('reads slide text in order and slide pictures from a .pptx', async () => {
    const bundle = await buildAttachmentBundle([
      {
        name: 'lesson.pptx',
        bytes: await pptx([
          { text: ['Negative numbers', '5 + (-3) = 2'], picture: await png('#00ff00') },
          { text: ['Two signs: 3 - -4 = 7'] },
        ]),
      },
    ]);
    expect(bundle.text).toContain('### Slide 1\nNegative numbers\n5 + (-3) = 2');
    expect(bundle.text.indexOf('Slide 1')).toBeLessThan(bundle.text.indexOf('Slide 2'));
    expect(bundle.text).toContain('3 - -4 = 7');
    expect(bundle.images).toHaveLength(1);
    expect(bundle.images[0]!.description).toBe('Picture on Slide 1');
  });

  it('reads text and pictures from a .docx', async () => {
    const bundle = await buildAttachmentBundle([
      {
        name: 'notes.docx',
        bytes: await docx(['Diffusion', 'High to low & net movement'], await png('#0000ff')),
      },
    ]);
    expect(bundle.text).toContain('Diffusion\nHigh to low & net movement');
    expect(bundle.images).toHaveLength(1);
  });

  it('reads the text and the pictures of a PDF', async () => {
    const bundle = await buildAttachmentBundle([
      {
        name: 'worksheet.pdf',
        bytes: await pdf('Adding negative numbers 5 + (-3)', await png('#123456')),
      },
    ]);
    expect(bundle.text).toContain('Adding negative numbers');
    expect(bundle.summary.textChars).toBeGreaterThan(0);
    expect(bundle.images.length).toBeGreaterThanOrEqual(1);
  });

  it('merges several files with one section each', async () => {
    const bundle = await buildAttachmentBundle([
      { name: 'a.txt', bytes: Buffer.from('First file text') },
      { name: 'b.md', bytes: Buffer.from('# Second file') },
      { name: 'c.png', bytes: await png('#abcdef') },
    ]);
    expect(bundle.text).toContain('Source Document 1: a.txt');
    expect(bundle.text).toContain('Source Document 2: b.md');
    expect(bundle.summary.files).toBe(3);
    expect(bundle.images).toHaveLength(1);
  });

  it('enforces the file count, empty files and unreadable files', async () => {
    const one = { name: 'a.txt', bytes: Buffer.from('x') };
    await expect(buildAttachmentBundle(Array.from({ length: 6 }, () => one))).rejects.toThrow(
      /At most 5/,
    );
    await expect(
      buildAttachmentBundle([{ name: 'e.txt', bytes: Buffer.alloc(0) }]),
    ).rejects.toThrow(/empty/);
    await expect(
      buildAttachmentBundle([{ name: 'bad.pdf', bytes: Buffer.from('not a pdf') }]),
    ).rejects.toThrow(/could not be read as a PDF/);
    await expect(
      buildAttachmentBundle([{ name: 'bad.pptx', bytes: Buffer.from('nope') }]),
    ).rejects.toThrow(/could not be read as \.pptx/);
  });
});

describe('office package limits', () => {
  it('refuses a package whose entries expand beyond the limit', async () => {
    const zip = new JSZip();
    zip.file('ppt/slides/slide1.xml', '<a:p><a:r><a:t>x</a:t></a:r></a:p>');
    zip.file('ppt/media/huge.bin', Buffer.alloc(51 * 1024 * 1024));
    const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    expect(bytes.byteLength).toBeLessThan(1024 * 1024);
    await expect(buildAttachmentBundle([{ name: 'bomb.pptx', bytes }])).rejects.toThrow(
      /could not be read as \.pptx/,
    );
  });
});

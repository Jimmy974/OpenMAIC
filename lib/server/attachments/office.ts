/**
 * Minimal text + picture extraction for Office Open XML files (.pptx, .docx),
 * so the classroom API can read slides and documents without an external
 * document service. Slides keep their order; each slide's text becomes one
 * section. Pictures come from the package's media folder in reading order
 * (slide order for .pptx), limited to formats the image pipeline can decode.
 */
import JSZip from 'jszip';

export interface OfficeExtraction {
  /** One entry per slide (.pptx) or one entry for the whole document (.docx). */
  sections: Array<{ label: string; text: string; pictures: Buffer[] }>;
}

const PICTURE_EXTENSIONS = /\.(png|jpe?g|gif|webp|bmp|tiff?)$/i;
/** Guards against zip bombs: per-entry and whole-package uncompressed limits. */
const MAX_ENTRY_BYTES = 50 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 300 * 1024 * 1024;

function uncompressedSize(entry: JSZip.JSZipObject): number {
  const data = (entry as unknown as { _data?: { uncompressedSize?: number } })._data;
  return typeof data?.uncompressedSize === 'number' ? data.uncompressedSize : 0;
}

async function loadPackage(buffer: Buffer): Promise<JSZip> {
  const zip = await JSZip.loadAsync(buffer);
  let total = 0;
  for (const entry of Object.values(zip.files)) {
    const size = uncompressedSize(entry);
    if (size > MAX_ENTRY_BYTES) throw new Error(`entry ${entry.name} is too large`);
    total += size;
    if (total > MAX_PACKAGE_BYTES) throw new Error('package expands beyond the size limit');
  }
  return zip;
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, '&');
}

/** Text runs grouped by paragraph (`<a:p>` in DrawingML, `<w:p>` in WordprocessingML). */
function paragraphsFromXml(xml: string, paragraphTag: string, runTag: string): string[] {
  const paragraphs: string[] = [];
  const paragraphPattern = new RegExp(`<${paragraphTag}[\\s>][\\s\\S]*?</${paragraphTag}>`, 'g');
  const runPattern = new RegExp(`<${runTag}(?:\\s[^>]*)?>([\\s\\S]*?)</${runTag}>`, 'g');
  for (const paragraph of xml.match(paragraphPattern) ?? []) {
    const text = [...paragraph.matchAll(runPattern)]
      .map((match) => decodeXmlEntities(match[1] ?? ''))
      .join('')
      .trim();
    if (text) paragraphs.push(text);
  }
  return paragraphs;
}

function numberFrom(path: string): number {
  const match = path.match(/(\d+)\.xml$/);
  return match ? Number(match[1]) : 0;
}

async function relationshipTargets(
  zip: JSZip,
  relsPath: string,
  baseDir: string,
): Promise<string[]> {
  const rels = await zip.file(relsPath)?.async('string');
  if (!rels) return [];
  const targets: string[] = [];
  for (const match of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const tag = match[0];
    if (!/Type="[^"]*\/image"/.test(tag)) continue;
    const target = tag.match(/Target="([^"]+)"/)?.[1];
    if (!target || /^https?:/i.test(target)) continue;
    // Targets are relative to the part's folder, e.g. "../media/image1.png".
    const segments = `${baseDir}/${target}`.split('/');
    const resolved: string[] = [];
    for (const segment of segments) {
      if (segment === '..') resolved.pop();
      else if (segment && segment !== '.') resolved.push(segment);
    }
    targets.push(resolved.join('/'));
  }
  return targets;
}

async function pictures(zip: JSZip, paths: string[]): Promise<Buffer[]> {
  const out: Buffer[] = [];
  for (const path of paths) {
    if (!PICTURE_EXTENSIONS.test(path)) continue;
    const bytes = await zip.file(path)?.async('nodebuffer');
    if (bytes && bytes.byteLength > 0) out.push(bytes);
  }
  return out;
}

export async function extractPptx(buffer: Buffer): Promise<OfficeExtraction> {
  const zip = await loadPackage(buffer);
  const slidePaths = Object.keys(zip.files)
    .filter((path) => /^ppt\/slides\/slide\d+\.xml$/.test(path))
    .sort((a, b) => numberFrom(a) - numberFrom(b));
  const sections: OfficeExtraction['sections'] = [];
  const seenPictures = new Set<string>();
  for (const [index, slidePath] of slidePaths.entries()) {
    const xml = (await zip.file(slidePath)?.async('string')) ?? '';
    const text = paragraphsFromXml(xml, 'a:p', 'a:t').join('\n');
    const fileName = slidePath.split('/').pop()!;
    const targets = await relationshipTargets(
      zip,
      `ppt/slides/_rels/${fileName}.rels`,
      'ppt/slides',
    );
    const fresh = targets.filter((target) => !seenPictures.has(target));
    fresh.forEach((target) => seenPictures.add(target));
    sections.push({ label: `Slide ${index + 1}`, text, pictures: await pictures(zip, fresh) });
  }
  return { sections };
}

export async function extractDocx(buffer: Buffer): Promise<OfficeExtraction> {
  const zip = await loadPackage(buffer);
  const xml = (await zip.file('word/document.xml')?.async('string')) ?? '';
  const text = paragraphsFromXml(xml, 'w:p', 'w:t').join('\n');
  const targets = await relationshipTargets(zip, 'word/_rels/document.xml.rels', 'word');
  return { sections: [{ label: 'Document', text, pictures: await pictures(zip, targets) }] };
}

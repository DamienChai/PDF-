/**
 * A deterministic generator for a large PDF: every page shows one uncompressed greyscale image
 * of pseudo-random bytes (so nothing in it can be compressed away). Used to create the large
 * file of tests/e2e/large.spec.ts at test time instead of committing a big binary.
 */

/** xorshift32: fast, deterministic, good enough to be incompressible. */
function fillPseudoRandom(target: Uint8Array, seed: number): void {
  const words = new Uint32Array(target.buffer, target.byteOffset, target.byteLength >>> 2);
  let state = seed >>> 0 || 0x9e3779b9;
  for (let i = 0; i < words.length; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    words[i] = state;
  }
}

/**
 * A valid, unencrypted PDF 1.4 with `pages` pages and `bytesPerPage` bytes of image data on each
 * (a multiple of 1024: the image is 1024 pixels wide).
 */
export function buildLargePdf(pages: number, bytesPerPage: number): Uint8Array {
  if (bytesPerPage % 1024 !== 0) throw new Error('bytesPerPage must be a multiple of 1024');
  const width = 1024;
  const height = bytesPerPage / width;
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let length = 0;

  const push = (data: Uint8Array | string): void => {
    const bytes = typeof data === 'string' ? Buffer.from(data, 'latin1') : data;
    chunks.push(bytes);
    length += bytes.length;
  };
  const object = (number: number, body: string): void => {
    offsets[number] = length;
    push(`${number} 0 obj\n${body}\nendobj\n`);
  };

  push('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');
  const pageNumber = (index: number): number => 3 + index * 3;
  object(1, '<< /Type /Catalog /Pages 2 0 R >>');
  object(
    2,
    `<< /Type /Pages /Count ${pages} /Kids [${Array.from({ length: pages }, (_, index) => `${pageNumber(index)} 0 R`).join(' ')}] >>`,
  );

  for (let index = 0; index < pages; index++) {
    const page = pageNumber(index);
    const content = `q 612 0 0 792 0 0 cm /Im0 Do Q\n`;
    object(
      page,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${page + 1} 0 R ` +
        `/Resources << /XObject << /Im0 ${page + 2} 0 R >> >> >>`,
    );
    object(page + 1, `<< /Length ${content.length} >>\nstream\n${content}endstream`);

    const pixels = new Uint8Array(new ArrayBuffer(bytesPerPage));
    fillPseudoRandom(pixels, 0x1234567 + index);
    offsets[page + 2] = length;
    push(
      `${page + 2} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} ` +
        `/ColorSpace /DeviceGray /BitsPerComponent 8 /Length ${bytesPerPage} >>\nstream\n`,
    );
    push(pixels);
    push('\nendstream\nendobj\n');
  }

  const objectCount = 3 + pages * 3;
  const xref = length;
  push(`xref\n0 ${objectCount}\n0000000000 65535 f \n`);
  for (let number = 1; number < objectCount; number++) {
    push(`${String(offsets[number]).padStart(10, '0')} 00000 n \n`);
  }
  push(`trailer\n<< /Size ${objectCount} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

  const result = new Uint8Array(length);
  let position = 0;
  for (const chunk of chunks) {
    result.set(chunk, position);
    position += chunk.length;
  }
  return result;
}

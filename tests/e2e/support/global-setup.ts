/**
 * Runs once before the tests: creates the large encrypted PDF of large.spec.ts (about 30 MB,
 * AES-256) with the generator and the engine's Node entry. It is kept in the git-ignored
 * tests/fixtures/large/ and re-used by later runs; the version in its name changes when the
 * generator does.
 */
import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { LARGE_PDF } from './files';
import { buildLargePdf } from './large-pdf';
import { encryptPdf, inspectPdf } from './pdf';

export default async function globalSetup(): Promise<void> {
  const expected = LARGE_PDF.pages * LARGE_PDF.bytesPerPage;
  const existing = await stat(LARGE_PDF.path).catch(() => null);
  if (existing && existing.size > expected) return;

  const plain = buildLargePdf(LARGE_PDF.pages, LARGE_PDF.bytesPerPage);
  const check = await inspectPdf(plain);
  if (check.pageCount !== LARGE_PDF.pages || check.warnings.length > 0) {
    throw new Error(`the generated PDF is not clean: ${JSON.stringify(check)}`);
  }
  const encrypted = await encryptPdf(plain, LARGE_PDF.password);
  await mkdir(path.dirname(LARGE_PDF.path), { recursive: true });
  // Written under another name first: an interrupted run must not leave half a file behind.
  const temporary = `${LARGE_PDF.path}.${process.pid}.tmp`;
  await writeFile(temporary, encrypted);
  await rename(temporary, LARGE_PDF.path);
}

/** The PDFs of tests/fixtures and what manifest.json says about them. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture, type OkFixture } from '../../../src/engine/test-support';

export { fixture, type OkFixture };

const FIXTURE_DIR = fileURLToPath(new URL('../../fixtures/', import.meta.url));

export function fixturePath(name: string): string {
  return path.join(FIXTURE_DIR, name);
}

/** `report.pdf` → `report_unlocked.pdf`: the default output names. */
export function unlockedName(name: string): string {
  return name.replace(/\.pdf$/, '_unlocked.pdf');
}

export function lockedName(name: string): string {
  return name.replace(/\.pdf$/, '_locked.pdf');
}

/**
 * The large file of tests/e2e/large.spec.ts. Created by global-setup.ts in the git-ignored
 * folder that also holds the benchmark files; nothing big is committed.
 */
export const LARGE_PDF = {
  path: path.join(FIXTURE_DIR, 'large', 'e2e-aes-256-30mb-v1.pdf'),
  name: 'e2e-aes-256-30mb-v1.pdf',
  password: 'large-file-password',
  pages: 30,
  /** Bytes of image data per page. */
  bytesPerPage: 1024 * 1024,
} as const;

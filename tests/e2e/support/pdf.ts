/**
 * Checks of the files the app produced, outside the browser.
 *
 * Two independent views of a PDF:
 *   - `inspectPdf` opens it with the engine's Node entry (the same WebAssembly module, run
 *     in-thread), which reports encryption, permissions and page count;
 *   - `rawFacts` and `containsStreams` look at the bytes without any PDF library: header, end
 *     marker, an `/Encrypt` entry, and whether the page contents recorded in manifest.json (read
 *     with pikepdf when the fixtures were made) are in the file.
 *
 * Nothing here needs Python or a qpdf binary.
 */
import { expect } from '@playwright/test';
import { createPdfEngine, type InspectResult, type PdfEngine } from '../../../src/engine';
import { containsStreams, latin1, type OkFixture } from '../../../src/engine/test-support';

export { containsStreams };

let engine: PdfEngine | undefined;

function nodeEngine(): PdfEngine {
  engine ??= createPdfEngine();
  return engine;
}

/** Opens a PDF with the engine. Never rejects for a wrong password: see `access`. */
export function inspectPdf(bytes: Uint8Array, password = ''): Promise<InspectResult> {
  return nodeEngine().inspect(new Blob([bytes as BlobPart], { type: 'application/pdf' }), password);
}

/** Encrypts a PDF with AES-256 and one password, for tests that need a file of their own. */
export async function encryptPdf(bytes: Uint8Array, password: string): Promise<Uint8Array> {
  const result = await nodeEngine().process({
    file: new Blob([bytes as BlobPart], { type: 'application/pdf' }),
    password: '',
    operation: {
      kind: 'encrypt',
      options: {
        algorithm: 'aes-256',
        userPassword: password,
        ownerPassword: '',
        permissions: {
          print: 'full',
          modify: true,
          extract: true,
          annotate: true,
          fillForms: true,
          assemble: true,
          accessibility: true,
        },
        encryptMetadata: true,
      },
    },
  });
  return new Uint8Array(await result.blob.arrayBuffer());
}

export interface RawFacts {
  /** Starts with `%PDF-`. */
  header: boolean;
  /** Ends with `%%EOF`. */
  endMarker: boolean;
  /** An `/Encrypt` entry (trailer or cross-reference stream dictionary; never compressed). */
  encryptEntry: boolean;
  /** A linearization dictionary in the first kilobyte. */
  linearized: boolean;
  /** Object streams (`/Type /ObjStm`): what "optimise size" produces. */
  objectStreams: boolean;
}

export function rawFacts(bytes: Uint8Array): RawFacts {
  const text = latin1(bytes);
  return {
    header: text.startsWith('%PDF-'),
    endMarker: text.trimEnd().endsWith('%%EOF'),
    encryptEntry: /\/Encrypt\b/.test(text),
    linearized: /\/Linearized\b/.test(text.slice(0, 1024)),
    objectStreams: /\/Type\s*\/ObjStm\b/.test(text),
  };
}

/** A file the app unlocked: a clean, unencrypted PDF with the pages of `source` in it. */
export async function expectUnlockedCopy(bytes: Uint8Array, source: OkFixture): Promise<void> {
  expect(rawFacts(bytes), 'the bytes of the output').toMatchObject({
    header: true,
    endMarker: true,
    encryptEntry: false,
  });
  const info = await inspectPdf(bytes);
  expect(info, 'the output as the engine reads it').toMatchObject({
    encrypted: false,
    access: 'none',
    encryption: null,
    pageCount: source.pageCount,
    warnings: [],
  });
  expect(
    containsStreams(bytes, source.pageContentSha256),
    'the page contents recorded in manifest.json are in the output',
  ).toBe(true);
}

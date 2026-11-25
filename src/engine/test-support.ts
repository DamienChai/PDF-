/**
 * Helpers shared by the engine tests (Node only). Not imported by application code.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import type { EncryptionInfo } from './types';

const FIXTURE_DIR = new URL('../../tests/fixtures/', import.meta.url);

/** A fixture qpdf can read. Expectations were read back with pikepdf (see generate.py). */
export interface OkFixture {
  kind: 'ok';
  file: string;
  description: string;
  tags: string[];
  /** Passwords as a person would type them; null if there is none. */
  userPassword: string | null;
  ownerPassword: string | null;
  /** The exact bytes of those passwords in the file, hex-encoded. */
  userPasswordHex: string | null;
  ownerPasswordHex: string | null;
  wrongPassword: string;
  size: number;
  pdfVersion: string;
  encrypted: boolean;
  opensWithoutPassword: boolean;
  encryption: EncryptionInfo | null;
  pageCount: number;
  linearized: boolean;
  /** SHA-256 of the decoded content stream of each page. */
  pageContentSha256: string[];
  /** Text of each page as extracted by pypdf (used by the cross-check). */
  pageText: string[];
  /** SHA-256 of the decoded data of each embedded file, by name. */
  attachmentSha256: Record<string, string>;
  expectWarnings: boolean;
}

export interface ErrorFixture {
  kind: 'error';
  file: string;
  description: string;
  error: string;
  password: string;
  size: number;
}

export type Fixture = OkFixture | ErrorFixture;

export function fixtureBytes(file: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(file, FIXTURE_DIR)));
}

export function fixtureBlob(file: string): Blob {
  return new Blob([fixtureBytes(file) as BlobPart], { type: 'application/pdf' });
}

export const fixtures = JSON.parse(
  readFileSync(new URL('manifest.json', FIXTURE_DIR), 'utf8'),
) as Fixture[];

export const okFixtures = fixtures.filter((f): f is OkFixture => f.kind === 'ok');
export const errorFixtures = fixtures.filter((f): f is ErrorFixture => f.kind === 'error');

export function fixture(file: string): OkFixture {
  const found = okFixtures.find((f) => f.file === file);
  if (!found) {
    throw new Error(`no fixture ${file}`);
  }
  return found;
}

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function blobBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

export function latin1(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1');
}

function decodeAscii85(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let group: number[] = [];
  const flush = (count: number): void => {
    let value = 0;
    for (let i = 0; i < 5; i++) {
      value = value * 85 + (group[i] ?? 84);
    }
    for (let i = 0; i < count; i++) {
      out.push((value >>> (24 - 8 * i)) & 0xff);
    }
    group = [];
  };
  for (const byte of data) {
    if (byte === 0x7e) {
      break; // "~>" ends the data
    }
    if (byte === 0x7a && group.length === 0) {
      out.push(0, 0, 0, 0); // "z" is four zero bytes
    } else if (byte >= 0x21 && byte <= 0x75) {
      group.push(byte - 0x21);
      if (group.length === 5) {
        flush(4);
      }
    }
  }
  if (group.length > 1) {
    flush(group.length - 1);
  }
  return Uint8Array.from(out);
}

/** Applies the stream's /Filter chain as far as this helper knows the filters. */
function decodeStream(dict: string, raw: Uint8Array): Uint8Array {
  const filter = /\/Filter\s*(\[[^\]]*\]|\/\w+)/.exec(dict);
  let data = raw;
  for (const name of filter?.[1]?.match(/\/\w+/g) ?? []) {
    try {
      if (name === '/FlateDecode') {
        data = inflateSync(data);
      } else if (name === '/ASCII85Decode') {
        data = decodeAscii85(data);
      } else {
        return raw;
      }
    } catch {
      // Encrypted, or not what the dictionary claims: the raw bytes are hashed, matching nothing.
      return raw;
    }
  }
  return data;
}

/**
 * SHA-256 of the decoded data of every stream in a PDF, found by scanning for
 * `stream ... endstream` with a direct /Length (which is what qpdf writes). Flate and ASCII85 are
 * decoded; cross-reference and object streams are skipped. This is not a PDF parser: it exists so
 * tests can state "the page content survived" without one. The real structural checks are done
 * with pikepdf and pypdf in tests/fixtures/cross_check.py.
 */
export function streamHashes(pdf: Uint8Array): Set<string> {
  const text = latin1(pdf);
  const hashes = new Set<string>();
  const keyword = /stream\r?\n/g;
  for (let match = keyword.exec(text); match; match = keyword.exec(text)) {
    if (text.startsWith('end', match.index - 3)) {
      continue;
    }
    const dictStart = text.lastIndexOf(' obj', match.index);
    if (dictStart < 0) {
      continue;
    }
    const dict = text.slice(dictStart, match.index);
    const length = /\/Length (\d+)(?! \d+ R)/.exec(dict);
    if (!length || /\/Type\s*\/(XRef|ObjStm)/.test(dict)) {
      continue;
    }
    const start = match.index + match[0].length;
    const raw = pdf.subarray(start, start + Number(length[1]));
    hashes.add(sha256(decodeStream(dict, raw)));
    keyword.lastIndex = start + raw.length;
  }
  return hashes;
}

/** True if every hash is the hash of some decoded stream of `pdf`. */
export function containsStreams(pdf: Uint8Array, expected: Iterable<string>): boolean {
  const present = streamHashes(pdf);
  for (const hash of expected) {
    if (!present.has(hash)) {
      return false;
    }
  }
  return true;
}

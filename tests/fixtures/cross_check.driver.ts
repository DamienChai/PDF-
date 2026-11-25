/**
 * Produces the engine outputs that tests/fixtures/cross_check.py validates with other PDF
 * libraries. Not part of the normal test run; cross_check.py starts it like this:
 *
 *   PDFKEY_CROSS_OUT=<dir> npx vitest run --config tests/fixtures/cross-check.config.ts
 *
 * Every output is written to <dir> together with index.json, which records how it was made and
 * what it must look like.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import {
  ALL_PERMISSIONS,
  createPdfEngine,
  type EncryptOptions,
  type OutputOptions,
  type Permissions,
} from '../../src/engine/index';
import { saslprep } from '../../src/engine/saslprep';
import { encodePdfDoc, toHex } from '../../src/engine/passwords';
import { okFixtures, type OkFixture } from '../../src/engine/test-support';

const outDir = process.env['PDFKEY_CROSS_OUT'];
const fixtureDir = new URL('./', import.meta.url);

interface Entry {
  file: string;
  source: string;
  operation: 'decrypt' | 'encrypt';
  output: Partial<OutputOptions>;
  /** Hex of the exact password bytes the output must open with; null if it is not encrypted. */
  userPasswordHex: string | null;
  ownerPasswordHex: string | null;
  /** Password of the source, as typed, so that other tools can redo the operation. */
  sourcePassword: string;
  algorithm: 'aes-256' | 'aes-128' | null;
  permissions: Permissions | null;
  encryptMetadata: boolean | null;
  pageCount: number;
  durationMs: number;
}

const RESTRICTED: Permissions = {
  print: 'low',
  modify: false,
  extract: false,
  annotate: false,
  fillForms: true,
  assemble: false,
  accessibility: true,
};

function bestPassword(f: OkFixture): string {
  return f.ownerPassword ?? f.userPassword ?? '';
}

function passwordHex(typed: string, algorithm: 'aes-256' | 'aes-128'): string {
  const bytes =
    algorithm === 'aes-256' ? new TextEncoder().encode(saslprep(typed).value) : encodePdfDoc(typed.normalize('NFC'));
  if (!bytes) {
    throw new Error('password not encodable');
  }
  return toHex(bytes);
}

test.runIf(outDir !== undefined)('write the cross-check outputs', async () => {
  const dir = outDir!;
  mkdirSync(dir, { recursive: true });
  const engine = createPdfEngine();
  const entries: Entry[] = [];

  const run = async (
    f: OkFixture,
    name: string,
    password: string,
    encrypt: EncryptOptions | null,
    output: Partial<OutputOptions> = {},
  ): Promise<void> => {
    const file = new Blob([readFileSync(new URL(f.file, fixtureDir)) as BlobPart]);
    const result = await engine.process({
      file,
      password,
      operation: encrypt ? { kind: 'encrypt', options: encrypt } : { kind: 'decrypt' },
      output,
    });
    expect(result.verified).toBe(true);
    writeFileSync(join(dir, name), new Uint8Array(await result.blob.arrayBuffer()));
    const owner = encrypt && (encrypt.ownerPassword === '' ? encrypt.userPassword : encrypt.ownerPassword);
    entries.push({
      file: name,
      source: f.file,
      operation: encrypt ? 'encrypt' : 'decrypt',
      output,
      userPasswordHex: encrypt ? passwordHex(encrypt.userPassword, encrypt.algorithm) : null,
      ownerPasswordHex: encrypt ? passwordHex(owner!, encrypt.algorithm) : null,
      sourcePassword: password,
      algorithm: encrypt?.algorithm ?? null,
      permissions: encrypt?.permissions ?? null,
      encryptMetadata: encrypt?.encryptMetadata ?? null,
      pageCount: result.pageCount,
      durationMs: result.durationMs,
    });
  };

  const unicodeUser = String.fromCodePoint(0x5bc6, 0x7801, 0xff21, 0xff22, 0xe9, 0x1f512); // CJK, full-width, accent, emoji
  const pdfDocUser = `gr${String.fromCodePoint(0xfc)}n ${String.fromCodePoint(0x20ac)}5`;

  for (const f of okFixtures) {
    const stem = f.file.replace(/\.pdf$/, '');
    if (f.encrypted) {
      // Decrypt once with each password that exists (the typed forms, so candidate generation
      // is part of what gets validated).
      const passwords = [...new Set([f.userPassword ?? '', f.ownerPassword ?? ''])];
      for (const [i, password] of passwords.entries()) {
        await run(f, `${stem}.decrypt${i}.pdf`, password, null);
      }
      await run(f, `${stem}.decrypt-compress-linearize.pdf`, bestPassword(f), null, {
        streams: 'compress',
        linearize: true,
      });
    }
    await run(f, `${stem}.aes256.pdf`, bestPassword(f), {
      algorithm: 'aes-256',
      userPassword: 'user-256',
      ownerPassword: 'owner-256',
      permissions: RESTRICTED,
      encryptMetadata: true,
    });
    await run(f, `${stem}.aes128.pdf`, bestPassword(f), {
      algorithm: 'aes-128',
      userPassword: 'user-128',
      ownerPassword: 'owner-128',
      permissions: { ...ALL_PERMISSIONS, print: 'none', assemble: false },
      encryptMetadata: true,
    });
  }

  // Variations on one representative input.
  const plain = okFixtures.find((f) => f.file === 'plain.pdf')!;
  await run(plain, 'plain.aes256-unicode.pdf', '', {
    algorithm: 'aes-256',
    userPassword: unicodeUser,
    ownerPassword: `${unicodeUser}-owner`,
    permissions: { ...ALL_PERMISSIONS },
    encryptMetadata: true,
  });
  await run(plain, 'plain.aes128-pdfdoc.pdf', '', {
    algorithm: 'aes-128',
    userPassword: pdfDocUser,
    ownerPassword: '',
    permissions: { ...ALL_PERMISSIONS },
    encryptMetadata: true,
  });
  await run(plain, 'plain.aes256-owner-only.pdf', '', {
    algorithm: 'aes-256',
    userPassword: '',
    ownerPassword: 'only-owner',
    permissions: { ...RESTRICTED, print: 'none', fillForms: false },
    encryptMetadata: true,
  });
  for (const algorithm of ['aes-256', 'aes-128'] as const) {
    await run(plain, `plain.${algorithm}-cleartext-metadata.pdf`, '', {
      algorithm,
      userPassword: 'u',
      ownerPassword: 'o',
      permissions: { ...ALL_PERMISSIONS },
      encryptMetadata: false,
    });
    await run(
      plain,
      `plain.${algorithm}-compress-linearize.pdf`,
      '',
      { algorithm, userPassword: 'u', ownerPassword: 'o', permissions: { ...ALL_PERMISSIONS }, encryptMetadata: true },
      { streams: 'compress', linearize: true },
    );
  }

  engine.dispose();
  writeFileSync(join(dir, 'index.json'), `${JSON.stringify(entries, null, 1)}\n`);
  expect(entries.length).toBeGreaterThan(150);
});

/**
 * End-to-end tests of the public engine API against the committed fixtures. In Node there are no
 * Web Workers, so `createPdfEngine` runs in its in-thread mode: same WebAssembly module, same job
 * code, in-memory I/O.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  ALL_PERMISSIONS,
  PdfEngineError,
  createPdfEngine,
  type EncryptOptions,
  type EngineErrorCode,
  type InspectResult,
  type PdfEngine,
  type Permissions,
  type ProcessResult,
} from './index';
import {
  blobBytes,
  containsStreams,
  errorFixtures,
  fixture,
  fixtureBlob,
  fixtureBytes,
  latin1,
  okFixtures,
  streamHashes,
  type OkFixture,
} from './test-support';

let engine: PdfEngine;

beforeAll(() => {
  engine = createPdfEngine();
});

afterAll(() => {
  engine.dispose();
});

async function codeOf(promise: Promise<unknown>): Promise<EngineErrorCode | 'resolved'> {
  try {
    await promise;
    return 'resolved';
  } catch (error) {
    expect(error).toBeInstanceOf(PdfEngineError);
    return (error as PdfEngineError).code;
  }
}

function aes256(
  userPassword: string,
  ownerPassword: string,
  extra: Partial<EncryptOptions> = {},
): EncryptOptions {
  return {
    algorithm: 'aes-256',
    userPassword,
    ownerPassword,
    permissions: { ...ALL_PERMISSIONS },
    encryptMetadata: true,
    ...extra,
  };
}

/** The password that opens the fixture with the most rights, '' if none is needed. */
function bestPassword(f: OkFixture): string {
  return f.ownerPassword ?? f.userPassword ?? '';
}

function expectedAccess(
  f: OkFixture,
  password: 'none' | 'user' | 'owner',
): InspectResult['access'] {
  if (!f.encrypted) {
    return 'none';
  }
  const same = f.userPassword !== null && f.userPassword === f.ownerPassword;
  if (password === 'none') {
    return f.opensWithoutPassword ? 'user' : 'locked';
  }
  if (same) {
    return 'both';
  }
  return password;
}

describe('engine info', () => {
  test('ready() reports the bundled qpdf', async () => {
    const info = await engine.ready();
    expect(info.qpdfVersion).toBe('12.4.2');
    expect(info.mode).toBe('main-thread');
    expect(info.concurrency).toBe(1);
  });
});

describe.each(okFixtures)('$file', (f) => {
  const file = fixtureBlob(f.file);

  test('inspect without a password', async () => {
    const result = await engine.inspect(file);
    expect(result.fileSize).toBe(f.size);
    expect(result.pdfVersion).toBe(f.pdfVersion);
    expect(result.encrypted).toBe(f.encrypted);
    expect(result.opensWithoutPassword).toBe(f.opensWithoutPassword);
    expect(result.encryption).toEqual(f.encryption);
    expect(result.access).toBe(expectedAccess(f, 'none'));
    if (result.access === 'locked') {
      expect(result.pageCount).toBeNull();
      expect(result.linearized).toBeNull();
    } else {
      expect(result.pageCount).toBe(f.pageCount);
      expect(result.linearized).toBe(f.linearized);
    }
    expect(result.warnings.length > 0).toBe(f.expectWarnings);
  });

  test.runIf(f.userPassword !== null)('inspect with the user password', async () => {
    const result = await engine.inspect(file, f.userPassword!);
    expect(result.access).toBe(expectedAccess(f, 'user'));
    expect(result.opensWithoutPassword).toBe(false);
    expect(result.pageCount).toBe(f.pageCount);
    expect(result.linearized).toBe(f.linearized);
    expect(result.encryption).toEqual(f.encryption);
  });

  test.runIf(f.ownerPassword !== null)('inspect with the owner password', async () => {
    const result = await engine.inspect(file, f.ownerPassword!);
    expect(result.access).toBe(expectedAccess(f, 'owner'));
    expect(result.pageCount).toBe(f.pageCount);
    expect(result.encryption).toEqual(f.encryption);
  });

  test('inspect with a wrong password never rejects', async () => {
    const result = await engine.inspect(file, f.wrongPassword);
    expect(result.access).toBe(expectedAccess(f, 'none'));
    expect(result.encryption).toEqual(f.encryption);
  });

  if (!f.encrypted) {
    test('decrypt is refused: not encrypted', async () => {
      expect(
        await codeOf(engine.process({ file, password: '', operation: { kind: 'decrypt' } })),
      ).toBe('not-encrypted');
    });
  } else {
    test.runIf(!f.opensWithoutPassword)('decrypt without or with a wrong password', async () => {
      const decrypt = { kind: 'decrypt' } as const;
      expect(await codeOf(engine.process({ file, password: '', operation: decrypt }))).toBe(
        'password-required',
      );
      expect(
        await codeOf(engine.process({ file, password: f.wrongPassword, operation: decrypt })),
      ).toBe('password-incorrect');
    });

    const passwords = [...new Set([f.userPassword ?? '', f.ownerPassword ?? ''])];
    test.each(passwords)('decrypt with password %j', async (password) => {
      const progress: number[] = [];
      const result = await engine.process(
        { file, password, operation: { kind: 'decrypt' } },
        { onProgress: (fraction) => progress.push(fraction) },
      );
      expect(result.verified).toBe(true);
      expect(result.pageCount).toBe(f.pageCount);
      expect(result.inputSize).toBe(f.size);
      expect(result.blob.type).toBe('application/pdf');
      expect(result.blob.size).toBe(result.outputSize);
      expect(result.input.encryption).toEqual(f.encryption);
      expect(result.input.access).not.toBe('locked');
      expect(result.warnings.length > 0).toBe(f.expectWarnings);
      expect(progress.at(-1)).toBe(1);
      expect(progress).toEqual([...progress].sort((a, b) => a - b));
      expect(new Set(progress).size).toBe(progress.length);

      const output = await blobBytes(result.blob);
      expect(latin1(output.subarray(0, 5))).toBe('%PDF-');
      expect(containsStreams(output, f.pageContentSha256)).toBe(true);
      expect(containsStreams(output, Object.values(f.attachmentSha256))).toBe(true);

      const after = await engine.inspect(result.blob);
      expect(after.encrypted).toBe(false);
      expect(after.access).toBe('none');
      expect(after.encryption).toBeNull();
      expect(after.pageCount).toBe(f.pageCount);
      expect(after.warnings).toEqual([]);
    });
  }

  test.each(['aes-256', 'aes-128'] as const)(
    'encrypt with %s, then decrypt again',
    async (algorithm) => {
      const permissions: Permissions = {
        print: 'low',
        modify: false,
        extract: false,
        annotate: true,
        fillForms: true,
        assemble: false,
        accessibility: true,
      };
      const encrypted = await engine.process({
        file,
        password: bestPassword(f),
        operation: {
          kind: 'encrypt',
          options: {
            algorithm,
            userPassword: 'new-user',
            ownerPassword: 'new-owner',
            permissions,
            encryptMetadata: true,
          },
        },
      });
      expect(encrypted.verified).toBe(true);
      expect(encrypted.pageCount).toBe(f.pageCount);
      const ciphertext = await blobBytes(encrypted.blob);
      const hashes = streamHashes(ciphertext);
      for (const hash of f.pageContentSha256) {
        expect(hashes.has(hash)).toBe(false);
      }

      const locked = await engine.inspect(encrypted.blob);
      expect(locked.access).toBe('locked');
      expect(locked.encryption).toMatchObject({
        algorithm,
        revision: algorithm === 'aes-256' ? 6 : 4,
        version: algorithm === 'aes-256' ? 5 : 4,
        keyBits: algorithm === 'aes-256' ? 256 : 128,
        streamMethod: algorithm === 'aes-256' ? 'aesv3' : 'aesv2',
        encryptMetadata: true,
        permissions,
      });
      expect((await engine.inspect(encrypted.blob, 'new-user')).access).toBe('user');
      expect((await engine.inspect(encrypted.blob, 'new-owner')).access).toBe('owner');

      const decrypted = await engine.process({
        file: encrypted.blob,
        password: 'new-user',
        operation: { kind: 'decrypt' },
      });
      expect(decrypted.pageCount).toBe(f.pageCount);
      const plaintext = await blobBytes(decrypted.blob);
      expect(containsStreams(plaintext, f.pageContentSha256)).toBe(true);
      expect(containsStreams(plaintext, Object.values(f.attachmentSha256))).toBe(true);
    },
  );
});

describe.each(errorFixtures)('$file', (f) => {
  const file = fixtureBlob(f.file);

  test(`inspect rejects with ${f.error}`, async () => {
    expect(await codeOf(engine.inspect(file, f.password))).toBe(f.error);
  });

  test(`process rejects with ${f.error}`, async () => {
    expect(
      await codeOf(engine.process({ file, password: f.password, operation: { kind: 'decrypt' } })),
    ).toBe(f.error);
    expect(
      await codeOf(
        engine.process({
          file,
          password: f.password,
          operation: { kind: 'encrypt', options: aes256('a', 'b') },
        }),
      ),
    ).toBe(f.error);
  });
});

describe('input edge cases', () => {
  test('an empty file is not a PDF', async () => {
    expect(await codeOf(engine.inspect(new Blob([])))).toBe('not-pdf');
  });

  test('a file the browser cannot read', async () => {
    const unreadable = new Blob([fixtureBytes('plain.pdf') as BlobPart]);
    unreadable.arrayBuffer = () => Promise.reject(new DOMException('gone', 'NotFoundError'));
    expect(await codeOf(engine.inspect(unreadable))).toBe('read-failed');
    expect(
      await codeOf(
        engine.process({ file: unreadable, password: '', operation: { kind: 'decrypt' } }),
      ),
    ).toBe('read-failed');
  });

  test('owner-only documents are decrypted without any password', async () => {
    const f = fixture('owner-only-r6.pdf');
    const result = await engine.process({
      file: fixtureBlob(f.file),
      password: '',
      operation: { kind: 'decrypt' },
    });
    expect(result.input.access).toBe('user');
    expect(result.input.opensWithoutPassword).toBe(true);
    expect((await engine.inspect(result.blob)).encrypted).toBe(false);
  });

  test('a wrong password does not stop a document that opens without one', async () => {
    const f = fixture('owner-only-r4.pdf');
    const result = await engine.process({
      file: fixtureBlob(f.file),
      password: 'not-the-owner-password',
      operation: { kind: 'decrypt' },
    });
    expect(result.input.access).toBe('user');
  });

  test('only the first 32 bytes of an R4 password count', async () => {
    const f = fixture('long-password-r4.pdf');
    const typed = `${f.userPassword!.slice(0, 32)}completely different tail`;
    expect((await engine.inspect(fixtureBlob(f.file), typed)).access).toBe('user');
    expect((await engine.inspect(fixtureBlob(f.file), f.userPassword!.slice(0, 31))).access).toBe(
      'locked',
    );
  });
});

describe('output options', () => {
  test('preserve keeps stream data byte for byte, compress shrinks it', async () => {
    const source = fixtureBytes('plain.pdf');
    const f = fixture('plain.pdf');
    const encrypt = { kind: 'encrypt', options: aes256('u', 'o') } as const;

    const preserved = await engine.process({
      file: fixtureBlob(f.file),
      password: '',
      operation: encrypt,
    });
    const compressed = await engine.process({
      file: fixtureBlob(f.file),
      password: '',
      operation: encrypt,
      output: { streams: 'compress' },
    });
    expect(compressed.outputSize).toBeLessThan(preserved.outputSize * 0.75);

    const plainAgain = await engine.process({
      file: preserved.blob,
      password: 'u',
      operation: { kind: 'decrypt' },
    });
    const bytes = await blobBytes(plainAgain.blob);
    // plain.pdf stores its content streams uncompressed: after a preserve round trip the exact
    // bytes of the first page's content must be in the output, unfiltered.
    const text = latin1(source);
    const start = text.indexOf('q 60 0 0 80 220 60 cm');
    const end = text.indexOf('endstream', start);
    expect(start).toBeGreaterThan(0);
    expect(latin1(bytes)).toContain(text.slice(start, end).trimEnd());
    expect(latin1(bytes)).not.toContain('/ObjStm');

    const compressedPlain = await engine.process({
      file: compressed.blob,
      password: 'o',
      operation: { kind: 'decrypt' },
    });
    const compressedBytes = await blobBytes(compressedPlain.blob);
    expect(latin1(compressedBytes)).toContain('/ObjStm');
    expect(latin1(compressedBytes)).not.toContain('q 60 0 0 80 220 60 cm');
    expect(containsStreams(compressedBytes, f.pageContentSha256)).toBe(true);
  });

  test('preserve keeps object streams', async () => {
    const f = fixture('objstm-r6.pdf');
    const result = await engine.process({
      file: fixtureBlob(f.file),
      password: f.userPassword!,
      operation: { kind: 'decrypt' },
    });
    const bytes = await blobBytes(result.blob);
    expect(latin1(bytes)).toContain('/ObjStm');
    expect(latin1(bytes)).toContain('/XRef');
  });

  test.each(['decrypt', 'encrypt'] as const)('linearize on %s', async (kind) => {
    const f = fixture('aes-128-r4.pdf');
    const result = await engine.process({
      file: fixtureBlob(f.file),
      password: f.ownerPassword!,
      operation: kind === 'decrypt' ? { kind } : { kind, options: aes256('u', 'o') },
      output: { linearize: true },
    });
    const after = await engine.inspect(result.blob, 'u');
    expect(after.linearized).toBe(true);
    expect(after.pageCount).toBe(f.pageCount);
    expect(latin1((await blobBytes(result.blob)).subarray(0, 200))).toContain('/Linearized');
  });

  test('linearized input is not linearized again unless asked', async () => {
    const f = fixture('linearized-r6.pdf');
    const result = await engine.process({
      file: fixtureBlob(f.file),
      password: f.userPassword!,
      operation: { kind: 'decrypt' },
    });
    expect((await engine.inspect(result.blob)).linearized).toBe(false);
  });

  test('verify: false skips the re-open', async () => {
    const f = fixture('aes-256-r6.pdf');
    const result = await engine.process({
      file: fixtureBlob(f.file),
      password: f.userPassword!,
      operation: { kind: 'decrypt' },
      output: { verify: false },
    });
    expect(result.verified).toBe(false);
    expect((await engine.inspect(result.blob)).pageCount).toBe(f.pageCount);
  });
});

describe('encrypt options', () => {
  const plain = fixtureBlob('plain.pdf');

  const permissionSets: Permissions[] = [
    { ...ALL_PERMISSIONS },
    {
      print: 'none',
      modify: false,
      extract: false,
      annotate: false,
      fillForms: false,
      assemble: false,
      accessibility: false,
    },
    {
      print: 'low',
      modify: true,
      extract: false,
      annotate: false,
      fillForms: true,
      assemble: true,
      accessibility: true,
    },
    {
      print: 'full',
      modify: false,
      extract: true,
      annotate: true,
      fillForms: false,
      assemble: false,
      accessibility: false,
    },
  ];

  test.each(['aes-256', 'aes-128'] as const)('%s: permissions round-trip', async (algorithm) => {
    for (const permissions of permissionSets) {
      const result = await engine.process({
        file: plain,
        password: '',
        operation: {
          kind: 'encrypt',
          options: {
            algorithm,
            userPassword: 'u',
            ownerPassword: 'o',
            permissions,
            encryptMetadata: true,
          },
        },
      });
      const info = await engine.inspect(result.blob, 'u');
      // Bit 10 (accessibility) is deprecated since PDF 2.0 and must be set; qpdf keeps it set
      // for every revision the engine writes.
      expect(info.encryption?.permissions).toEqual({ ...permissions, accessibility: true });
      expect(info.encryption?.rawPermissions).toBeLessThan(0);
    }
  });

  test('a single password gives full access', async () => {
    const result = await engine.process({
      file: plain,
      password: '',
      operation: { kind: 'encrypt', options: aes256('only', '') },
    });
    expect((await engine.inspect(result.blob)).access).toBe('locked');
    expect((await engine.inspect(result.blob, 'only')).access).toBe('both');
  });

  test('owner password only: opens freely, restrictions apply', async () => {
    const result = await engine.process({
      file: plain,
      password: '',
      operation: {
        kind: 'encrypt',
        options: aes256('', 'owner', { permissions: { ...ALL_PERMISSIONS, extract: false } }),
      },
    });
    const open = await engine.inspect(result.blob);
    expect(open.access).toBe('user');
    expect(open.opensWithoutPassword).toBe(true);
    expect(open.encryption?.permissions.extract).toBe(false);
    expect((await engine.inspect(result.blob, 'owner')).access).toBe('owner');
  });

  test.each(['aes-256', 'aes-128'] as const)(
    '%s: metadata can stay in the clear',
    async (algorithm) => {
      const options = (encryptMetadata: boolean): EncryptOptions => ({
        algorithm,
        userPassword: 'u',
        ownerPassword: 'o',
        permissions: { ...ALL_PERMISSIONS },
        encryptMetadata,
      });
      const hidden = await engine.process({
        file: plain,
        password: '',
        operation: { kind: 'encrypt', options: options(true) },
      });
      const visible = await engine.process({
        file: plain,
        password: '',
        operation: { kind: 'encrypt', options: options(false) },
      });
      expect(latin1(await blobBytes(hidden.blob))).not.toContain('<x:xmpmeta');
      expect(latin1(await blobBytes(visible.blob))).toContain('<x:xmpmeta');
      expect((await engine.inspect(hidden.blob)).encryption?.encryptMetadata).toBe(true);
      expect((await engine.inspect(visible.blob)).encryption?.encryptMetadata).toBe(false);
    },
  );

  test('AES-256 passwords are SASLprep-normalised', async () => {
    const fullWidth = String.fromCodePoint(0xff21, 0xff22, 0xff23); // full-width "ABC"
    const result = await engine.process({
      file: plain,
      password: '',
      operation: { kind: 'encrypt', options: aes256(fullWidth, 'owner') },
    });
    expect((await engine.inspect(result.blob, 'ABC')).access).toBe('user');
    expect((await engine.inspect(result.blob, fullWidth)).access).toBe('user');
    expect((await engine.inspect(result.blob, 'abc')).access).toBe('locked');
  });

  test('Unicode passwords work for AES-256, Latin-1 ones for AES-128', async () => {
    const chinese = String.fromCodePoint(0x5bc6, 0x7801, 0x1f512);
    const strong = await engine.process({
      file: plain,
      password: '',
      operation: { kind: 'encrypt', options: aes256(chinese, '') },
    });
    expect((await engine.inspect(strong.blob, chinese)).access).toBe('both');

    const umlaut = `gr${String.fromCodePoint(0xfc)}n${String.fromCodePoint(0x20ac)}`;
    const legacy = await engine.process({
      file: plain,
      password: '',
      operation: { kind: 'encrypt', options: { ...aes256(umlaut, ''), algorithm: 'aes-128' } },
    });
    expect((await engine.inspect(legacy.blob, umlaut)).access).toBe('both');
  });

  const rejected: [string, EncryptOptions, EngineErrorCode][] = [
    ['no password at all', aes256('', ''), 'password-missing'],
    ['128 bytes', aes256('x'.repeat(128), ''), 'password-too-long'],
    [
      '33 bytes for AES-128',
      { ...aes256('x'.repeat(33), ''), algorithm: 'aes-128' },
      'password-too-long',
    ],
    [
      'CJK for AES-128',
      { ...aes256(String.fromCodePoint(0x5bc6), ''), algorithm: 'aes-128' },
      'password-not-encodable',
    ],
    ['a control character', aes256('a\u0007b', ''), 'password-not-encodable'],
  ];
  test.each(rejected)('%s is rejected', async (_name, options, code) => {
    expect(
      await codeOf(
        engine.process({ file: plain, password: '', operation: { kind: 'encrypt', options } }),
      ),
    ).toBe(code);
  });

  test('changing the password of an encrypted document needs the old one', async () => {
    const f = fixture('aes-128-r4.pdf');
    const file = fixtureBlob(f.file);
    const change = { kind: 'encrypt', options: aes256('fresh', 'fresh-owner') } as const;
    expect(await codeOf(engine.process({ file, password: '', operation: change }))).toBe(
      'password-required',
    );
    expect(await codeOf(engine.process({ file, password: 'nope', operation: change }))).toBe(
      'password-incorrect',
    );
    const result = await engine.process({ file, password: f.userPassword!, operation: change });
    expect(result.input.encryption?.algorithm).toBe('aes-128');
    const after = await engine.inspect(result.blob, 'fresh');
    expect(after.encryption?.algorithm).toBe('aes-256');
    expect(after.access).toBe('user');
    expect((await engine.inspect(result.blob, f.userPassword!)).access).toBe('locked');
  });

  test('every encryption uses fresh random keys and IVs', async () => {
    const run = async (): Promise<Uint8Array> =>
      blobBytes(
        (
          await engine.process({
            file: plain,
            password: '',
            operation: { kind: 'encrypt', options: aes256('same', 'same-owner') },
          })
        ).blob,
      );
    const [a, b] = [await run(), await run()];
    const field = (bytes: Uint8Array, name: string): string => {
      const text = latin1(bytes);
      const at = text.indexOf(`/${name} <`, text.indexOf('/Filter /Standard'));
      return text.slice(at, text.indexOf('>', at));
    };
    for (const name of ['O', 'U', 'OE', 'UE', 'Perms']) {
      expect(field(a, name).length).toBeGreaterThan(20);
      expect(field(a, name)).not.toBe(field(b, name));
    }
    // Same plaintext, different ciphertext.
    const common = [...streamHashes(a)].filter((hash) => streamHashes(b).has(hash));
    expect(common).toEqual([]);
  });
});

describe('robustness', () => {
  test('the engine stays usable after every kind of failure', async () => {
    const good = fixture('aes-256-r6.pdf');
    const check = async (): Promise<void> => {
      const result = await engine.process({
        file: fixtureBlob(good.file),
        password: good.userPassword!,
        operation: { kind: 'decrypt' },
      });
      expect(result.pageCount).toBe(good.pageCount);
    };
    await check();
    for (const f of errorFixtures) {
      expect(await codeOf(engine.inspect(fixtureBlob(f.file), f.password))).toBe(f.error);
      await check();
    }
    expect(
      await codeOf(
        engine.process({
          file: fixtureBlob(good.file),
          password: 'bad',
          operation: { kind: 'decrypt' },
        }),
      ),
    ).toBe('password-incorrect');
    await check();
    expect(
      await codeOf(
        engine.process({
          file: fixtureBlob('plain.pdf'),
          password: '',
          operation: { kind: 'decrypt' },
        }),
      ),
    ).toBe('not-encrypted');
    await check();
  });

  test('many jobs in a row', async () => {
    const f = fixture('aes-128-r4.pdf');
    const sizes = new Set<number>();
    for (let i = 0; i < 25; i++) {
      const result = await engine.process({
        file: fixtureBlob(f.file),
        password: f.userPassword!,
        operation: { kind: 'decrypt' },
      });
      sizes.add(result.outputSize);
    }
    expect(sizes.size).toBe(1);
  });

  test('overlapping jobs all complete, each with its own result', async () => {
    const jobs: Promise<ProcessResult | InspectResult>[] = [];
    const encrypted = okFixtures.filter((f) => f.encrypted && f.userPassword !== null);
    for (const f of encrypted) {
      jobs.push(
        engine.process({
          file: fixtureBlob(f.file),
          password: f.userPassword!,
          operation: { kind: 'decrypt' },
        }),
      );
      jobs.push(engine.inspect(fixtureBlob(f.file), f.ownerPassword ?? ''));
    }
    const results = await Promise.all(jobs);
    encrypted.forEach((f, i) => {
      const processed = results[2 * i] as ProcessResult;
      expect(processed.inputSize).toBe(f.size);
      expect(processed.input.encryption).toEqual(f.encryption);
      expect((results[2 * i + 1] as InspectResult).fileSize).toBe(f.size);
    });
  });

  test('an already aborted signal cancels without running', async () => {
    const controller = new AbortController();
    controller.abort();
    expect(
      await codeOf(engine.inspect(fixtureBlob('plain.pdf'), '', { signal: controller.signal })),
    ).toBe('cancelled');
  });

  test('aborting a queued job cancels it and leaves the others alone', async () => {
    const f = fixture('aes-256-r6.pdf');
    const controller = new AbortController();
    const first = engine.process({
      file: fixtureBlob(f.file),
      password: f.userPassword!,
      operation: { kind: 'decrypt' },
    });
    const second = engine.process(
      { file: fixtureBlob(f.file), password: f.userPassword!, operation: { kind: 'decrypt' } },
      { signal: controller.signal },
    );
    const third = engine.inspect(fixtureBlob(f.file));
    controller.abort();
    expect(await codeOf(second)).toBe('cancelled');
    expect((await first).pageCount).toBe(f.pageCount);
    expect((await third).access).toBe('locked');
  });

  test('a disposed engine rejects', async () => {
    const other = createPdfEngine();
    const pending = other.inspect(fixtureBlob('plain.pdf'));
    other.dispose();
    expect(await codeOf(pending)).toBe('cancelled');
    expect(await codeOf(other.inspect(fixtureBlob('plain.pdf')))).toBe('cancelled');
    expect(await codeOf(other.ready())).toBe('cancelled');
  });
});

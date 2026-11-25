/** The scripted engine of tests/support must itself behave like the contract says. */
import { describe, expect, it, vi } from 'vitest';
import { createPdfEngine } from '../engine';
import { ALL_PERMISSIONS, PdfEngineError, type EncryptOptions } from '../engine/types';
import {
  DEMO_FILE_NAMES,
  DEMO_OWNER_PASSWORD,
  DEMO_PASSWORD,
  FAKE_QPDF_VERSION,
  FAKE_SCENARIOS,
  createDemoFile,
  createDemoFiles,
  createFakeEngine,
  demoFileNamesFromUrl,
  fakeEngineOptionsFromUrl,
} from '../../tests/support/fake-engine';

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'resolved';
  } catch (error) {
    expect(error).toBeInstanceOf(PdfEngineError);
    return (error as PdfEngineError).code;
  }
}

/** Lets promise callbacks and zero-delay timers run. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const aes256: EncryptOptions = {
  algorithm: 'aes-256',
  userPassword: 'new-password',
  ownerPassword: '',
  permissions: { ...ALL_PERMISSIONS },
  encryptMetadata: true,
};

describe('demo files', () => {
  it('exist for every scenario and start with a PDF header, except the one that must not', async () => {
    const files = createDemoFiles();
    expect(files.map((file) => file.name)).toEqual(DEMO_FILE_NAMES);
    for (const file of files) {
      const head = await file.slice(0, 8).text();
      expect(head.startsWith('%PDF-'), file.name).toBe(file.name !== 'not-a-pdf.pdf');
      expect(file.size, file.name).toBeGreaterThan(0);
    }
  });

  it('are stable: same name, size and date every time', () => {
    const [a, b] = [createDemoFile('plain.pdf'), createDemoFile('plain.pdf')];
    expect([a.name, a.size, a.lastModified]).toEqual([b.name, b.size, b.lastModified]);
    expect(a.size).toBe(482_113);
  });

  it('only report the size of the huge file', () => {
    const huge = createDemoFile('huge.pdf');
    expect(huge.size).toBe(FAKE_SCENARIOS['huge.pdf']!.size);
    expect(huge.size).toBeGreaterThan(1024 ** 3);
  });

  it('can be made for any other name', async () => {
    const file = createDemoFile('报告.pdf', { size: 2048, lastModified: 5 });
    expect([file.name, file.size, file.lastModified]).toEqual(['报告.pdf', 2048, 5]);
    expect((await createFakeEngine().inspect(file)).encrypted).toBe(false);
  });
});

describe('demo files and fake outputs', () => {
  it('are valid PDFs: the real engine reads them without a complaint', async () => {
    const real = createPdfEngine();
    try {
      for (const name of ['plain.pdf', 'needs-password.pdf', '2024年度财务报表_最终版(3).pdf']) {
        const file = createDemoFile(name);
        // Really that many bytes, not just a number on the File.
        expect((await file.arrayBuffer()).byteLength, name).toBe(file.size);
        expect(await real.inspect(file), name).toMatchObject({
          fileSize: file.size,
          encrypted: false,
          pageCount: 1,
          warnings: [],
        });
      }
      const { blob } = await createFakeEngine().process({
        file: createDemoFile('owner-only.pdf'),
        password: '',
        operation: { kind: 'decrypt' },
      });
      expect(await real.inspect(blob)).toMatchObject({ pageCount: 1, warnings: [] });
    } finally {
      real.dispose();
    }
  });
});

describe('fake engine: inspect', () => {
  const engine = createFakeEngine();

  it('reports readiness like the real engine', async () => {
    expect(await engine.ready()).toEqual({
      qpdfVersion: FAKE_QPDF_VERSION,
      concurrency: 2,
      mode: 'worker',
    });
  });

  it('describes a plain file', async () => {
    const result = await engine.inspect(createDemoFile('plain.pdf'));
    expect(result).toMatchObject({
      fileSize: 482_113,
      encrypted: false,
      access: 'none',
      opensWithoutPassword: true,
      encryption: null,
      pageCount: 12,
      warnings: [],
    });
  });

  it('never rejects for a wrong or missing password', async () => {
    const file = createDemoFile('needs-password.pdf');
    const locked = await engine.inspect(file);
    expect(locked).toMatchObject({
      encrypted: true,
      access: 'locked',
      opensWithoutPassword: false,
      pageCount: null,
      linearized: null,
    });
    expect(locked.encryption).toMatchObject({ algorithm: 'aes-256', keyBits: 256, revision: 6 });
    expect((await engine.inspect(file, 'nope')).access).toBe('locked');
    expect(await engine.inspect(file, DEMO_PASSWORD)).toMatchObject({
      access: 'user',
      pageCount: 4,
    });
    expect((await engine.inspect(file, DEMO_OWNER_PASSWORD)).access).toBe('owner');
  });

  it('knows the owner-password variants', async () => {
    const same = await engine.inspect(createDemoFile('same-password.pdf'), DEMO_PASSWORD);
    expect(same.access).toBe('both');
    const ownerOnly = createDemoFile('owner-only.pdf');
    expect(await engine.inspect(ownerOnly)).toMatchObject({
      access: 'user',
      opensWithoutPassword: true,
      pageCount: 31,
    });
    expect((await engine.inspect(ownerOnly, DEMO_OWNER_PASSWORD)).access).toBe('owner');
    const permissions = (await engine.inspect(ownerOnly)).encryption!.permissions;
    expect(permissions).toMatchObject({ print: 'none', extract: false, modify: true });
  });

  it.each([
    ['aes128.pdf', 'aes-128', 128, 4],
    ['aes256-r5.pdf', 'aes-256-r5', 256, 5],
    ['rc4.pdf', 'rc4', 128, 3],
    ['rc4-40.pdf', 'rc4', 40, 2],
  ])('describes the algorithm of %s', async (name, algorithm, keyBits, revision) => {
    const { encryption } = await engine.inspect(createDemoFile(name));
    expect(encryption).toMatchObject({ algorithm, keyBits, revision });
  });

  it('stores permission flags the way a writer would', async () => {
    const all = await engine.inspect(createDemoFile('same-password.pdf'));
    expect(all.encryption!.rawPermissions).toBe(-4);
    const none = await engine.inspect(createDemoFile('needs-password.pdf'));
    // Printing, modifying, extracting and assembling denied; annotating and forms allowed.
    expect(none.encryption!.rawPermissions).toBe(0xfffff0c0 | 0x20 | 0x100 | 0x200 | 0);
  });

  it.each([
    ['damaged.pdf', 'damaged'],
    ['unsupported.pdf', 'unsupported-encryption'],
    ['not-a-pdf.pdf', 'not-pdf'],
    ['engine-unavailable.pdf', 'engine-unavailable'],
  ])('rejects %s with %s', async (name, code) => {
    expect(await codeOf(engine.inspect(createDemoFile(name)))).toBe(code);
  });

  it('reports warnings and a faked size', async () => {
    expect((await engine.inspect(createDemoFile('repaired.pdf'))).warnings).toHaveLength(3);
    expect((await engine.inspect(createDemoFile('huge.pdf'))).fileSize).toBe(1_932_735_283);
  });
});

describe('fake engine: process', () => {
  it('decrypts with the right password and reports monotonic progress ending at 1', async () => {
    const engine = createFakeEngine({ steps: 5 });
    const progress: number[] = [];
    const file = createDemoFile('needs-password.pdf');
    const result = await engine.process(
      { file, password: DEMO_PASSWORD, operation: { kind: 'decrypt' } },
      { onProgress: (fraction) => progress.push(fraction) },
    );
    expect(progress).toHaveLength(6);
    expect(progress.at(-1)).toBe(1);
    expect([...progress].sort((a, b) => a - b)).toEqual(progress);
    expect(result).toMatchObject({ inputSize: file.size, pageCount: 4, verified: true });
    expect(result.blob.type).toBe('application/pdf');
    expect((await result.blob.slice(0, 5).text()).startsWith('%PDF-')).toBe(true);
    expect(await engine.inspect(result.blob)).toMatchObject({ encrypted: false, pageCount: 4 });
  });

  it('rejects wrong and missing passwords with the codes of the real engine', async () => {
    const engine = createFakeEngine();
    const file = createDemoFile('needs-password.pdf');
    const decrypt = { kind: 'decrypt' } as const;
    expect(await codeOf(engine.process({ file, password: '', operation: decrypt }))).toBe(
      'password-required',
    );
    expect(await codeOf(engine.process({ file, password: 'x', operation: decrypt }))).toBe(
      'password-incorrect',
    );
    expect(
      await codeOf(
        engine.process({ file: createDemoFile('plain.pdf'), password: '', operation: decrypt }),
      ),
    ).toBe('not-encrypted');
  });

  it('decrypts a restrictions-only file without any password', async () => {
    const engine = createFakeEngine();
    const result = await engine.process({
      file: createDemoFile('owner-only.pdf'),
      password: '',
      operation: { kind: 'decrypt' },
    });
    expect(await engine.inspect(result.blob)).toMatchObject({ encrypted: false, access: 'none' });
  });

  it('encrypts, and its output behaves as requested', async () => {
    const engine = createFakeEngine();
    const result = await engine.process({
      file: createDemoFile('plain.pdf'),
      password: '',
      operation: {
        kind: 'encrypt',
        options: {
          ...aes256,
          ownerPassword: 'boss',
          permissions: { ...ALL_PERMISSIONS, print: 'low' },
        },
      },
    });
    expect(result.outputSize).toBeGreaterThan(result.inputSize);
    expect(await engine.inspect(result.blob)).toMatchObject({ encrypted: true, access: 'locked' });
    expect((await engine.inspect(result.blob, 'new-password')).access).toBe('user');
    expect((await engine.inspect(result.blob, 'boss')).access).toBe('owner');
    expect((await engine.inspect(result.blob)).encryption).toMatchObject({
      algorithm: 'aes-256',
      permissions: { print: 'low' },
    });
    // And it can be unlocked again.
    const back = await engine.process({
      file: result.blob,
      password: 'new-password',
      operation: { kind: 'decrypt' },
    });
    expect((await engine.inspect(back.blob)).encrypted).toBe(false);
  });

  it('treats a single new password as user and owner password', async () => {
    const engine = createFakeEngine();
    const { blob } = await engine.process({
      file: createDemoFile('plain.pdf'),
      password: '',
      operation: { kind: 'encrypt', options: aes256 },
    });
    expect((await engine.inspect(blob, 'new-password')).access).toBe('both');
  });

  it('re-encrypts an encrypted input only with its current password', async () => {
    const engine = createFakeEngine();
    const file = createDemoFile('aes128.pdf');
    const operation = { kind: 'encrypt', options: aes256 } as const;
    expect(await codeOf(engine.process({ file, password: '', operation }))).toBe(
      'password-required',
    );
    expect(await codeOf(engine.process({ file, password: 'wrong', operation }))).toBe(
      'password-incorrect',
    );
    const result = await engine.process({ file, password: DEMO_PASSWORD, operation });
    expect((await engine.inspect(result.blob)).encryption!.algorithm).toBe('aes-256');
  });

  it('rejects unusable new passwords like the real engine', async () => {
    const engine = createFakeEngine();
    const file = createDemoFile('plain.pdf');
    const run = (options: Partial<EncryptOptions>) =>
      codeOf(
        engine.process({
          file,
          password: '',
          operation: { kind: 'encrypt', options: { ...aes256, ...options } },
        }),
      );
    expect(await run({ userPassword: '' })).toBe('password-missing');
    expect(await run({ algorithm: 'aes-128', userPassword: '密码' })).toBe(
      'password-not-encodable',
    );
    expect(await run({ algorithm: 'aes-128', userPassword: 'x'.repeat(33) })).toBe(
      'password-too-long',
    );
  });

  it.each([
    ['read-failed.pdf', 'read-failed'],
    ['out-of-memory.pdf', 'out-of-memory'],
  ])('fails %s part of the way through', async (name, code) => {
    const engine = createFakeEngine();
    const progress: number[] = [];
    const outcome = await codeOf(
      engine.process(
        { file: createDemoFile(name), password: '', operation: { kind: 'decrypt' } },
        { onProgress: (fraction) => progress.push(fraction) },
      ),
    );
    expect(outcome).toBe(code);
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.at(-1)).toBeLessThan(1);
  });

  it('reports a smaller output when asked to compress, and passes verify through', async () => {
    const engine = createFakeEngine();
    const request = {
      file: createDemoFile('needs-password.pdf'),
      password: DEMO_PASSWORD,
      operation: { kind: 'decrypt' } as const,
    };
    const plain = await engine.process(request);
    const compressed = await engine.process({
      ...request,
      output: { streams: 'compress', verify: false },
    });
    expect(compressed.outputSize).toBeLessThan(plain.outputSize);
    expect(compressed.verified).toBe(false);
  });

  it('records what it was asked to do', async () => {
    const engine = createFakeEngine();
    const file = createDemoFile('owner-only.pdf');
    await engine.inspect(file);
    await engine.process({ file, password: '', operation: { kind: 'decrypt' } });
    expect(engine.calls.inspect).toEqual(['owner-only.pdf']);
    expect(engine.calls.process).toEqual([
      { name: 'owner-only.pdf', password: '', operation: { kind: 'decrypt' }, output: undefined },
    ]);
  });
});

describe('fake engine: time, cancellation, availability', () => {
  it('aborts before, while waiting and while running', async () => {
    const engine = createFakeEngine({ concurrency: 1, hold: 0.5 });
    const file = createDemoFile('owner-only.pdf');
    const operation = { kind: 'decrypt' } as const;

    const before = new AbortController();
    before.abort();
    expect(
      await codeOf(engine.process({ file, password: '', operation }, { signal: before.signal })),
    ).toBe('cancelled');
    expect(await codeOf(engine.inspect(file, '', { signal: before.signal }))).toBe('cancelled');

    const running = new AbortController();
    const queued = new AbortController();
    const first = codeOf(
      engine.process({ file, password: '', operation }, { signal: running.signal }),
    );
    const second = codeOf(
      engine.process({ file, password: '', operation }, { signal: queued.signal }),
    );
    await settle();
    expect(engine.held).toBe(1);
    queued.abort();
    expect(await second).toBe('cancelled');
    running.abort();
    expect(await first).toBe('cancelled');
    expect(engine.held).toBe(0);

    // The place of the aborted job is free again.
    engine.release();
    expect(await codeOf(engine.process({ file, password: '', operation }))).toBe('resolved');
  });

  it('freezes at the requested fraction until released', async () => {
    const engine = createFakeEngine({ hold: 0.45, steps: 10 });
    const progress: number[] = [];
    const done = vi.fn();
    const job = engine
      .process(
        { file: createDemoFile('owner-only.pdf'), password: '', operation: { kind: 'decrypt' } },
        { onProgress: (fraction) => progress.push(fraction) },
      )
      .then(done);
    await settle();
    expect(engine.held).toBe(1);
    expect(progress.at(-1)).toBe(0.45);
    expect(done).not.toHaveBeenCalled();
    engine.release();
    await job;
    expect(progress.at(-1)).toBe(1);
    expect([...progress].sort((a, b) => a - b)).toEqual(progress);
  });

  it('can freeze inspections', async () => {
    const engine = createFakeEngine({ hold: 'inspect' });
    const done = vi.fn();
    const job = engine.inspect(createDemoFile('plain.pdf')).then(done);
    await settle();
    expect(done).not.toHaveBeenCalled();
    engine.release();
    await job;
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('runs at most `concurrency` jobs at a time, in order', async () => {
    const engine = createFakeEngine({ concurrency: 2, hold: 0.5 });
    const started: string[] = [];
    const run = (name: string) =>
      engine.process(
        { file: createDemoFile(name), password: '', operation: { kind: 'decrypt' } },
        { onProgress: () => started.includes(name) || started.push(name) },
      );
    const jobs = [run('owner-only.pdf'), run('slow.pdf'), run('owner-only-unrestricted.pdf')];
    await settle();
    expect(started).toEqual(['owner-only.pdf', 'slow.pdf']);
    engine.release();
    await Promise.all(jobs);
    expect(started).toEqual(['owner-only.pdf', 'slow.pdf', 'owner-only-unrestricted.pdf']);
  });

  it('takes the configured time, longer for slow files', async () => {
    vi.useFakeTimers();
    try {
      const engine = createFakeEngine({ processDelayMs: 1000, inspectDelayMs: 100, steps: 4 });
      const finished: string[] = [];
      const run = (name: string) =>
        engine
          .process({ file: createDemoFile(name), password: '', operation: { kind: 'decrypt' } })
          .then(() => finished.push(name));
      void run('owner-only.pdf');
      void run('slow.pdf');
      await vi.advanceTimersByTimeAsync(1099);
      expect(finished).toEqual([]);
      await vi.advanceTimersByTimeAsync(2);
      expect(finished).toEqual(['owner-only.pdf']);
      await vi.advanceTimersByTimeAsync(7000);
      expect(finished).toEqual(['owner-only.pdf', 'slow.pdf']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('can be unavailable, and recover', async () => {
    const engine = createFakeEngine({ unavailable: true });
    expect(await codeOf(engine.ready())).toBe('engine-unavailable');
    expect(await codeOf(engine.inspect(createDemoFile('plain.pdf')))).toBe('engine-unavailable');
    engine.setUnavailable(false);
    expect(await codeOf(engine.ready())).toBe('resolved');
  });

  it('cancels everything when disposed', async () => {
    const engine = createFakeEngine({ hold: 0.5 });
    const job = codeOf(
      engine.process({
        file: createDemoFile('owner-only.pdf'),
        password: '',
        operation: { kind: 'decrypt' },
      }),
    );
    await settle();
    engine.dispose();
    expect(await job).toBe('cancelled');
    expect(engine.disposed).toBe(true);
    expect(await codeOf(engine.inspect(createDemoFile('plain.pdf')))).toBe('cancelled');
  });

  it('accepts additional scenarios', async () => {
    const engine = createFakeEngine({
      scenarios: { 'custom.pdf': { encryption: null, pages: 99, pdfVersion: '1.5' } },
    });
    expect((await engine.inspect(createDemoFile('custom.pdf'))).pageCount).toBe(99);
  });
});

describe('development switches', () => {
  it('reads engine options from the address', () => {
    expect(fakeEngineOptionsFromUrl(new URLSearchParams('fake'))).toEqual({
      inspectDelayMs: 400,
      processDelayMs: 1500,
      steps: 30,
      hold: null,
      unavailable: false,
      mode: 'worker',
    });
    expect(
      fakeEngineOptionsFromUrl(
        new URLSearchParams('fake&hold=0.45&delay=0&inspect=20&unavailable&mainthread'),
      ),
    ).toEqual({
      inspectDelayMs: 20,
      processDelayMs: 0,
      steps: 30,
      hold: 0.45,
      unavailable: true,
      mode: 'main-thread',
    });
    expect(fakeEngineOptionsFromUrl(new URLSearchParams('fake&hold=inspect')).hold).toBe('inspect');
    for (const hold of ['0', '1', '7', '-0.2', 'abc', '']) {
      expect(fakeEngineOptionsFromUrl(new URLSearchParams({ fake: '', hold })).hold).toBeNull();
    }
    expect(fakeEngineOptionsFromUrl(new URLSearchParams('fake&delay=abc')).processDelayMs).toBe(
      1500,
    );
  });

  it('reads the demo files to load from the address', () => {
    expect(demoFileNamesFromUrl(new URLSearchParams('fake'))).toEqual([]);
    expect(demoFileNamesFromUrl(new URLSearchParams('fake&demo'))).toEqual(DEMO_FILE_NAMES);
    expect(
      demoFileNamesFromUrl(new URLSearchParams('fake&demo=plain.pdf,%20needs-password.pdf,')),
    ).toEqual(['plain.pdf', 'needs-password.pdf']);
  });
});

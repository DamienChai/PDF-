import { createPdfEngine, PdfEngineError } from '@engine';

const engine = createPdfEngine({ maxWorkers: 2 });
const input = document.getElementById('file') as HTMLInputElement;
const file = (): File => input.files![0]!;

async function sha256(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const fail = (error: unknown) =>
  error instanceof PdfEngineError
    ? { error: error.code, detail: error.detail }
    : { error: String(error) };

Object.assign(window, {
  engineCheck: {
    ready: () => engine.ready().catch(fail),
    inspect: (password = '') => engine.inspect(file(), password).catch(fail),
    async decrypt(password: string, hash = true) {
      const progress: number[] = [];
      const started = performance.now();
      try {
        const result = await engine.process(
          { file: file(), password, operation: { kind: 'decrypt' } },
          { onProgress: (f) => progress.push(f) },
        );
        const wallMs = performance.now() - started;
        const after = await engine.inspect(result.blob);
        return {
          inputSize: result.inputSize,
          outputSize: result.outputSize,
          blobSize: result.blob.size,
          blobType: result.blob.type,
          pageCount: result.pageCount,
          verified: result.verified,
          durationMs: result.durationMs,
          wallMs,
          progressCount: progress.length,
          progressLast: progress.at(-1),
          monotonic: progress.every((value, i) => i === 0 || value > progress[i - 1]!),
          afterEncrypted: after.encrypted,
          afterPages: after.pageCount,
          sha256: hash ? await sha256(result.blob) : null,
        };
      } catch (error) {
        return fail(error);
      }
    },
    async encryptRoundTrip(password: string) {
      try {
        const encrypted = await engine.process({
          file: file(),
          password,
          operation: {
            kind: 'encrypt',
            options: {
              algorithm: 'aes-256',
              userPassword: 'browser-user',
              ownerPassword: 'browser-owner',
              permissions: {
                print: 'low',
                modify: false,
                extract: false,
                annotate: true,
                fillForms: true,
                assemble: false,
                accessibility: true,
              },
              encryptMetadata: true,
            },
          },
        });
        const locked = await engine.inspect(encrypted.blob);
        const asUser = await engine.inspect(encrypted.blob, 'browser-user');
        const back = await engine.process({
          file: encrypted.blob,
          password: 'browser-owner',
          operation: { kind: 'decrypt' },
        });
        return {
          locked: locked.access,
          algorithm: locked.encryption?.algorithm,
          asUser: asUser.access,
          pages: back.pageCount,
          backAccess: back.input.access,
        };
      } catch (error) {
        return fail(error);
      }
    },
    async abort(password: string, afterMs: number) {
      const controller = new AbortController();
      const started = performance.now();
      const job = engine.process(
        { file: file(), password, operation: { kind: 'decrypt' } },
        { signal: controller.signal },
      );
      setTimeout(() => controller.abort(), afterMs);
      const outcome = await job.then(() => ({ error: 'completed' }), fail);
      const settledMs = performance.now() - started;
      // The engine must be usable again right away.
      const next = await engine.inspect(file(), password).catch(fail);
      return { outcome, settledMs, next };
    },
    async parallel(password: string, count: number) {
      const started = performance.now();
      const results = await Promise.all(
        Array.from({ length: count }, () =>
          engine
            .process({ file: file(), password, operation: { kind: 'decrypt' } })
            .then((r) => r.pageCount, fail),
        ),
      );
      return { results, wallMs: performance.now() - started };
    },
  },
});

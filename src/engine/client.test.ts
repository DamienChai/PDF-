/**
 * Tests of the worker pool in `client.ts`. Node has no Web Workers, so the workers are stand-ins:
 * either scripted by the test (to control timing, crashes and hangs exactly) or real engine hosts
 * running in-process behind the same channel interface.
 */
import { describe, expect, test } from 'vitest';
import { createEngineClient } from './client';
import { createLocalChannel } from './host';
import type { HostChannel, HostRequest, HostResponse } from './protocol';
import { fixture, fixtureBlob } from './test-support';
import { PdfEngineError, type EngineErrorCode, type InspectResult } from './types';

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

async function codeOf(promise: Promise<unknown>): Promise<EngineErrorCode | 'resolved'> {
  try {
    await promise;
    return 'resolved';
  } catch (error) {
    expect(error).toBeInstanceOf(PdfEngineError);
    return (error as PdfEngineError).code;
  }
}

const INSPECTED: InspectResult = {
  fileSize: 1,
  pdfVersion: '1.7',
  encrypted: false,
  access: 'none',
  opensWithoutPassword: true,
  encryption: null,
  pageCount: 1,
  linearized: false,
  warnings: [],
};

/** A worker stand-in that does nothing by itself: the test reads its inbox and sends replies. */
class ScriptedWorker implements HostChannel {
  onmessage: HostChannel['onmessage'] = null;
  onerror: HostChannel['onerror'] = null;
  readonly inbox: HostRequest[] = [];
  terminated = false;

  postMessage(request: HostRequest): void {
    this.inbox.push(request);
  }

  terminate(): void {
    this.terminated = true;
  }

  send(response: HostResponse): void {
    this.onmessage?.({ data: response });
  }

  crash(message = 'boom'): void {
    this.onerror?.({ message });
  }

  /** Jobs received so far (everything but the init message). */
  get jobs(): Exclude<HostRequest, { type: 'init' }>[] {
    return this.inbox.filter((r): r is Exclude<HostRequest, { type: 'init' }> => r.type !== 'init');
  }

  ready(): void {
    this.send({ type: 'ready', qpdfVersion: '12.4.2' });
  }

  finish(id: number): void {
    this.send({ type: 'inspected', id, result: INSPECTED });
  }
}

function scriptedPool(maxWorkers: number) {
  const workers: ScriptedWorker[] = [];
  const engine = createEngineClient(
    { maxWorkers },
    {
      spawnWorker: () => {
        const worker = new ScriptedWorker();
        workers.push(worker);
        return worker;
      },
    },
  );
  return { engine, workers };
}

const blob = new Blob(['x']);

describe('worker pool', () => {
  test('nothing is spawned until the engine is used', () => {
    const { workers } = scriptedPool(4);
    expect(workers).toHaveLength(0);
  });

  test('ready() spawns one worker and reports the pool', async () => {
    const { engine, workers } = scriptedPool(3);
    const ready = engine.ready();
    expect(workers).toHaveLength(1);
    expect(workers[0]!.inbox).toEqual([{ type: 'init' }]);
    workers[0]!.ready();
    expect(await ready).toEqual({ qpdfVersion: '12.4.2', concurrency: 3, mode: 'worker' });
    expect(await engine.ready()).toEqual({ qpdfVersion: '12.4.2', concurrency: 3, mode: 'worker' });
    expect(workers).toHaveLength(1);
  });

  test('workers are added on demand up to the limit, the rest waits in order', async () => {
    const { engine, workers } = scriptedPool(2);
    const results = [1, 2, 3, 4, 5].map((n) => engine.inspect(blob, `job${n}`));
    expect(workers).toHaveLength(2);
    expect(workers[0]!.jobs.map((j) => j.password)).toEqual(['job1']);
    expect(workers[1]!.jobs.map((j) => j.password)).toEqual(['job2']);

    // The second worker finishes first and gets the next job in line.
    workers[1]!.finish(workers[1]!.jobs[0]!.id);
    expect(workers[1]!.jobs.map((j) => j.password)).toEqual(['job2', 'job3']);
    workers[0]!.finish(workers[0]!.jobs[0]!.id);
    expect(workers[0]!.jobs.map((j) => j.password)).toEqual(['job1', 'job4']);
    workers[0]!.finish(workers[0]!.jobs[1]!.id);
    expect(workers[0]!.jobs.map((j) => j.password)).toEqual(['job1', 'job4', 'job5']);
    workers[1]!.finish(workers[1]!.jobs[1]!.id);
    workers[0]!.finish(workers[0]!.jobs[2]!.id);

    expect(await Promise.all(results)).toHaveLength(5);
    expect(workers).toHaveLength(2);
  });

  test('an idle worker is reused instead of spawning another', async () => {
    const { engine, workers } = scriptedPool(4);
    const first = engine.inspect(blob);
    workers[0]!.finish(workers[0]!.jobs[0]!.id);
    await first;
    const second = engine.inspect(blob);
    expect(workers).toHaveLength(1);
    workers[0]!.finish(workers[0]!.jobs[1]!.id);
    await second;
  });

  test('a reply for another job id is ignored', async () => {
    const { engine, workers } = scriptedPool(1);
    const job = engine.inspect(blob);
    const id = workers[0]!.jobs[0]!.id;
    workers[0]!.finish(id + 100);
    let settled = false;
    void job.then(() => (settled = true));
    await tick();
    expect(settled).toBe(false);
    workers[0]!.finish(id);
    await job;
  });
});

describe('progress', () => {
  test('is clamped, strictly increasing and ends at 1', async () => {
    const { engine, workers } = scriptedPool(1);
    const seen: number[] = [];
    const job = engine.process(
      { file: blob, password: '', operation: { kind: 'decrypt' } },
      { onProgress: (fraction) => seen.push(fraction) },
    );
    const worker = workers[0]!;
    const id = worker.jobs[0]!.id;
    for (const fraction of [0.1, 0.3, 0.2, 0.3, -1, 0.5, 7, 0.9]) {
      worker.send({ type: 'progress', id, fraction });
    }
    worker.send({ type: 'progress', id: id + 1, fraction: 0.99 }); // not this job
    worker.send({
      type: 'processed',
      id,
      result: {
        blob,
        inputSize: 1,
        outputSize: 1,
        durationMs: 1,
        input: INSPECTED,
        pageCount: 1,
        verified: true,
        warnings: [],
      },
    });
    await job;
    expect(seen).toEqual([0.1, 0.3, 0.5, 1]);
  });

  test('1 is reported even if the worker sent no progress', async () => {
    const { engine, workers } = scriptedPool(1);
    const seen: number[] = [];
    const job = engine.process(
      { file: blob, password: '', operation: { kind: 'decrypt' } },
      { onProgress: (fraction) => seen.push(fraction) },
    );
    const id = workers[0]!.jobs[0]!.id;
    workers[0]!.send({
      type: 'processed',
      id,
      result: {
        blob,
        inputSize: 1,
        outputSize: 1,
        durationMs: 1,
        input: INSPECTED,
        pageCount: 1,
        verified: true,
        warnings: [],
      },
    });
    await job;
    expect(seen).toEqual([1]);
  });

  test('a throwing listener does not break the job', async () => {
    const { engine, workers } = scriptedPool(1);
    const job = engine.process(
      { file: blob, password: '', operation: { kind: 'decrypt' } },
      {
        onProgress: () => {
          throw new Error('listener bug');
        },
      },
    );
    const id = workers[0]!.jobs[0]!.id;
    workers[0]!.send({ type: 'progress', id, fraction: 0.5 });
    workers[0]!.send({ type: 'failed', id, code: 'damaged', detail: 'bad xref' });
    await expect(job).rejects.toMatchObject({ code: 'damaged', detail: 'bad xref' });
  });
});

describe('cancellation', () => {
  test('aborting a running job terminates its worker; the next job gets a new one', async () => {
    const { engine, workers } = scriptedPool(1);
    const controller = new AbortController();
    const running = engine.inspect(blob, 'a', { signal: controller.signal });
    const queued = engine.inspect(blob, 'b');
    expect(workers).toHaveLength(1);

    controller.abort();
    expect(await codeOf(running)).toBe('cancelled');
    expect(workers[0]!.terminated).toBe(true);
    // The queued job moved to a fresh worker.
    expect(workers).toHaveLength(2);
    expect(workers[1]!.jobs.map((j) => j.password)).toEqual(['b']);
    workers[1]!.finish(workers[1]!.jobs[0]!.id);
    await queued;

    // A late reply from the terminated worker changes nothing.
    workers[0]!.finish(workers[0]!.jobs[0]!.id);
  });

  test('aborting a queued job only removes it from the queue', async () => {
    const { engine, workers } = scriptedPool(1);
    const controller = new AbortController();
    const running = engine.inspect(blob, 'a');
    const queued = engine.inspect(blob, 'b', { signal: controller.signal });
    const last = engine.inspect(blob, 'c');
    controller.abort();
    expect(await codeOf(queued)).toBe('cancelled');
    expect(workers[0]!.terminated).toBe(false);
    workers[0]!.finish(workers[0]!.jobs[0]!.id);
    await running;
    expect(workers[0]!.jobs.map((j) => j.password)).toEqual(['a', 'c']);
    workers[0]!.finish(workers[0]!.jobs[1]!.id);
    await last;
    expect(workers).toHaveLength(1);
  });

  test('aborting after completion is harmless', async () => {
    const { engine, workers } = scriptedPool(1);
    const controller = new AbortController();
    const job = engine.inspect(blob, '', { signal: controller.signal });
    workers[0]!.finish(workers[0]!.jobs[0]!.id);
    await job;
    controller.abort();
    expect(workers[0]!.terminated).toBe(false);
  });

  test('dispose terminates the workers and cancels everything', async () => {
    const { engine, workers } = scriptedPool(2);
    const jobs = [engine.inspect(blob), engine.inspect(blob), engine.inspect(blob)];
    engine.dispose();
    expect(workers.every((w) => w.terminated)).toBe(true);
    for (const job of jobs) {
      expect(await codeOf(job)).toBe('cancelled');
    }
    expect(await codeOf(engine.inspect(blob))).toBe('cancelled');
    engine.dispose();
  });
});

describe('failures', () => {
  test('a crashing worker fails its job with "internal" and is replaced', async () => {
    const { engine, workers } = scriptedPool(1);
    const first = engine.inspect(blob, 'a');
    workers[0]!.ready();
    const second = engine.inspect(blob, 'b');
    workers[0]!.crash('RuntimeError: unreachable');

    await expect(first).rejects.toMatchObject({ code: 'internal' });
    expect(workers[0]!.terminated).toBe(true);
    expect(workers).toHaveLength(2);
    workers[1]!.finish(workers[1]!.jobs[0]!.id);
    expect((await second).pageCount).toBe(1);
  });

  test('a worker that cannot load the engine reports engine-unavailable', async () => {
    const { engine, workers } = scriptedPool(1);
    const ready = engine.ready();
    const job = engine.inspect(blob);
    workers[0]!.send({ type: 'unavailable', detail: 'HTTP 404 for pdfx.wasm' });
    workers[0]!.send({
      type: 'failed',
      id: workers[0]!.jobs[0]!.id,
      code: 'engine-unavailable',
      detail: 'HTTP 404 for pdfx.wasm',
    });
    await expect(ready).rejects.toMatchObject({ code: 'engine-unavailable' });
    expect(await codeOf(job)).toBe('engine-unavailable');
  });

  test('ready() asks again after the module could not be loaded', async () => {
    const { engine, workers } = scriptedPool(1);
    const first = engine.ready();
    workers[0]!.send({ type: 'unavailable', detail: 'offline' });
    await expect(first).rejects.toMatchObject({ code: 'engine-unavailable', detail: 'offline' });

    const second = engine.ready();
    expect(workers[0]!.inbox).toEqual([{ type: 'init' }, { type: 'init' }]);
    workers[0]!.ready();
    expect((await second).qpdfVersion).toBe('12.4.2');
    expect(workers).toHaveLength(1);
  });

  test('ready() is not affected by another job being aborted', async () => {
    const { engine, workers } = scriptedPool(1);
    const controller = new AbortController();
    const job = engine.inspect(blob, '', { signal: controller.signal });
    const ready = engine.ready(); // waits for the worker that is about to be terminated
    controller.abort();
    expect(await codeOf(job)).toBe('cancelled');
    await tick();
    expect(workers).toHaveLength(2);
    workers[1]!.ready();
    expect(await ready).toMatchObject({ mode: 'worker', qpdfVersion: '12.4.2' });
  });

  test('if no worker ever starts, the engine continues in the calling thread', async () => {
    const f = fixture('aes-256-r6.pdf');
    const { engine, workers } = scriptedPool(2);
    const inspect = engine.inspect(fixtureBlob(f.file), f.userPassword!);
    const process = engine.process({
      file: fixtureBlob(f.file),
      password: f.userPassword!,
      operation: { kind: 'decrypt' },
    });
    expect(workers).toHaveLength(2);
    // The worker script fails to load: an error event before any message.
    workers[0]!.crash('Failed to load module script');

    expect((await inspect).access).toBe('user');
    expect((await process).pageCount).toBe(f.pageCount);
    expect(workers.every((w) => w.terminated)).toBe(true);
    expect(workers).toHaveLength(2); // no further attempts
    expect(await engine.ready()).toMatchObject({ mode: 'main-thread', concurrency: 1 });
    engine.dispose();
  });

  test('ready() survives the switch to the calling thread', async () => {
    const { engine, workers } = scriptedPool(2);
    const ready = engine.ready();
    workers[0]!.crash();
    expect(await ready).toEqual({ qpdfVersion: '12.4.2', concurrency: 1, mode: 'main-thread' });
    engine.dispose();
  });

  test('if workers cannot even be constructed, the engine runs in the calling thread', async () => {
    const f = fixture('rc4-128-r3.pdf');
    const engine = createEngineClient(
      {},
      {
        spawnWorker: () => {
          throw new DOMException('blocked by policy', 'SecurityError');
        },
      },
    );
    const result = await engine.inspect(fixtureBlob(f.file), f.ownerPassword!);
    expect(result.access).toBe('owner');
    expect(await engine.ready()).toMatchObject({ mode: 'main-thread', concurrency: 1 });
    engine.dispose();
  });

  test('a request that cannot be posted fails only that job', async () => {
    const worker = new ScriptedWorker();
    let fail = true;
    const original = worker.postMessage.bind(worker);
    worker.postMessage = (request) => {
      if (request.type !== 'init' && fail) {
        fail = false;
        throw new DOMException('could not be cloned', 'DataCloneError');
      }
      original(request);
    };
    const engine = createEngineClient({ maxWorkers: 1 }, { spawnWorker: () => worker });
    expect(await codeOf(engine.inspect(blob))).toBe('internal');
    const next = engine.inspect(blob);
    worker.finish(worker.jobs[0]!.id);
    await next;
  });
});

describe('with real engine hosts as workers', () => {
  /** A real host; `hang` makes it swallow jobs so that they can be aborted "mid-run". */
  function realPool(maxWorkers: number) {
    const channels: (HostChannel & { hang: boolean; terminated: boolean })[] = [];
    const engine = createEngineClient(
      { maxWorkers },
      {
        spawnWorker: () => {
          const inner = createLocalChannel();
          const channel = {
            hang: false,
            terminated: false,
            onmessage: null as HostChannel['onmessage'],
            onerror: null as HostChannel['onerror'],
            postMessage(request: HostRequest) {
              if (!(channel.hang && request.type !== 'init')) {
                inner.postMessage(request);
              }
            },
            terminate() {
              channel.terminated = true;
              inner.terminate();
            },
          };
          inner.onmessage = (event) => channel.onmessage?.(event);
          channels.push(channel);
          return channel;
        },
      },
    );
    return { engine, channels };
  }

  test('jobs spread over the pool and all complete', async () => {
    const { engine, channels } = realPool(3);
    const info = await engine.ready();
    expect(info).toEqual({ qpdfVersion: '12.4.2', concurrency: 3, mode: 'worker' });
    const files = [
      'aes-256-r6.pdf',
      'aes-128-r4.pdf',
      'rc4-128-r3.pdf',
      'objstm-r6.pdf',
      'linearized-r6.pdf',
      'attachment-r4.pdf',
    ];
    const results = await Promise.all(
      files.map((name) => {
        const f = fixture(name);
        return engine.process({
          file: fixtureBlob(name),
          password: f.userPassword!,
          operation: { kind: 'decrypt' },
        });
      }),
    );
    results.forEach((result, i) => {
      expect(result.inputSize).toBe(fixture(files[i]!).size);
      expect(result.verified).toBe(true);
    });
    expect(channels).toHaveLength(3);
    engine.dispose();
    expect(channels.every((c) => c.terminated)).toBe(true);
  });

  test('abort mid-run, then carry on with a new worker', async () => {
    const { engine, channels } = realPool(1);
    const f = fixture('aes-256-r6.pdf');
    await engine.ready();
    channels[0]!.hang = true;
    const controller = new AbortController();
    const stuck = engine.process(
      { file: fixtureBlob(f.file), password: f.userPassword!, operation: { kind: 'decrypt' } },
      { signal: controller.signal },
    );
    await tick();
    controller.abort();
    expect(await codeOf(stuck)).toBe('cancelled');
    expect(channels[0]!.terminated).toBe(true);

    const result = await engine.process({
      file: fixtureBlob(f.file),
      password: f.userPassword!,
      operation: { kind: 'decrypt' },
    });
    expect(result.pageCount).toBe(f.pageCount);
    expect(channels).toHaveLength(2);
    engine.dispose();
  });
});

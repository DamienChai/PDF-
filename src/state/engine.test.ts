import { describe, expect, it, vi } from 'vitest';
import { PdfEngineError } from '../engine/types';
import {
  FAKE_QPDF_VERSION,
  createDemoFile,
  createFakeEngine,
  type FakeEngine,
} from '../../tests/support/fake-engine';
import { createEngineState, engineState, isFakeEngineRequested } from './engine';

function setup(options: Parameters<typeof createFakeEngine>[0] = {}) {
  let fake: FakeEngine | undefined;
  const create = vi.fn(() => (fake = createFakeEngine(options)));
  const idle: Array<() => void> = [];
  const state = createEngineState({ create, whenIdle: (callback) => idle.push(callback) });
  return { state, create, idle, fake: () => fake! };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'resolved';
  } catch (error) {
    return error instanceof PdfEngineError ? error.code : `not an engine error: ${String(error)}`;
  }
}

describe('engine state', () => {
  it('creates nothing until it is used', () => {
    const { state, create } = setup();
    expect(create).not.toHaveBeenCalled();
    expect(state.status.value).toBe('idle');
    expect(state.info.value).toBeNull();
  });

  it('loads on request and exposes the engine info', async () => {
    const { state, create } = setup();
    const loading = state.load();
    expect(state.status.value).toBe('loading');
    expect(await loading).toEqual({
      qpdfVersion: FAKE_QPDF_VERSION,
      concurrency: 2,
      mode: 'worker',
    });
    expect(state.status.value).toBe('ready');
    expect(state.info.value?.qpdfVersion).toBe(FAKE_QPDF_VERSION);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('shares one load between concurrent callers and creates one engine', async () => {
    const { state, create, fake } = setup();
    const [a, b] = await Promise.all([state.load(), state.load()]);
    expect(a).toBe(b);
    await state.engine.inspect(createDemoFile('plain.pdf'));
    expect(create).toHaveBeenCalledTimes(1);
    expect(fake().calls.ready).toBe(1);
  });

  it('preloads once the browser is idle, and only once', async () => {
    const { state, create, idle } = setup();
    state.preload();
    state.preload();
    expect(idle).toHaveLength(1);
    expect(create).not.toHaveBeenCalled();
    idle[0]!();
    await vi.waitFor(() => expect(state.status.value).toBe('ready'));
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('does not preload again when the engine was used in the meantime', async () => {
    const { state, idle, fake } = setup();
    state.preload();
    await state.load();
    idle[0]!();
    await Promise.resolve();
    expect(fake().calls.ready).toBe(1);
  });

  it('creates the engine by the first call and learns its info from there', async () => {
    const { state, create } = setup();
    const result = await state.engine.inspect(createDemoFile('needs-password.pdf'));
    expect(result.access).toBe('locked');
    expect(create).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(state.status.value).toBe('ready'));
    expect(state.info.value).not.toBeNull();
  });

  it('passes calls through unchanged, including progress and abort', async () => {
    const { state, fake } = setup({ hold: 0.5 });
    const controller = new AbortController();
    const progress: number[] = [];
    const job = codeOf(
      state.engine.process(
        { file: createDemoFile('owner-only.pdf'), password: '', operation: { kind: 'decrypt' } },
        { signal: controller.signal, onProgress: (fraction) => progress.push(fraction) },
      ),
    );
    await vi.waitFor(() => expect(fake().held).toBe(1));
    expect(progress.at(-1)).toBe(0.5);
    controller.abort();
    expect(await job).toBe('cancelled');
    expect(state.status.value).not.toBe('unavailable');
  });

  it('reports an engine that cannot be loaded, and recovers on retry', async () => {
    const { state, fake } = setup({ unavailable: true });
    expect(await state.load()).toBeNull();
    expect(state.status.value).toBe('unavailable');
    expect(state.failure.value).toContain('unavailable');
    expect(state.info.value).toBeNull();

    fake().setUnavailable(false);
    expect(await state.retry()).not.toBeNull();
    expect(state.status.value).toBe('ready');
    expect(state.failure.value).toBeNull();
  });

  it('notices unavailability from a failing call', async () => {
    const { state } = setup({ unavailable: true });
    expect(await codeOf(state.engine.inspect(createDemoFile('plain.pdf')))).toBe(
      'engine-unavailable',
    );
    expect(state.status.value).toBe('unavailable');
  });

  it('does not mistake other failures for unavailability', async () => {
    const { state } = setup();
    expect(await codeOf(state.engine.inspect(createDemoFile('damaged.pdf')))).toBe('damaged');
    expect(state.status.value).not.toBe('unavailable');
  });

  it('turns a failing factory into engine-unavailable and tries it again next time', async () => {
    let attempts = 0;
    const state = createEngineState({
      create: () => {
        if (++attempts === 1) throw new TypeError('Failed to fetch dynamically imported module');
        return createFakeEngine();
      },
    });
    expect(await codeOf(state.engine.inspect(createDemoFile('plain.pdf')))).toBe(
      'engine-unavailable',
    );
    expect(state.status.value).toBe('unavailable');
    expect(state.failure.value).toContain('Failed to fetch');
    expect(await codeOf(state.engine.inspect(createDemoFile('plain.pdf')))).toBe('resolved');
    await vi.waitFor(() => expect(state.status.value).toBe('ready'));
    expect(attempts).toBe(2);
  });

  it('accepts an asynchronous factory', async () => {
    const state = createEngineState({ create: async () => createFakeEngine() });
    expect((await state.load())?.qpdfVersion).toBe(FAKE_QPDF_VERSION);
  });

  it('disposes the real engine and refuses further calls', async () => {
    const { state, fake } = setup();
    await state.load();
    // Disposing through the facade is deliberately a no-op.
    state.engine.dispose();
    expect(fake().disposed).toBe(false);
    state.dispose();
    await vi.waitFor(() => expect(fake().disposed).toBe(true));
    expect(await codeOf(state.engine.inspect(createDemoFile('plain.pdf')))).toBe('cancelled');
    expect(state.status.value).toBe('ready');
  });

  it('disposing before first use creates nothing', async () => {
    const { state, create } = setup();
    state.dispose();
    expect(await state.load()).toBeNull();
    expect(create).not.toHaveBeenCalled();
    expect(state.status.value).toBe('idle');
  });
});

describe('the app engine', () => {
  it('is not created by importing the module', () => {
    expect(engineState.status.value).toBe('idle');
  });

  it('never asks for the fake engine outside a browser page', () => {
    expect(isFakeEngineRequested()).toBe(false);
  });
});

/** The file list: taking files in, and the Unlock state machine. */
import { describe, expect, it } from 'vitest';
import { ALL_PERMISSIONS } from '../engine/types';
import {
  DEMO_PASSWORD,
  FAKE_SCENARIOS,
  createDemoFile,
  type FakeScenario,
} from '../../tests/support/fake-engine';
import { createHarness, tick } from '../../tests/support/jobs-harness';

/** A second locked file with a password of its own. */
const OTHER: Record<string, FakeScenario> = {
  'other-password.pdf': {
    encryption: {
      algorithm: 'aes-128',
      keyBits: 128,
      revision: 4,
      userPassword: '9999',
      ownerPassword: 'owner',
      permissions: { ...ALL_PERMISSIONS },
    },
    pages: 2,
    pdfVersion: '1.6',
  },
};

function pdfBytes(prefixLength = 0): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(prefixLength + 16);
  bytes.set(new TextEncoder().encode('%PDF-1.7\n'), prefixLength);
  return bytes;
}

describe('adding files', () => {
  it('gives every file an entry with a stable id, in order, and inspects it at once', async () => {
    const h = createHarness({ engine: { hold: 'inspect' } });
    const report = await h.jobs.addFiles(
      [createDemoFile('plain.pdf'), createDemoFile('needs-password.pdf')],
      'drop',
    );
    expect(report.added.map((entry) => entry.name)).toEqual(['plain.pdf', 'needs-password.pdf']);
    expect(report).toMatchObject({ rejected: [], duplicates: [] });
    const [first, second] = h.jobs.entries.value;
    expect(first!.id).not.toBe(second!.id);
    expect(first).toMatchObject({ name: 'plain.pdf', size: 482_113, source: 'drop' });
    expect(h.jobs.find(first!.id)).toBe(first);
    expect(h.states()).toEqual(['analysing', 'analysing']);
    expect(h.engine.calls.inspect).toEqual(['plain.pdf', 'needs-password.pdf']);

    h.engine.release();
    await h.jobs.settled();
    expect(h.states()).toEqual(['not-encrypted', 'needs-password']);
    // The same objects: components can key on them.
    expect(h.jobs.entries.value[0]).toBe(first);
  });

  it('accepts a FileList-like object', async () => {
    const h = createHarness();
    const fileList = { 0: createDemoFile('plain.pdf'), length: 1 };
    await h.jobs.addFiles(fileList, 'picker');
    expect(h.jobs.entries.value).toHaveLength(1);
  });

  it('decides by content, not by name or type', async () => {
    const h = createHarness();
    const disguised = new File([pdfBytes()], 'scan.bin', { type: 'application/octet-stream' });
    const untyped = new File([pdfBytes()], 'shared', { type: '' });
    const fake = new File(['PK\u0003\u0004 not a pdf'], 'report.pdf', { type: 'application/pdf' });
    const report = await h.jobs.addFiles([disguised, untyped, fake], 'share-target');
    expect(report.added.map((entry) => entry.name)).toEqual(['scan.bin', 'shared']);
    expect(report.rejected).toEqual(['report.pdf']);
    expect(h.toasts.toasts.value).toMatchObject([
      { message: { key: 'toast.notPdf', params: { name: 'report.pdf' } }, tone: 'error' },
    ]);
  });

  it('finds the header anywhere in the first 1024 bytes, and nowhere else', async () => {
    const h = createHarness();
    const report = await h.jobs.addFiles(
      [
        new File([pdfBytes(1019)], 'junk-prefix.pdf'),
        new File([pdfBytes(1020)], 'too-late.pdf'),
        new File([], 'empty.pdf'),
        new File(['%PDF'], 'cut-off.pdf'),
      ],
      'picker',
    );
    expect(report.added.map((entry) => entry.name)).toEqual(['junk-prefix.pdf']);
    expect(report.rejected).toEqual(['too-late.pdf', 'empty.pdf', 'cut-off.pdf']);
  });

  it('reports all rejected files of a batch with one toast', async () => {
    const h = createHarness();
    await h.jobs.addFiles(
      [new File(['a'], 'a.txt'), createDemoFile('plain.pdf'), new File(['b'], 'b.png')],
      'drop',
    );
    expect(h.toasts.toasts.value).toMatchObject([
      { message: { key: 'toast.notPdfCount', params: { count: 2 } } },
    ]);
    expect(h.jobs.entries.value).toHaveLength(1);
  });

  it('skips files that are already in the list or repeated in the batch', async () => {
    const h = createHarness();
    await h.add('plain.pdf');
    const report = await h.jobs.addFiles(
      [createDemoFile('plain.pdf'), createDemoFile('aes128.pdf'), createDemoFile('aes128.pdf')],
      'picker',
    );
    expect(report.added.map((entry) => entry.name)).toEqual(['aes128.pdf']);
    expect(report.duplicates).toEqual(['plain.pdf', 'aes128.pdf']);
    expect(h.toastKeys()).toEqual(['toast.duplicateCount']);

    await h.jobs.addFiles([createDemoFile('plain.pdf')], 'picker');
    expect(h.toasts.toasts.value.at(-1)).toMatchObject({
      message: { key: 'toast.duplicate', params: { name: 'plain.pdf' } },
      tone: 'neutral',
    });
    expect(h.jobs.entries.value).toHaveLength(2);
  });

  it('treats the same name with another size or date as a different file', async () => {
    const h = createHarness();
    await h.jobs.addFiles(
      [
        createDemoFile('plain.pdf'),
        createDemoFile('plain.pdf', { lastModified: 1 }),
        createDemoFile('plain.pdf', { size: 2000 }),
      ],
      'picker',
    );
    expect(h.jobs.entries.value).toHaveLength(3);
    expect(h.toastKeys()).toEqual([]);
  });

  it('does not let two overlapping calls add the same file twice', async () => {
    const h = createHarness();
    await Promise.all([
      h.jobs.addFiles([createDemoFile('plain.pdf')], 'drop'),
      h.jobs.addFiles([createDemoFile('plain.pdf')], 'paste'),
    ]);
    expect(h.jobs.entries.value).toHaveLength(1);
  });

  it('lets the engine explain a file the browser cannot read', async () => {
    const h = createHarness({
      engine: {
        scenarios: {
          'gone.pdf': {
            encryption: null,
            pages: 0,
            pdfVersion: '',
            inspectError: { code: 'read-failed', detail: 'NotFoundError' },
          },
        },
      },
    });
    const file = createDemoFile('gone.pdf');
    file.slice = () => {
      throw new DOMException('gone', 'NotFoundError');
    };
    const report = await h.jobs.addFiles([file], 'file-handler');
    await h.jobs.settled();
    expect(report.rejected).toEqual([]);
    expect(h.view('gone.pdf')).toMatchObject({
      state: 'error',
      error: { code: 'read-failed', detail: 'NotFoundError' },
      canRetry: true,
    });
  });

  it('does nothing for an empty batch', async () => {
    const h = createHarness();
    expect(await h.jobs.addFiles([], 'picker')).toEqual({
      added: [],
      rejected: [],
      duplicates: [],
    });
    expect(h.jobs.summary.value).toMatchObject({ phase: 'empty', total: 0, primary: null });
  });
});

describe('unlock: card states', () => {
  it('a. analysing', async () => {
    const h = createHarness({ engine: { hold: 'inspect' } });
    await h.jobs.addFiles([createDemoFile('needs-password.pdf')], 'picker');
    expect(h.view('needs-password.pdf')).toMatchObject({
      state: 'analysing',
      chip: { label: { key: 'chip.analysing' }, tone: 'neutral' },
      algorithm: null,
      pageCount: null,
      password: null,
      canShowDetails: false,
      canCancel: false,
    });
    expect(h.jobs.summary.value).toMatchObject({
      phase: 'analysing',
      analysing: 1,
      primary: null,
      passwordField: false,
      status: { key: 'status.analysing' },
    });
  });

  it('b. needs password', async () => {
    const h = createHarness();
    await h.add('needs-password.pdf');
    expect(h.view('needs-password.pdf')).toMatchObject({
      state: 'needs-password',
      chip: { label: { key: 'chip.needsPassword' }, tone: 'warning' },
      algorithm: { label: { key: 'algorithm.chip.aes-256' }, outdated: false },
      note: null,
      password: null,
      pageCount: null,
      canShowDetails: true,
    });
    expect(h.jobs.summary.value).toMatchObject({
      phase: 'ready',
      needPassword: 1,
      actionable: 1,
      passwordField: true,
      passwordHint: null,
      passwordError: null,
      primary: { kind: 'unlock', label: { key: 'action.unlock' }, count: 1, enabled: false },
    });
    h.jobs.setUnlockPassword('x');
    expect(h.jobs.summary.value.primary!.enabled).toBe(true);
  });

  it('marks outdated algorithms on the chip', async () => {
    const h = createHarness();
    await h.add('rc4.pdf', 'rc4-40.pdf', 'aes128.pdf');
    expect(h.view('rc4.pdf').algorithm).toEqual({
      label: { key: 'algorithm.chip.rc4', params: { bits: 128 } },
      outdated: true,
    });
    expect(h.view('rc4-40.pdf').algorithm!.label.params).toEqual({ bits: 40 });
    expect(h.view('aes128.pdf').algorithm).toEqual({
      label: { key: 'algorithm.chip.aes-128' },
      outdated: false,
    });
  });

  it('c. restrictions only: one tap, no password', async () => {
    const h = createHarness();
    await h.add('owner-only.pdf');
    expect(h.view('owner-only.pdf')).toMatchObject({
      state: 'restricted',
      chip: { label: { key: 'chip.restricted' }, tone: 'info' },
      note: { list: [{ key: 'restriction.print' }, { key: 'restriction.extract' }] },
      pageCount: 31,
      password: null,
    });
    expect(h.jobs.summary.value).toMatchObject({
      phase: 'ready',
      restricted: 1,
      needPassword: 0,
      passwordField: false,
      primary: {
        kind: 'remove-restrictions',
        label: { key: 'action.removeRestrictions' },
        count: 1,
        enabled: true,
      },
    });
  });

  it('c. says so when an owner password restricts nothing', async () => {
    const h = createHarness();
    await h.add('owner-only-unrestricted.pdf');
    expect(h.view('owner-only-unrestricted.pdf').note).toEqual({
      key: 'entry.note.noRestrictions',
    });
  });

  it('d. not encrypted: nothing to do, and a way out', async () => {
    const h = createHarness();
    await h.add('plain.pdf');
    expect(h.view('plain.pdf')).toMatchObject({
      state: 'not-encrypted',
      chip: { label: { key: 'chip.notEncrypted' }, tone: 'neutral' },
      note: { key: 'entry.note.nothingToUnlock' },
      algorithm: null,
      pageCount: 12,
    });
    expect(h.jobs.summary.value).toMatchObject({
      phase: 'idle',
      notEncrypted: 1,
      primary: null,
      status: { key: 'status.nothingToUnlock' },
      suggestion: { label: { key: 'action.switchToLock' }, mode: 'lock' },
    });
    expect((await h.jobs.unlockAll('x')).refusal).toBe('nothing-to-do');
    expect(h.engine.calls.process).toEqual([]);
  });

  it('e. processing: queued, then running with progress', async () => {
    const h = createHarness({ engine: { hold: 0.5, concurrency: 1, steps: 10 } });
    await h.add('owner-only.pdf', 'slow.pdf');
    const run = h.jobs.unlockAll();
    await tick();
    expect(h.view('owner-only.pdf')).toMatchObject({
      state: 'processing',
      queued: false,
      chip: { label: { key: 'chip.processing' } },
      canCancel: true,
      note: null,
      algorithm: { label: { key: 'algorithm.chip.aes-256' } },
    });
    expect(h.entry('owner-only.pdf').progress.value).toBe(0.5);
    expect(h.view('slow.pdf')).toMatchObject({
      state: 'processing',
      queued: true,
      chip: { label: { key: 'chip.queued' } },
    });
    expect(h.entry('slow.pdf').progress.value).toBe(0);
    expect(h.jobs.summary.value).toMatchObject({
      phase: 'processing',
      processing: 2,
      canCancelAll: true,
      status: { key: 'status.processingCount', params: { done: 0, total: 2 } },
    });
    // Nothing else could be started: there is no primary action while everything is busy.
    expect(h.jobs.summary.value.primary).toBeNull();
    expect(h.jobs.overallProgress.value).toBe(0.25);

    h.engine.release();
    await run;
    expect(h.states()).toEqual(['done', 'done']);
    expect(h.jobs.overallProgress.value).toBe(1);
  });

  it('e. says just "processing" for a single file', async () => {
    const h = createHarness({ engine: { hold: 0.5 } });
    await h.add('owner-only.pdf');
    const run = h.jobs.unlockAll();
    await tick();
    expect(h.jobs.summary.value.status).toEqual({ key: 'status.processing' });
    h.engine.release();
    await run;
  });

  it('f. done', async () => {
    const h = createHarness();
    await h.add('needs-password.pdf');
    h.jobs.setUnlockPassword(DEMO_PASSWORD);
    const report = await h.jobs.unlockAll();
    expect(report).toEqual({ started: true, done: 1, rejected: 0, failed: 0, cancelled: 0 });
    const view = h.view('needs-password.pdf');
    expect(view).toMatchObject({
      state: 'done',
      chip: { label: { key: 'chip.unlocked' }, tone: 'success' },
      algorithm: null,
      pageCount: 4,
      canRedo: true,
      canCancel: false,
      result: {
        name: 'needs-password_unlocked.pdf',
        inputSize: 1_288_490,
        pageCount: 4,
        verified: true,
        saved: false,
        canShare: true,
      },
    });
    expect(view.result!.size).toBeGreaterThan(0);
    expect(view.result!.durationMs).toBeGreaterThanOrEqual(0);
    expect(h.entry('needs-password.pdf').progress.value).toBe(1);
    expect(h.jobs.summary.value).toMatchObject({
      phase: 'finished',
      done: 1,
      primary: null,
      passwordField: false,
      status: { key: 'status.unlocked', params: { count: 1 } },
      results: { count: 1, unsaved: 1 },
      canSaveAll: true,
      canShareAll: true,
      canSaveToFolder: false,
      canClear: true,
    });
  });

  it('g. wrong password on the only locked file: retry with the same field', async () => {
    const h = createHarness();
    await h.add('needs-password.pdf');
    h.jobs.setUnlockPassword('nope');
    h.jobs.setUnlockRevealed(true);
    const report = await h.jobs.unlockAll();
    expect(report).toMatchObject({ started: true, done: 0, rejected: 1 });
    expect(h.view('needs-password.pdf')).toMatchObject({
      state: 'wrong-password',
      chip: { label: { key: 'chip.wrongPassword' }, tone: 'danger' },
      // No second field for a single file: the action area's field is right there.
      password: null,
      algorithm: { label: { key: 'algorithm.chip.aes-256' } },
    });
    expect(h.jobs.summary.value).toMatchObject({
      phase: 'ready',
      needPassword: 1,
      passwordField: true,
      passwordError: { key: 'unlock.password.wrong' },
      primary: { kind: 'unlock', enabled: true },
    });
    // The typo can be fixed in place.
    expect(h.jobs.unlockPassword.value).toBe('nope');
    expect(h.jobs.unlockRevealed.value).toBe(true);

    h.jobs.setUnlockPassword(DEMO_PASSWORD);
    expect(h.jobs.summary.value.passwordError).toBeNull();
    await h.jobs.unlockAll();
    expect(h.states()).toEqual(['done']);
    expect(h.jobs.unlockPassword.value).toBe('');
    expect(h.jobs.unlockRevealed.value).toBe(false);
  });

  it('g. wrong password among several: inline retry on each card', async () => {
    const h = createHarness({ engine: { scenarios: OTHER } });
    await h.add('needs-password.pdf', 'other-password.pdf', 'aes128.pdf');
    expect(h.jobs.summary.value).toMatchObject({
      needPassword: 3,
      passwordHint: { key: 'unlock.password.sharedHint' },
      primary: { label: { key: 'action.unlockCount', params: { count: 3 } }, count: 3 },
    });

    h.jobs.setUnlockPassword('nope');
    await h.jobs.unlockAll();
    expect(h.states()).toEqual(['wrong-password', 'wrong-password', 'wrong-password']);
    expect(h.view('needs-password.pdf').password).toEqual({
      kind: 'retry',
      label: { key: 'entry.password.label' },
      placeholder: { key: 'entry.password.placeholder' },
      hint: null,
      error: { key: 'entry.password.wrong' },
      submitLabel: { key: 'entry.password.submit' },
    });
    expect(h.jobs.summary.value.passwordError).toEqual({ key: 'unlock.password.wrong' });

    // The shared field is tried on every file that is still locked.
    h.jobs.setUnlockPassword(DEMO_PASSWORD);
    const report = await h.jobs.unlockAll();
    expect(report).toMatchObject({ done: 2, rejected: 1 });
    expect(h.states()).toEqual(['done', 'wrong-password', 'done']);
    expect(h.jobs.unlockPassword.value).toBe('');
    expect(h.jobs.summary.value).toMatchObject({
      phase: 'ready',
      needPassword: 1,
      passwordError: null,
      results: { count: 2 },
      canSaveAll: true,
    });
    // One left: back to the shared field.
    expect(h.view('other-password.pdf').password).toBeNull();
  });

  it('g. retries one file with its own password', async () => {
    const h = createHarness({ engine: { scenarios: OTHER } });
    await h.add('needs-password.pdf', 'other-password.pdf', 'aes128.pdf');
    h.jobs.setUnlockPassword('nope');
    await h.jobs.unlockAll();
    const other = h.entry('other-password.pdf');

    expect(await h.jobs.retryUnlock(other.id, 'still wrong')).toMatchObject({ rejected: 1 });
    expect(other.view.value.state).toBe('wrong-password');
    expect(other.view.value.password).not.toBeNull();

    expect(await h.jobs.retryUnlock(other.id, '9999')).toMatchObject({ started: true, done: 1 });
    expect(h.states()).toEqual(['wrong-password', 'done', 'wrong-password']);
    expect(other.view.value.result!.name).toBe('other-password_unlocked.pdf');
    // The shared field was not involved.
    expect(h.jobs.unlockPassword.value).toBe('nope');
    expect(h.engine.calls.process.at(-1)).toMatchObject({
      name: 'other-password.pdf',
      password: '9999',
    });
  });

  it('g. refuses pointless retries', async () => {
    const h = createHarness();
    await h.add('needs-password.pdf', 'plain.pdf');
    const locked = h.entry('needs-password.pdf');
    expect((await h.jobs.retryUnlock(locked.id, '')).refusal).toBe('password-required');
    expect((await h.jobs.retryUnlock(h.entry('plain.pdf').id, 'x')).refusal).toBe('nothing-to-do');
    expect((await h.jobs.retryUnlock('no-such-id', 'x')).refusal).toBe('nothing-to-do');
    expect(h.engine.calls.process).toEqual([]);
  });

  it('h. error while inspecting', async () => {
    const h = createHarness();
    await h.add('damaged.pdf', 'unsupported.pdf');
    expect(h.view('damaged.pdf')).toMatchObject({
      state: 'error',
      chip: { label: { key: 'chip.error' }, tone: 'danger' },
      error: {
        code: 'damaged',
        title: { key: 'error.damaged.title' },
        advice: { key: 'error.damaged.advice' },
        detail: expect.stringContaining('trailer'),
      },
      canRetry: false,
      canShowDetails: false,
      algorithm: null,
      note: null,
    });
    expect(h.view('unsupported.pdf').error).toMatchObject({
      code: 'unsupported-encryption',
      title: { key: 'error.unsupported-encryption.title' },
    });
    expect(h.jobs.summary.value).toMatchObject({
      phase: 'idle',
      failed: 2,
      primary: null,
      status: { key: 'status.nothingToDo' },
      problems: { key: 'status.failed', params: { count: 2 } },
      suggestion: null,
    });
  });

  it('h. error while processing, and trying again', async () => {
    const h = createHarness();
    await h.add('read-failed.pdf');
    const report = await h.jobs.unlockAll();
    expect(report).toMatchObject({ started: true, done: 0, failed: 1 });
    const entry = h.entry('read-failed.pdf');
    expect(entry.view.value).toMatchObject({
      state: 'error',
      error: { code: 'read-failed', detail: expect.stringContaining('NotFoundError') },
      canRetry: true,
      result: null,
    });
    h.jobs.retry(entry.id);
    expect(entry.view.value.state).toBe('restricted');
    expect(entry.view.value.error).toBeNull();
  });

  it('turns anything that is not an engine error into "unknown"', async () => {
    const h = createHarness();
    await h.add('owner-only.pdf');
    h.engine.process = () => Promise.reject(new TypeError('boom'));
    await h.jobs.unlockAll();
    expect(h.view('owner-only.pdf').error).toMatchObject({
      code: 'unknown',
      title: { key: 'error.unknown.title' },
      detail: 'TypeError: boom',
    });
  });
});

describe('unlock: the engine being unavailable', () => {
  it('shows the failure on the card and inspects again on retry', async () => {
    const h = createHarness({ engine: { unavailable: true } });
    await h.add('needs-password.pdf', 'plain.pdf');
    expect(h.states()).toEqual(['error', 'error']);
    expect(h.view('plain.pdf')).toMatchObject({
      error: { code: 'engine-unavailable', title: { key: 'error.engine-unavailable.title' } },
      canRetry: true,
    });

    h.engine.setUnavailable(false);
    h.jobs.retry(h.entry('plain.pdf').id);
    expect(h.view('plain.pdf').state).toBe('analysing');
    await h.jobs.settled();
    expect(h.states()).toEqual(['error', 'not-encrypted']);

    h.jobs.retryInspections('engine-unavailable');
    await h.jobs.settled();
    expect(h.states()).toEqual(['needs-password', 'not-encrypted']);
  });

  it('only retries the inspections that failed for the given reason', async () => {
    const h = createHarness();
    await h.add('damaged.pdf', 'engine-unavailable.pdf');
    const before = h.engine.calls.inspect.length;
    h.jobs.retryInspections('engine-unavailable');
    await h.jobs.settled();
    expect(h.engine.calls.inspect.slice(before)).toEqual(['engine-unavailable.pdf']);
    h.jobs.retryInspections();
    await h.jobs.settled();
    expect(h.engine.calls.inspect.slice(before + 1)).toEqual([
      'damaged.pdf',
      'engine-unavailable.pdf',
    ]);
  });
});

describe('unlock: batches', () => {
  it('handles a mixed batch with one password', async () => {
    const h = createHarness({ engine: { scenarios: OTHER } });
    await h.add(
      'needs-password.pdf',
      'owner-only.pdf',
      'plain.pdf',
      'damaged.pdf',
      'other-password.pdf',
      'rc4.pdf',
    );
    expect(h.jobs.summary.value).toMatchObject({
      total: 6,
      needPassword: 3,
      restricted: 1,
      notEncrypted: 1,
      failed: 1,
      actionable: 4,
      primary: { kind: 'unlock', label: { key: 'action.unlockCount', params: { count: 4 } } },
    });
    h.jobs.setUnlockPassword(DEMO_PASSWORD);
    const report = await h.jobs.unlockAll();
    expect(report).toEqual({ started: true, done: 3, rejected: 1, failed: 0, cancelled: 0 });
    expect(h.states()).toEqual([
      'done',
      'done',
      'not-encrypted',
      'error',
      'wrong-password',
      'done',
    ]);
    expect(h.engine.calls.process.map((call) => [call.name, call.password])).toEqual([
      ['needs-password.pdf', DEMO_PASSWORD],
      // Restrictions only: no password is sent.
      ['owner-only.pdf', ''],
      ['other-password.pdf', DEMO_PASSWORD],
      ['rc4.pdf', DEMO_PASSWORD],
    ]);
    expect(h.jobs.summary.value).toMatchObject({
      phase: 'ready',
      done: 3,
      needPassword: 1,
      problems: { key: 'status.failed', params: { count: 1 } },
    });
  });

  it('processes restricted files even without a password, and leaves locked ones alone', async () => {
    const h = createHarness();
    await h.add('needs-password.pdf', 'owner-only.pdf');
    const report = await h.jobs.unlockAll('');
    expect(report).toMatchObject({ started: true, done: 1 });
    expect(h.states()).toEqual(['needs-password', 'done']);
  });

  it('asks for a password when only locked files are left', async () => {
    const h = createHarness();
    await h.add('needs-password.pdf');
    expect(await h.jobs.unlockAll()).toMatchObject({
      started: false,
      refusal: 'password-required',
    });
    expect(h.engine.calls.process).toEqual([]);
    expect(h.states()).toEqual(['needs-password']);
  });

  it('uses the shared field by default and an explicit password when given', async () => {
    const h = createHarness();
    await h.add('needs-password.pdf');
    h.jobs.setUnlockPassword('in-the-field');
    await h.jobs.unlockAll(DEMO_PASSWORD);
    expect(h.states()).toEqual(['done']);
    expect(h.engine.calls.process[0]!.password).toBe(DEMO_PASSWORD);
  });

  it('runPrimary unlocks in unlock mode', async () => {
    const h = createHarness();
    await h.add('owner-only.pdf');
    expect(await h.jobs.runPrimary()).toMatchObject({ started: true, done: 1 });
  });

  it('passes the output settings to the engine and always asks for verification', async () => {
    const h = createHarness();
    await h.add('owner-only.pdf', 'slow.pdf');
    await h.jobs.unlockAll();
    expect(h.engine.calls.process[0]!.output).toEqual({
      streams: 'preserve',
      linearize: false,
      verify: true,
    });
    h.settings.value = {
      ...h.settings.value,
      output: { optimizeSize: true, linearize: true },
    };
    h.jobs.redo(h.entry('slow.pdf').id);
    await h.jobs.unlockAll();
    expect(h.engine.calls.process.at(-1)!.output).toEqual({
      streams: 'compress',
      linearize: true,
      verify: true,
    });
  });

  it('does not start files that are still being analysed, and keeps the button disabled', async () => {
    const h = createHarness({ engine: { hold: 'inspect' } });
    await h.jobs.addFiles([createDemoFile('owner-only.pdf')], 'picker');
    expect((await h.jobs.unlockAll()).refusal).toBe('nothing-to-do');
    h.engine.release();
    await h.jobs.settled();

    h.engine.setHold('inspect');
    await h.jobs.addFiles([createDemoFile('slow.pdf')], 'picker');
    expect(h.jobs.summary.value).toMatchObject({
      phase: 'ready',
      analysing: 1,
      primary: { kind: 'remove-restrictions', enabled: false },
    });
    h.engine.release();
    await h.jobs.settled();
    expect(h.jobs.summary.value.primary).toMatchObject({ count: 2, enabled: true });
  });
});

describe('unlock: progress', () => {
  it('only ever moves forward during a run and starts again at zero', async () => {
    const h = createHarness({ engine: { steps: 6 } });
    await h.add('owner-only.pdf');
    const entry = h.entry('owner-only.pdf');
    const seen: number[] = [];
    const stop = entry.progress.subscribe((value) => seen.push(value));
    await h.jobs.unlockAll();
    expect(seen[0]).toBe(0);
    expect(seen.at(-1)).toBe(1);
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
    expect(seen.length).toBeGreaterThan(4);

    seen.length = 0;
    h.jobs.redo(entry.id);
    expect(entry.progress.value).toBe(0);
    await h.jobs.unlockAll();
    expect(seen[0]).toBe(0);
    expect(seen.at(-1)).toBe(1);
    stop();
  });

  it('ignores progress that arrives out of order', async () => {
    const h = createHarness();
    await h.add('owner-only.pdf');
    const original = h.engine.process;
    h.engine.process = (request, options) => {
      options?.onProgress?.(0.6);
      options?.onProgress?.(0.2);
      options?.onProgress?.(7);
      return original(request, { ...options, onProgress: undefined });
    };
    const entry = h.entry('owner-only.pdf');
    const seen: number[] = [];
    entry.progress.subscribe((value) => seen.push(value));
    await h.jobs.unlockAll();
    expect(seen).toEqual([0, 0.6, 1]);
  });

  it('counts finished files in the status of a running batch', async () => {
    const h = createHarness({ engine: { concurrency: 1 } });
    await h.add('owner-only.pdf', 'slow.pdf', 'owner-only-unrestricted.pdf');
    const statuses: unknown[] = [];
    const stop = h.jobs.summary.subscribe((summary) => {
      if (summary.phase === 'processing') statuses.push(summary.status!.params);
    });
    await h.jobs.unlockAll();
    stop();
    expect(statuses[0]).toEqual({ done: 0, total: 3 });
    expect(statuses).toContainEqual({ done: 1, total: 3 });
    expect(statuses.at(-1)).toEqual({ done: 2, total: 3 });
  });
});

describe('unlock: cancelling and removing', () => {
  it('cancels one file in the middle of a run; it goes back to where it was', async () => {
    const h = createHarness({ engine: { hold: 0.5 } });
    await h.add('needs-password.pdf', 'aes128.pdf');
    h.jobs.setUnlockPassword(DEMO_PASSWORD);
    const run = h.jobs.unlockAll();
    await tick();
    expect(h.engine.held).toBe(2);

    const entry = h.entry('needs-password.pdf');
    h.jobs.cancel(entry.id);
    // At once, not when the engine gets round to it.
    expect(entry.view.value.state).toBe('needs-password');
    expect(entry.progress.value).toBe(0);
    await tick();
    expect(h.engine.held).toBe(1);
    expect(h.view('aes128.pdf').state).toBe('processing');

    h.engine.release();
    expect(await run).toEqual({ started: true, done: 1, rejected: 0, failed: 0, cancelled: 1 });
    expect(h.states()).toEqual(['needs-password', 'done']);
  });

  it('keeps the password when everything was cancelled', async () => {
    const h = createHarness({ engine: { hold: 0.5 } });
    await h.add('needs-password.pdf');
    h.jobs.setUnlockPassword(DEMO_PASSWORD);
    const run = h.jobs.unlockAll();
    await tick();
    h.jobs.cancelAll();
    expect(await run).toMatchObject({ done: 0, cancelled: 1 });
    expect(h.jobs.unlockPassword.value).toBe(DEMO_PASSWORD);
    expect(h.jobs.summary.value).toMatchObject({ phase: 'ready', passwordError: null });
    expect(h.engine.held).toBe(0);
  });

  it('cancels everything that is running in the current mode', async () => {
    const h = createHarness({ engine: { hold: 0.5, concurrency: 1 } });
    await h.add('owner-only.pdf', 'slow.pdf');
    const run = h.jobs.unlockAll();
    await tick();
    h.jobs.cancelAll();
    expect(h.states()).toEqual(['restricted', 'restricted']);
    expect(h.jobs.summary.value).toMatchObject({ phase: 'ready', processing: 0 });
    expect(await run).toMatchObject({ cancelled: 2 });
  });

  it('can run a cancelled file again straight away', async () => {
    const h = createHarness({ engine: { hold: 0.5 } });
    await h.add('owner-only.pdf');
    const first = h.jobs.unlockAll();
    await tick();
    h.jobs.cancel(h.entry('owner-only.pdf').id);
    h.engine.release();
    const second = h.jobs.unlockAll();
    expect(await first).toMatchObject({ cancelled: 1 });
    expect(await second).toMatchObject({ done: 1 });
    expect(h.states()).toEqual(['done']);
  });

  it('removes a file while it is running', async () => {
    const h = createHarness({ engine: { hold: 0.5 } });
    await h.add('owner-only.pdf', 'slow.pdf');
    const run = h.jobs.unlockAll();
    await tick();
    const removed = h.entry('owner-only.pdf');
    h.jobs.remove(removed.id);
    expect(h.jobs.entries.value.map((entry) => entry.name)).toEqual(['slow.pdf']);
    expect(h.jobs.find(removed.id)).toBeUndefined();
    await tick();
    expect(h.engine.held).toBe(1);
    expect(h.jobs.summary.value.status).toEqual({ key: 'status.processing' });

    h.engine.release();
    expect(await run).toMatchObject({ done: 1, cancelled: 1 });
    expect(h.states()).toEqual(['done']);
  });

  it('removes a file while it is being analysed', async () => {
    const h = createHarness({ engine: { hold: 'inspect' } });
    const { added } = await h.jobs.addFiles([createDemoFile('plain.pdf')], 'picker');
    h.jobs.remove(added[0]!.id);
    h.engine.release();
    await h.jobs.settled();
    expect(h.jobs.entries.value).toEqual([]);
    expect(h.jobs.summary.value.phase).toBe('empty');
  });

  it('ignores cancel, remove, retry and redo for unknown or idle files', async () => {
    const h = createHarness();
    await h.add('plain.pdf');
    const id = h.entry('plain.pdf').id;
    expect(() => {
      h.jobs.cancel(id);
      h.jobs.cancel('nope');
      h.jobs.remove('nope');
      h.jobs.retry(id);
      h.jobs.retry('nope');
      h.jobs.redo(id);
      h.jobs.redo('nope');
      h.jobs.cancelAll();
    }).not.toThrow();
    expect(h.states()).toEqual(['not-encrypted']);
  });

  it('clears the list, cancels what runs, and forgets every password', async () => {
    const h = createHarness({ engine: { hold: 0.5 } });
    await h.add('needs-password.pdf', 'aes128.pdf', 'plain.pdf');
    h.jobs.setUnlockPassword(DEMO_PASSWORD);
    h.jobs.setUnlockRevealed(true);
    h.jobs.setCurrentPassword(h.entry('aes128.pdf').id, 'old');
    h.fillLockForm();
    const kept = h.entry('aes128.pdf');
    const run = h.jobs.unlockAll();
    await tick();

    h.jobs.clear();
    expect(h.jobs.entries.value).toEqual([]);
    expect(h.jobs.unlockPassword.value).toBe('');
    expect(h.jobs.unlockRevealed.value).toBe(false);
    expect(kept.currentPassword.value).toBe('');
    expect(h.lockForm.password.value).toBe('');
    expect(h.lockForm.confirmation.value).toBe('');
    expect(h.jobs.summary.value).toMatchObject({ phase: 'empty', canClear: false });
    expect(await run).toMatchObject({ cancelled: 2 });
    expect(h.engine.held).toBe(0);
  });
});

describe('unlock: the password is not kept', () => {
  it('is dropped after a successful run', async () => {
    const h = createHarness();
    await h.add('needs-password.pdf');
    h.jobs.setUnlockPassword(DEMO_PASSWORD);
    await h.jobs.unlockAll();
    expect(h.jobs.unlockPassword.value).toBe('');
  });

  it('is not wiped when the user typed something new during the run', async () => {
    const h = createHarness({ engine: { hold: 0.5, scenarios: OTHER } });
    await h.add('needs-password.pdf', 'other-password.pdf');
    h.jobs.setUnlockPassword(DEMO_PASSWORD);
    const run = h.jobs.unlockAll();
    await tick();
    h.jobs.setUnlockPassword('99');
    h.engine.release();
    await run;
    expect(h.states()).toEqual(['done', 'wrong-password']);
    expect(h.jobs.unlockPassword.value).toBe('99');
    expect(h.jobs.summary.value.passwordError).toBeNull();
  });

  it('is dropped when the last file that needed it is removed or unlocked on its card', async () => {
    const h = createHarness({ engine: { scenarios: OTHER } });
    await h.add('needs-password.pdf', 'other-password.pdf');
    h.jobs.setUnlockPassword('nope');
    await h.jobs.unlockAll();
    expect(h.jobs.unlockPassword.value).toBe('nope');

    h.jobs.remove(h.entry('needs-password.pdf').id);
    expect(h.jobs.unlockPassword.value).toBe('nope');
    await h.jobs.retryUnlock(h.entry('other-password.pdf').id, '9999');
    expect(h.jobs.unlockPassword.value).toBe('');
    expect(h.jobs.summary.value.passwordField).toBe(false);
  });

  it('never appears in what the controller exposes', async () => {
    const h = createHarness();
    await h.add('needs-password.pdf');
    const secret = 'S3CRET-and-wrong';
    h.jobs.setUnlockPassword(secret);
    await h.jobs.unlockAll();
    const exposed = JSON.stringify({
      views: h.jobs.entries.value.map((entry) => [entry.view.value, entry.details.value]),
      summary: h.jobs.summary.value,
      toasts: h.toasts.toasts.value,
    });
    expect(exposed).not.toContain(secret);
  });
});

describe('unlock: output names', () => {
  it('derives the name from the input and the naming settings', async () => {
    const h = createHarness({
      settings: { naming: { decryptSuffix: '（已解锁）', encryptSuffix: '_locked' } },
    });
    await h.add('2024年度财务报表_最终版(3).pdf');
    await h.jobs.unlockAll(DEMO_PASSWORD);
    expect(h.view('2024年度财务报表_最终版(3).pdf').result!.name).toBe(
      '2024年度财务报表_最终版(3)（已解锁）.pdf',
    );
  });

  it('keeps the outputs of one batch apart', async () => {
    const restricted = FAKE_SCENARIOS['owner-only.pdf']!;
    const h = createHarness({
      engine: { scenarios: { 'report.pdf': restricted, 'REPORT.pdf': restricted } },
    });
    // The same name from two folders, and a third that differs only in case.
    await h.jobs.addFiles(
      [
        createDemoFile('report.pdf', { size: 1000 }),
        createDemoFile('report.pdf', { size: 2000 }),
        createDemoFile('REPORT.pdf', { size: 3000 }),
      ],
      'picker',
    );
    await h.jobs.settled();
    await h.jobs.unlockAll();
    expect(h.jobs.entries.value.map((entry) => entry.view.value.result!.name)).toEqual([
      'report_unlocked.pdf',
      'report_unlocked (2).pdf',
      'REPORT_unlocked (3).pdf',
    ]);
  });

  it('keeps new outputs apart from the ones already in the list', async () => {
    const h = createHarness();
    const again = createDemoFile('owner-only.pdf', { lastModified: 7 });
    await h.add('owner-only.pdf');
    await h.jobs.unlockAll();
    await h.jobs.addFiles([again], 'picker');
    await h.jobs.settled();
    await h.jobs.unlockAll();
    expect(h.jobs.entries.value.map((entry) => entry.view.value.result!.name)).toEqual([
      'owner-only_unlocked.pdf',
      'owner-only_unlocked (2).pdf',
    ]);
  });

  it('frees the name of a result that was discarded or removed', async () => {
    const h = createHarness();
    await h.add('owner-only.pdf');
    await h.jobs.unlockAll();
    const entry = h.entry('owner-only.pdf');
    h.jobs.redo(entry.id);
    expect(entry.view.value).toMatchObject({ state: 'restricted', result: null });
    await h.jobs.unlockAll();
    expect(entry.view.value.result!.name).toBe('owner-only_unlocked.pdf');
  });

  it('keeps outputs of the two modes apart when the suffixes are the same', async () => {
    const h = createHarness({
      settings: { naming: { decryptSuffix: '_out', encryptSuffix: '_out' } },
    });
    await h.add('owner-only.pdf');
    await h.jobs.unlockAll();
    h.mode.value = 'lock';
    h.fillLockForm();
    await h.jobs.lockAll();
    expect(h.view('owner-only.pdf').result!.name).toBe('owner-only_out (2).pdf');
    h.mode.value = 'unlock';
    expect(h.view('owner-only.pdf').result!.name).toBe('owner-only_out.pdf');
  });
});

describe('unlock: overlapping runs', () => {
  it('lets a card retry join a batch that is still running', async () => {
    const h = createHarness({ engine: { scenarios: OTHER, concurrency: 4 } });
    await h.add('needs-password.pdf', 'other-password.pdf', 'aes128.pdf');
    h.jobs.setUnlockPassword('9999');
    await h.jobs.unlockAll();
    expect(h.states()).toEqual(['wrong-password', 'done', 'wrong-password']);

    h.engine.setHold(0.5);
    const first = h.jobs.retryUnlock(h.entry('needs-password.pdf').id, DEMO_PASSWORD);
    await tick();
    const second = h.jobs.retryUnlock(h.entry('aes128.pdf').id, DEMO_PASSWORD);
    await tick();
    expect(h.jobs.summary.value).toMatchObject({
      phase: 'processing',
      processing: 2,
      status: { key: 'status.processingCount', params: { done: 0, total: 2 } },
    });
    expect(h.jobs.overallProgress.value).toBe(0.5);
    h.engine.release();
    await Promise.all([first, second]);
    expect(h.states()).toEqual(['done', 'done', 'done']);
  });
});

/**
 * A jobs controller wired to the fake engine and to recording stand-ins for saving and toasts.
 * Shared by the unit tests of src/state.
 */
import { signal, type Signal } from '@preact/signals';
import type { PdfEngine } from '../../src/engine/types';
import type { OutputFile, SaveCapabilities, SaveOutcome, ShareOutcome } from '../../src/lib/save';
import type { EntryState, EntryView } from '../../src/state/entries';
import {
  createJobsController,
  type Entry,
  type JobsController,
  type SaveApi,
} from '../../src/state/jobs';
import { createLockForm, type LockForm } from '../../src/state/lock-form';
import type { Mode } from '../../src/state/mode';
import { DEFAULT_SETTINGS, type Settings } from '../../src/state/settings';
import { createToastQueue, type ToastQueue } from '../../src/state/toasts';
import {
  createDemoFile,
  createFakeEngine,
  type FakeEngine,
  type FakeEngineOptions,
} from './fake-engine';

export interface SaveCall {
  via:
    'saveFile' | 'downloadFile' | 'saveToDirectory' | 'saveAsZip' | 'shareFiles' | 'openInNewTab';
  names: string[];
  /** The files as they were handed over, for looking into the blobs. */
  files: readonly OutputFile[];
  zipName?: string;
}

export interface FakeSave extends SaveApi {
  readonly calls: SaveCall[];
  /** What the next save resolves with; an Error makes it reject. */
  saveOutcome: SaveOutcome | Error;
  shareOutcome: ShareOutcome | Error;
  /** Makes downloadFile / openInNewTab / createZip throw. */
  broken: boolean;
  capabilities: SaveCapabilities;
  /** Names inside the archives that were created. */
  readonly zips: string[][];
}

export function createFakeSave(capabilities: Partial<SaveCapabilities> = {}): FakeSave {
  const names = (files: readonly OutputFile[]): string[] => files.map((file) => file.name);
  const settle = <T>(outcome: T | Error): Promise<T> =>
    outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
  const fake: FakeSave = {
    calls: [],
    zips: [],
    saveOutcome: 'saved',
    shareOutcome: 'shared',
    broken: false,
    capabilities: {
      canShareFiles: true,
      canPickSaveLocation: true,
      canPickDirectory: true,
      ...capabilities,
    },
    getSaveCapabilities: () => fake.capabilities,
    saveFile(file) {
      fake.calls.push({ via: 'saveFile', names: [file.name], files: [file] });
      return settle(fake.saveOutcome);
    },
    downloadFile(file) {
      if (fake.broken) throw new Error('download blocked');
      fake.calls.push({ via: 'downloadFile', names: [file.name], files: [file] });
      return 'downloaded';
    },
    saveToDirectory(files) {
      fake.calls.push({ via: 'saveToDirectory', names: names(files), files });
      return settle(fake.saveOutcome);
    },
    saveAsZip(files, zipName) {
      fake.calls.push({ via: 'saveAsZip', names: names(files), files, zipName });
      return settle(fake.saveOutcome);
    },
    shareFiles(files) {
      fake.calls.push({ via: 'shareFiles', names: names(files), files });
      return settle(fake.shareOutcome);
    },
    openInNewTab(file) {
      if (fake.broken) throw new Error('popup blocked');
      fake.calls.push({ via: 'openInNewTab', names: [file.name], files: [file] });
    },
    async createZip(files) {
      if (fake.broken) throw new Error('out of memory');
      fake.zips.push(names(files));
      return new Blob(['zip'], { type: 'application/zip' });
    },
  };
  return fake;
}

export interface HarnessOptions {
  /** Options of the fake engine the harness creates. */
  engine?: FakeEngineOptions;
  /** Use this engine instead (the real one, in the integration test). */
  realEngine?: PdfEngine;
  mode?: Mode;
  settings?: Partial<Settings>;
  capabilities?: Partial<SaveCapabilities>;
}

export interface Harness {
  jobs: JobsController;
  /** The fake engine. Unused when `realEngine` was given. */
  engine: FakeEngine;
  mode: Signal<Mode>;
  settings: Signal<Settings>;
  toasts: ToastQueue;
  lockForm: LockForm;
  save: FakeSave;
  /** Adds demo files by name and waits until they are inspected. */
  add(...names: string[]): Promise<Entry[]>;
  entry(name: string): Entry;
  view(name: string): EntryView;
  /** State of every card, in list order. */
  states(): EntryState[];
  /** Keys of the toasts on screen. */
  toastKeys(): string[];
  /** Fills the lock form with a valid single password. */
  fillLockForm(password?: string): void;
  /** What was saved, shared or opened, without the file objects. */
  saved(): Array<Omit<SaveCall, 'files'>>;
}

/** Toasts stay until the test looks at them. */
const frozenClock = {
  setTimeout: () => 0,
  clearTimeout: () => undefined,
  now: () => 0,
};

export function createHarness(options: HarnessOptions = {}): Harness {
  const engine = createFakeEngine(options.engine);
  const mode = signal<Mode>(options.mode ?? 'unlock');
  const settings = signal<Settings>({ ...DEFAULT_SETTINGS, ...options.settings });
  const toasts = createToastQueue(frozenClock);
  const lockForm = createLockForm({ toasts });
  const save = createFakeSave(options.capabilities);
  const jobs = createJobsController({
    engine: options.realEngine ?? engine,
    mode,
    settings,
    toasts,
    lockForm,
    save,
    archiveName: (which) => `archive-${which}`,
  });

  function entry(name: string): Entry {
    const found = jobs.entries.value.find((candidate) => candidate.name === name);
    if (!found) throw new Error(`no entry named ${name}`);
    return found;
  }

  return {
    jobs,
    engine,
    mode,
    settings,
    toasts,
    lockForm,
    save,
    async add(...names) {
      const report = await jobs.addFiles(
        names.map((name) => createDemoFile(name)),
        'picker',
      );
      await jobs.settled();
      return report.added;
    },
    entry,
    view: (name) => entry(name).view.value,
    states: () => jobs.entries.value.map((candidate) => candidate.view.value.state),
    toastKeys: () => toasts.toasts.value.map((toast) => toast.message.key),
    fillLockForm(password = 'new-Passw0rd!') {
      lockForm.setPassword(password);
      lockForm.setConfirmation(password);
    },
    saved: () => save.calls.map(({ files: _files, ...call }) => call),
  };
}

/** Lets promise callbacks and zero-delay timers run. */
export function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

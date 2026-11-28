/**
 * The file list and everything that happens to the files in it: taking files in, inspecting
 * them, unlocking and locking, progress and cancellation, and getting the results out.
 *
 * Components read signals (`entries`, each entry's `view` / `progress` / `details`, `summary`)
 * and call plain functions. All rules live here and in entries.ts; a component never has to
 * work out what a file's state means.
 *
 * Passwords exist only in memory: the unlock field and the per-card "current password" are
 * signals of this controller, handed to the engine and dropped once they have done their job.
 * They are never logged, stored, or put into a URL.
 *
 * A list has one set of lock settings. Submitted settings are kept for as long as a Lock result
 * made with them is in the list, and so is, unseen, the password that opened an already
 * protected input: when other settings are submitted, every result is made again from its input.
 * Until that has happened, a result made with other settings than the form holds is not handed
 * out: whatever can be saved opens with the password on screen. The result it replaces is kept
 * aside meanwhile and comes back if the new run is cancelled or fails.
 */
import {
  batch,
  computed,
  signal,
  untracked,
  type ReadonlySignal,
  type Signal,
} from '@preact/signals';
import { checkNewPasswords, type NewPasswordProblem } from '../engine/passwords';
import {
  PdfEngineError,
  type EncryptOptions,
  type Operation,
  type PdfEngine,
  type ProcessResult,
} from '../engine/types';
import { translate, type ErrorCode, type Message, type MessageList } from '../i18n';
import { outputFileName, uniqueNames, type NameOperation } from '../lib/filename';
import * as saveLib from '../lib/save';
import type { OutputFile, SaveCapabilities, SaveOutcome } from '../lib/save';
import { createZip } from '../lib/zip';
import type { IncomingSource } from '../pwa/incoming';
import { engine as appEngine } from './engine';
import {
  IDLE_RUN,
  deriveDetails,
  deriveEntryView,
  entryState,
  needsOpenPassword,
  summarize,
  type DetailsView,
  type EntryError,
  type EntryResult,
  type EntryView,
  type Inspection,
  type Run,
  type Summary,
  type ViewContext,
} from './entries';
import {
  lockForm as appLockForm,
  lockSettingsSummary,
  type LockField,
  type LockForm,
} from './lock-form';
import { mode as appMode, type Mode } from './mode';
import { locale, settings as appSettings, type Settings } from './settings';
import { toasts as appToasts, type ToastQueue } from './toasts';

/** Where files came from. Informational; every source is treated alike. */
export type FileSource = IncomingSource | 'picker' | 'drop' | 'paste' | 'demo';

/** One file in the list. Stable for as long as the file stays in the list. */
export interface Entry {
  readonly id: string;
  readonly file: File;
  readonly name: string;
  /** Size of the input in bytes. */
  readonly size: number;
  readonly source: FileSource;
  /** Everything a card shows, for the current mode. */
  readonly view: ReadonlySignal<EntryView>;
  /**
   * Progress of the current mode's run in [0, 1], never decreasing during a run. Separate from
   * `view` because it changes many times a second.
   */
  readonly progress: ReadonlySignal<number>;
  /** Lock mode: content of the card's "current password" field. */
  readonly currentPassword: ReadonlySignal<string>;
  /** Unlock mode: content of the card's own password field (see `PasswordFieldView`). */
  readonly retryPassword: ReadonlySignal<string>;
  /** Data for the details sheet. */
  readonly details: ReadonlySignal<DetailsView>;
}

export interface AddFilesReport {
  added: Entry[];
  /** Names of files that are not PDFs. */
  rejected: string[];
  /** Names of files that were already in the list. */
  duplicates: string[];
}

export type RunRefusal =
  /** The lock form has problems; they are now shown. `field` is the first invalid field. */
  | 'invalid-form'
  /** Unlock: files need a password and none was given. */
  | 'password-required'
  /** Lock: every remaining file waits for its current password on its card. */
  | 'current-password-required'
  | 'nothing-to-do'
  /** `lockAll(options)` was given passwords the engine would refuse. */
  | NewPasswordProblem;

export interface RunReport {
  /** False if nothing was started; `refusal` says why. */
  started: boolean;
  refusal?: RunRefusal;
  field?: LockField;
  /** Files processed successfully. */
  done: number;
  /** Files the password did not open. */
  rejected: number;
  failed: number;
  cancelled: number;
}

/** What the Lock results in the list were made with. */
export interface LockApplied {
  /** "AES-256 · Restricted". */
  summary: MessageList;
  /** "Password", or "Open password" where a separate permissions password was set. */
  passwordLabel: Message;
  /** Opens every Lock result in the list; '' if they open without a password. */
  password: string;
}

/** How "save all" delivers several files. */
export type SaveAllTarget = 'zip' | 'folder';

/** The functions of src/lib/save.ts and zip.ts the controller uses; replaced by fakes in tests. */
export interface SaveApi {
  getSaveCapabilities(): SaveCapabilities;
  saveFile(file: OutputFile): Promise<SaveOutcome>;
  downloadFile(file: OutputFile): SaveOutcome;
  saveToDirectory(files: readonly OutputFile[]): Promise<SaveOutcome>;
  saveAsZip(files: readonly OutputFile[], zipName: string): Promise<SaveOutcome>;
  shareFiles(files: readonly OutputFile[], title?: string): Promise<saveLib.ShareOutcome>;
  openInNewTab(file: OutputFile): void;
  createZip(files: readonly OutputFile[]): Promise<Blob>;
}

export interface JobsDependencies {
  engine: PdfEngine;
  mode: ReadonlySignal<Mode>;
  settings: ReadonlySignal<Settings>;
  toasts: ToastQueue;
  lockForm: LockForm;
  save: SaveApi;
  /** Name, without extension, of the archive that bundles a mode's results. */
  archiveName(mode: Mode): string;
}

export interface JobsController {
  /** The files, in the order they were added. */
  readonly entries: ReadonlySignal<readonly Entry[]>;
  /** Counts, the primary action and the phase of the action area, for the current mode. */
  readonly summary: ReadonlySignal<Summary>;
  /** Progress of the running batch of the current mode in [0, 1]. */
  readonly overallProgress: ReadonlySignal<number>;
  /** Unlock mode: content of the shared password field. */
  readonly unlockPassword: ReadonlySignal<string>;
  /** Unlock mode: the shared password is shown in clear text. */
  readonly unlockRevealed: ReadonlySignal<boolean>;
  /**
   * The settings the Lock results in the list were made with, as they were submitted: not what
   * the form holds now. null while the list has no Lock result, and while its results were made
   * with different settings (the form is shown then, and the next run makes them alike).
   */
  readonly lockApplied: ReadonlySignal<LockApplied | null>;
  /**
   * Something exists only in this page and would be lost with it: a file is being processed, or
   * a result has not been saved yet, in either mode.
   */
  readonly unsavedWork: ReadonlySignal<boolean>;
  /** What the platform offers for saving and sharing. */
  readonly capabilities: SaveCapabilities;

  find(id: string): Entry | undefined;

  /**
   * Adds files. Only PDFs are accepted (decided by content, not by name or type), and files
   * already in the list are skipped; both are reported with one toast per call. Accepted files
   * are inspected immediately.
   */
  addFiles(files: Iterable<File> | ArrayLike<File>, source: FileSource): Promise<AddFilesReport>;

  setUnlockPassword(value: string): void;
  setUnlockRevealed(revealed: boolean): void;
  /**
   * Unlocks every file that can be unlocked: files that need a password are tried with
   * `password` (default: the shared field), files that only carry restrictions need none.
   * Files the password does not open become `wrong-password`. Without a shared password, each
   * card that has a field of its own is tried with what was typed there.
   */
  unlockAll(password?: string): Promise<RunReport>;
  /** Unlock mode: sets the content of a card's own password field. */
  setRetryPassword(id: string, value: string): void;
  /**
   * Tries one file again with its own password (default: the card's field). A shared password
   * that opened nothing is dropped then: the cards have taken over.
   */
  retryUnlock(id: string, password?: string): Promise<RunReport>;

  /** Lock mode: sets the content of a card's "current password" field. */
  setCurrentPassword(id: string, value: string): void;
  /**
   * Encrypts every file that is ready, with the lock form's settings (or `options`). Problems
   * with the new passwords are reported before anything runs. Results that were made with other
   * settings are made again in the same run; each stays in the list until its replacement is
   * finished.
   */
  lockAll(options?: EncryptOptions): Promise<RunReport>;
  /** Copies `lockApplied.password`. Call it directly from a click handler. */
  copyLockPassword(): Promise<boolean>;

  /** The primary action of the current mode: `unlockAll()` or `lockAll()`. */
  runPrimary(): Promise<RunReport>;

  /**
   * Stops one file's processing in the current mode; it returns to where it was. In Lock mode
   * that may be a finished result: the one the stopped run was going to replace.
   */
  cancel(id: string): void;
  /** Stops everything that is being processed in the current mode. */
  cancelAll(): void;
  /**
   * Takes a file out of the list, cancelling whatever is running for it. Removing the last one
   * forgets every password, as `clear()` does.
   */
  remove(id: string): void;
  /** Empties the list and forgets every password, including the lock form's. */
  clear(): void;
  /**
   * Error state: inspects the file again, or makes it ready for another run. A Lock result that
   * the failed run was going to replace comes back.
   */
  retry(id: string): void;
  /** Done: discards the result of the current mode so the file can be processed again. */
  redo(id: string): void;
  /** Inspects again every file whose inspection failed with `code` (default: any). */
  retryInspections(code?: ErrorCode): void;

  // Results of the current mode. All of these must be called directly from a click handler:
  // they open pickers and the share sheet, which need the user gesture.
  save(id: string): Promise<void>;
  share(id: string): Promise<void>;
  open(id: string): void;
  /** One result is saved as it is; several as a ZIP, or into a folder the user picks. */
  saveAll(target?: SaveAllTarget): Promise<void>;
  shareAll(): Promise<void>;

  /** Resolves when no inspection and no processing is pending. For tests. */
  settled(): Promise<void>;
}

// --- Internals ---------------------------------------------------------------------------------

interface EntryRecord extends Entry {
  readonly inspection: Signal<Inspection>;
  readonly runs: Readonly<Record<Mode, Signal<Run>>>;
  readonly progressOf: Readonly<Record<Mode, Signal<number>>>;
  readonly password: Signal<string>;
  readonly retry: Signal<string>;
  /**
   * Lock: the password that opened the input for the run that is in flight, finished or kept
   * aside, '' otherwise. Never shown; it is what lets a result be made again with other settings.
   */
  opened: string;
  /**
   * Lock: the finished run that the run in flight (or the one that failed) was started to
   * replace. It takes its place again when that run is cancelled or retried.
   */
  readonly replaced: Signal<Run | null>;
  /** The controllers of what is in flight. A job whose controller was replaced is stale. */
  readonly aborts: Record<'inspect' | Mode, AbortController | null>;
}

interface Job {
  entry: EntryRecord;
  /** Password that opens the input; '' if it needs none. */
  password: string;
  operation: Operation;
  /** Lock: the number of the settings in `operation`. */
  settings: number | null;
}

type Outcome = 'done' | 'rejected' | 'failed' | 'cancelled';

const MODES: readonly Mode[] = ['unlock', 'lock'];
const MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
/** Readers accept the header anywhere in the first 1024 bytes; so does the engine. */
const MAGIC_WINDOW = 1024;

function hasPdfHeader(bytes: Uint8Array): boolean {
  outer: for (let i = 0; i + MAGIC.length <= bytes.length; i++) {
    for (let j = 0; j < MAGIC.length; j++) {
      if (bytes[i + j] !== MAGIC[j]) continue outer;
    }
    return true;
  }
  return false;
}

/** `unreadable`: the browser could not read the file; the engine will say so on the card. */
async function sniff(file: File): Promise<'pdf' | 'other' | 'unreadable'> {
  try {
    const head = new Uint8Array(await file.slice(0, MAGIC_WINDOW).arrayBuffer());
    return hasPdfHeader(head) ? 'pdf' : 'other';
  } catch {
    return 'unreadable';
  }
}

function identity(file: File): string {
  return `${file.name}\u0000${file.size}\u0000${file.lastModified}`;
}

function toEntryError(error: unknown): EntryError {
  if (error instanceof PdfEngineError) return { code: error.code, detail: error.detail ?? null };
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return { code: 'unknown', detail };
}

function emptyReport(): RunReport {
  return { started: false, done: 0, rejected: 0, failed: 0, cancelled: 0 };
}

function refused(refusal: RunRefusal, field?: LockField): RunReport {
  return field ? { ...emptyReport(), refusal, field } : { ...emptyReport(), refusal };
}

function toReport(outcomes: readonly Outcome[]): RunReport {
  const report = { ...emptyReport(), started: true };
  for (const outcome of outcomes) report[outcome]++;
  return report;
}

function isProcessing(run: Run): boolean {
  return run.status === 'queued' || run.status === 'running';
}

/** The number of the submitted settings equal to `options`, if there is one. */
function revisionOf(
  revisions: ReadonlyMap<number, EncryptOptions>,
  options: EncryptOptions,
): number | undefined {
  for (const [revision, submitted] of revisions) {
    if (sameEncryptOptions(submitted, options)) return revision;
  }
  return undefined;
}

function sameEncryptOptions(a: EncryptOptions, b: EncryptOptions): boolean {
  const p = a.permissions;
  const q = b.permissions;
  return (
    a.algorithm === b.algorithm &&
    a.userPassword === b.userPassword &&
    a.ownerPassword === b.ownerPassword &&
    a.encryptMetadata === b.encryptMetadata &&
    p.print === q.print &&
    p.modify === q.modify &&
    p.extract === q.extract &&
    p.annotate === q.annotate &&
    p.fillForms === q.fillForms &&
    p.assemble === q.assemble &&
    p.accessibility === q.accessibility
  );
}

export function createJobsController(deps: JobsDependencies): JobsController {
  const { engine, toasts } = deps;
  const records = signal<readonly EntryRecord[]>([]);
  const unlockPassword = signal('');
  const unlockRevealed = signal(false);
  /** The shared password was tried and opened nothing. */
  const unlockRejected = signal(false);
  /** Ids of the entries of the batch that is running (or just ran) in each mode. */
  const batches: Record<Mode, Signal<readonly string[]>> = { unlock: signal([]), lock: signal([]) };
  /**
   * Submitted lock settings by the number that results refer to them by. A set is kept for as
   * long as a result, a run in flight or a run kept aside was made with it.
   */
  const lockRevisions = signal<ReadonlyMap<number, EncryptOptions>>(new Map());
  /** The number of the settings submitted last: every Lock run in flight is made with them. */
  const lockSubmitted = signal(0);
  let lastRevision = 0;
  const pending = new Set<Promise<unknown>>();
  let nextId = 1;

  let capabilities: SaveCapabilities | undefined;
  function getCapabilities(): SaveCapabilities {
    if (!capabilities) {
      try {
        capabilities = deps.save.getSaveCapabilities();
      } catch {
        capabilities = {
          canShareFiles: false,
          canPickSaveLocation: false,
          canPickDirectory: false,
        };
      }
    }
    return capabilities;
  }

  function track<T>(promise: Promise<T>): Promise<T> {
    const guarded = promise.then(
      () => undefined,
      () => undefined,
    );
    pending.add(guarded);
    void guarded.then(() => pending.delete(guarded));
    return promise;
  }

  // --- Derived state ---------------------------------------------------------------------------

  const lockedCount = computed(() => {
    let count = 0;
    for (const entry of records.value) {
      const state = entryState(entry.inspection.value, entry.runs.unlock.value, 'unlock');
      if (state === 'needs-password' || state === 'wrong-password') count++;
    }
    return count;
  });

  /** The number of the submitted settings the lock form holds now; -1 if it holds others. */
  const formRevision = computed(
    () => revisionOf(lockRevisions.value, deps.lockForm.options.value) ?? -1,
  );

  /** The settings every Lock run in the list has in common, finished or in flight. */
  const lockApplied = computed<LockApplied | null>(() => {
    let shared: number | null = null;
    for (const entry of records.value) {
      const run = entry.runs.lock.value;
      const revision = isProcessing(run) ? lockSubmitted.value : (run.result?.settings ?? null);
      if (revision === null) continue;
      if (shared !== null && shared !== revision) return null;
      shared = revision;
    }
    const options = shared === null ? undefined : lockRevisions.value.get(shared);
    if (!options) return null;
    return {
      summary: lockSettingsSummary(options),
      passwordLabel: {
        key: options.ownerPassword === '' ? 'lock.password.label' : 'lock.password.openLabel',
      },
      password: options.userPassword,
    };
  });

  /** Unlock: what is typed into the card's own field, while the card shows one. */
  function ownPassword(entry: EntryRecord): string {
    const run = entry.runs.unlock.value;
    const rejected = run.status === 'idle' && run.passwordRejected;
    return rejected && (run.ownField || lockedCount.value > 1) ? entry.retry.value : '';
  }

  function viewContext(): ViewContext {
    return {
      mode: deps.mode.value,
      lockedCount: lockedCount.value,
      lockTarget: lockTarget.value,
      canShare: getCapabilities().canShareFiles,
    };
  }

  const summary = computed<Summary>(() => {
    const mode = deps.mode.value;
    const ids = batches[mode].value;
    const list = records.value;
    let finished = 0;
    for (const id of ids) {
      const entry = list.find((candidate) => candidate.id === id);
      if (!entry || !isProcessing(entry.runs[mode].value)) finished++;
    }
    const revision = mode === 'lock' ? formRevision.value : -1;
    return summarize(
      list.map((entry) => {
        const run = entry.runs[mode].value;
        return {
          inspection: entry.inspection.value,
          run,
          hasCurrentPassword: entry.password.value !== '',
          hasOwnPassword: mode === 'unlock' && ownPassword(entry) !== '',
          outdated: mode === 'lock' && run.result !== null && run.result.settings !== revision,
        };
      }),
      {
        mode,
        hasUnlockPassword: unlockPassword.value !== '',
        unlockRejected: unlockRejected.value,
        capabilities: getCapabilities(),
        batch: { finished, total: ids.length },
      },
    );
  });

  /**
   * Lock: what a result must have been made with to be handed out, while results are about to
   * be made again; null while every result is on offer.
   */
  const lockTarget = computed(() =>
    deps.mode.value === 'lock' && summary.value.relock > 0 ? formRevision.value : null,
  );

  const unsavedWork = computed(() =>
    records.value.some((entry) => {
      const kept = entry.replaced.value?.result;
      if (kept && !kept.saved) return true;
      return MODES.some((mode) => {
        const run = entry.runs[mode].value;
        return isProcessing(run) || (run.result !== null && !run.result.saved);
      });
    }),
  );

  const overallProgress = computed(() => {
    const mode = deps.mode.value;
    const ids = batches[mode].value;
    if (ids.length === 0) return 0;
    const list = records.value;
    let sum = 0;
    for (const id of ids) {
      const entry = list.find((candidate) => candidate.id === id);
      // Whatever is no longer being processed has had its share of the work.
      sum += entry && isProcessing(entry.runs[mode].value) ? entry.progressOf[mode].value : 1;
    }
    return sum / ids.length;
  });

  // --- Entries ---------------------------------------------------------------------------------

  function createEntry(file: File, source: FileSource): EntryRecord {
    const base = { id: `f${nextId++}`, name: file.name, size: file.size };
    const inspection = signal<Inspection>({ status: 'pending' });
    const runs = { unlock: signal<Run>(IDLE_RUN), lock: signal<Run>(IDLE_RUN) };
    const progressOf = { unlock: signal(0), lock: signal(0) };
    const password = signal('');
    const retry = signal('');
    return {
      ...base,
      file,
      source,
      inspection,
      runs,
      progressOf,
      password,
      retry,
      opened: '',
      replaced: signal<Run | null>(null),
      aborts: { inspect: null, unlock: null, lock: null },
      currentPassword: password,
      retryPassword: retry,
      view: computed(() =>
        deriveEntryView(base, inspection.value, runs[deps.mode.value].value, viewContext()),
      ),
      progress: computed(() => progressOf[deps.mode.value].value),
      details: computed(() =>
        deriveDetails(base, inspection.value, runs[deps.mode.value].value, viewContext()),
      ),
    };
  }

  function record(id: string): EntryRecord | undefined {
    return records.peek().find((entry) => entry.id === id);
  }

  function patchRun(entry: EntryRecord, mode: Mode, patch: Partial<Run>): void {
    entry.runs[mode].value = { ...entry.runs[mode].peek(), ...patch };
  }

  function inspect(entry: EntryRecord): void {
    const controller = new AbortController();
    entry.aborts.inspect?.abort();
    entry.aborts.inspect = controller;
    entry.inspection.value = { status: 'pending' };
    const isCurrent = (): boolean => entry.aborts.inspect === controller;
    void track(
      engine.inspect(entry.file, '', { signal: controller.signal }).then(
        (info) => {
          if (!isCurrent()) return;
          entry.aborts.inspect = null;
          entry.inspection.value = { status: 'ready', info };
          dropUnusedUnlockPassword();
        },
        (error: unknown) => {
          if (!isCurrent()) return;
          entry.aborts.inspect = null;
          entry.inspection.value = { status: 'failed', error: toEntryError(error) };
          dropUnusedUnlockPassword();
        },
      ),
    );
  }

  async function addFiles(
    files: Iterable<File> | ArrayLike<File>,
    source: FileSource,
  ): Promise<AddFilesReport> {
    const candidates = Array.from(files);
    const kinds = await Promise.all(candidates.map(sniff));
    // Compared with the list as it is now: another batch may have arrived while reading.
    const known = new Set(records.peek().map((entry) => identity(entry.file)));
    const report: AddFilesReport = { added: [], rejected: [], duplicates: [] };
    const accepted: EntryRecord[] = [];
    candidates.forEach((file, index) => {
      if (kinds[index] === 'other') {
        report.rejected.push(file.name);
      } else if (known.has(identity(file))) {
        report.duplicates.push(file.name);
      } else {
        known.add(identity(file));
        accepted.push(createEntry(file, source));
      }
    });

    if (accepted.length > 0) {
      records.value = [...records.peek(), ...accepted];
      accepted.forEach(inspect);
      report.added = accepted;
    }
    if (report.rejected.length === 1) {
      toasts.show(
        { key: 'toast.notPdf', params: { name: report.rejected[0]! } },
        { tone: 'error' },
      );
    } else if (report.rejected.length > 1) {
      toasts.show(
        { key: 'toast.notPdfCount', params: { count: report.rejected.length } },
        { tone: 'error' },
      );
    }
    if (report.duplicates.length === 1) {
      toasts.show({ key: 'toast.duplicate', params: { name: report.duplicates[0]! } });
    } else if (report.duplicates.length > 1) {
      toasts.show({ key: 'toast.duplicateCount', params: { count: report.duplicates.length } });
    }
    return report;
  }

  // --- Running ---------------------------------------------------------------------------------

  /**
   * Output names for `targets`, in order: derived from the input names and distinct from each
   * other and from every other output in the list, finished or in the making, of either mode.
   */
  function reserveNames(mode: Mode, targets: readonly EntryRecord[]): string[] {
    const operation: NameOperation = mode === 'unlock' ? 'decrypt' : 'encrypt';
    const naming = deps.settings.peek().naming;
    const replaced = new Set(targets);
    const taken: string[] = [];
    for (const entry of records.peek()) {
      for (const other of MODES) {
        if (other === mode && replaced.has(entry)) continue;
        const name = entry.runs[other].peek().outputName;
        if (name !== null) taken.push(name);
      }
      // A result that is kept aside may come back under its name.
      const kept = entry.replaced.peek()?.outputName;
      if (kept && !(mode === 'lock' && replaced.has(entry))) taken.push(kept);
    }
    const wanted = targets.map((entry) => outputFileName(entry.name, operation, naming));
    return uniqueNames([...taken, ...wanted]).slice(taken.length);
  }

  function toResult(job: Job, name: string, processed: ProcessResult): EntryResult {
    return {
      operation: job.operation.kind,
      name,
      blob: processed.blob,
      size: processed.outputSize,
      inputSize: processed.inputSize,
      durationMs: processed.durationMs,
      pageCount: processed.pageCount,
      verified: processed.verified,
      warnings: processed.warnings,
      algorithm: job.operation.kind === 'encrypt' ? job.operation.options.algorithm : null,
      settings: job.settings,
      saved: false,
    };
  }

  async function runOne(mode: Mode, job: Job, outputName: string): Promise<Outcome> {
    const { entry } = job;
    const controller = new AbortController();
    entry.aborts[mode] = controller;
    const progress = entry.progressOf[mode];
    // Cancelled or removed in the meantime: whatever the engine still reports is ignored.
    const isCurrent = (): boolean => entry.aborts[mode] === controller;
    try {
      const processed = await engine.process(
        {
          file: entry.file,
          password: job.password,
          operation: job.operation,
          output: {
            streams: deps.settings.peek().output.optimizeSize ? 'compress' : 'preserve',
            linearize: deps.settings.peek().output.linearize,
            verify: true,
          },
        },
        {
          signal: controller.signal,
          onProgress: (fraction) => {
            if (!isCurrent()) return;
            batch(() => {
              if (entry.runs[mode].peek().status === 'queued') {
                patchRun(entry, mode, { status: 'running' });
              }
              if (fraction > progress.peek()) progress.value = Math.min(1, fraction);
            });
          },
        },
      );
      if (!isCurrent()) return 'cancelled';
      batch(() => {
        progress.value = 1;
        entry.runs[mode].value = {
          ...IDLE_RUN,
          status: 'done',
          outputName,
          result: toResult(job, outputName, processed),
        };
        if (mode === 'lock') entry.replaced.value = null;
        else entry.retry.value = '';
      });
      return 'done';
    } catch (error) {
      if (!isCurrent()) return 'cancelled';
      const failure = toEntryError(error);
      if (failure.code === 'cancelled') {
        rest(entry, mode);
        return 'cancelled';
      }
      if (failure.code === 'password-incorrect' || failure.code === 'password-required') {
        const { ownField } = entry.runs[mode].peek();
        batch(() => {
          entry.runs[mode].value = { ...IDLE_RUN, passwordRejected: true, ownField };
          // The input no longer opens the way it did: what was made from it is not put back.
          if (mode === 'lock') entry.replaced.value = null;
        });
        return 'rejected';
      }
      // A result that this run was to replace stays aside: "retry" brings it back.
      entry.runs[mode].value = { ...IDLE_RUN, status: 'failed', error: failure };
      return 'failed';
    } finally {
      if (isCurrent()) entry.aborts[mode] = null;
    }
  }

  function anyProcessing(mode: Mode): boolean {
    return records.peek().some((entry) => isProcessing(entry.runs[mode].peek()));
  }

  function anyAnalysing(): boolean {
    return records.peek().some((entry) => entry.inspection.peek().status === 'pending');
  }

  /**
   * The shared unlock password is of no use once no file is waiting for one, and none can turn
   * out to: a file that is still being read may need it.
   */
  function dropUnusedUnlockPassword(): void {
    if (anyProcessing('unlock') || lockedCount.peek() > 0 || anyAnalysing()) return;
    batch(() => {
      unlockPassword.value = '';
      unlockRevealed.value = false;
      unlockRejected.value = false;
    });
  }

  /**
   * Unlock: every card that shows its own retry field from now on keeps it. Without this the
   * field of one card (and what was typed into it) would come and go with the fate of the
   * others, because a single locked file is retried with the shared field.
   */
  function keepRetryFields(): void {
    if (lockedCount.peek() <= 1) return;
    batch(() => {
      for (const entry of records.peek()) {
        const run = entry.runs.unlock.peek();
        if (run.status === 'idle' && run.passwordRejected && !run.ownField) {
          patchRun(entry, 'unlock', { ownField: true });
        }
      }
    });
  }

  /**
   * A run that is no longer in flight comes to rest: in Lock mode on the finished run it was
   * started to replace, if there is one.
   */
  function rest(entry: EntryRecord, mode: Mode): void {
    const kept = mode === 'lock' ? entry.replaced.peek() : null;
    batch(() => {
      entry.runs[mode].value = kept ?? IDLE_RUN;
      entry.progressOf[mode].value = kept ? 1 : 0;
      if (mode === 'lock') {
        entry.replaced.value = null;
        forgetOpened(entry);
      }
    });
  }

  function hasLockRun(entry: EntryRecord): boolean {
    const run = entry.runs.lock.peek();
    return run.status === 'done' || isProcessing(run) || entry.replaced.peek() !== null;
  }

  /** The password that opened an input is kept for the Lock runs it belongs to, no longer. */
  function forgetOpened(entry: EntryRecord): void {
    if (!hasLockRun(entry)) entry.opened = '';
  }

  /** Submitted lock settings, passwords included, go when nothing was made with them any more. */
  function dropUnusedLockSettings(): void {
    const used = new Set<number | null>();
    for (const entry of records.peek()) {
      const run = entry.runs.lock.peek();
      if (isProcessing(run)) used.add(lockSubmitted.peek());
      if (run.result) used.add(run.result.settings);
      const kept = entry.replaced.peek()?.result;
      if (kept) used.add(kept.settings);
    }
    const revisions = lockRevisions.peek();
    if ([...revisions.keys()].every((revision) => used.has(revision))) return;
    lockRevisions.value = new Map([...revisions].filter(([revision]) => used.has(revision)));
  }

  /**
   * Runs `jobs` and resolves once they have all come to rest. `afterwards` sees the outcomes
   * first, before any automatic delivery: passwords are dropped as early as possible.
   */
  async function runJobs(
    mode: Mode,
    jobs: readonly Job[],
    afterwards: (outcomes: readonly Outcome[]) => void,
  ): Promise<Outcome[]> {
    const names = reserveNames(
      mode,
      jobs.map((job) => job.entry),
    );
    batch(() => {
      // A batch that is still running takes the new files in; a finished one is replaced.
      const running = anyProcessing(mode) ? batches[mode].peek() : [];
      batches[mode].value = [...new Set([...running, ...jobs.map((job) => job.entry.id)])];
      jobs.forEach((job, index) => {
        const { ownField } = job.entry.runs[mode].peek();
        job.entry.progressOf[mode].value = 0;
        job.entry.runs[mode].value = {
          ...IDLE_RUN,
          status: 'queued',
          outputName: names[index]!,
          ownField,
        };
      });
    });
    const outcomes = await Promise.all(jobs.map((job, index) => runOne(mode, job, names[index]!)));
    afterwards(outcomes);
    if (!anyProcessing(mode)) await finishBatch(mode);
    return outcomes;
  }

  /** Everything of a batch has come to rest: deliver the results if the user asked for that. */
  async function finishBatch(mode: Mode): Promise<void> {
    if (!deps.settings.peek().autoSave) return;
    const ids = new Set(batches[mode].peek());
    // Lock: only what was made with the settings submitted last. A file of the batch whose run
    // was cancelled shows the result it had before again, and that one opens with a password
    // that is no longer on screen: it is not handed out here either.
    const made = mode === 'lock' ? lockSubmitted.peek() : null;
    const fresh = records
      .peek()
      .filter((entry) => ids.has(entry.id))
      .map((entry) => entry.runs[mode].peek().result)
      .filter(
        (result): result is EntryResult =>
          result !== null && !result.saved && result.settings === made,
      );
    if (fresh.length === 0) return;
    // Marked first, so that a second batch finishing meanwhile does not deliver them again.
    markSaved(mode, fresh);
    try {
      if (fresh.length === 1) {
        deps.save.downloadFile(toOutput(fresh[0]!));
      } else {
        // No picker here: the click that started the run is long gone.
        const blob = await deps.save.createZip(fresh.map(toOutput));
        deps.save.downloadFile({ name: `${deps.archiveName(mode)}.zip`, blob });
      }
      toasts.show({ key: 'toast.autoSaved' }, { tone: 'success' });
    } catch {
      markSaved(mode, fresh, false);
      toasts.show({ key: 'toast.saveFailed' }, { tone: 'error' });
    }
  }

  async function unlockAll(password: string = unlockPassword.peek()): Promise<RunReport> {
    const jobs: Job[] = [];
    let locked = 0;
    for (const entry of records.peek()) {
      const state = entryState(entry.inspection.peek(), entry.runs.unlock.peek(), 'unlock');
      const operation: Operation = { kind: 'decrypt' };
      if (state === 'restricted') {
        jobs.push({ entry, password: '', operation, settings: null });
      } else if (state === 'needs-password' || state === 'wrong-password') {
        locked++;
        // The shared password is for every file; without one, a card's own field counts.
        const tried = password !== '' ? password : untracked(() => ownPassword(entry));
        if (tried !== '') jobs.push({ entry, password: tried, operation, settings: null });
      }
    }
    if (jobs.length === 0) return refused(locked > 0 ? 'password-required' : 'nothing-to-do');

    unlockRejected.value = false;
    keepRetryFields();
    const outcomes = await runJobs('unlock', jobs, (results) => {
      const tried = results.filter((_, index) => jobs[index]!.password !== '');
      const stillInField = password !== '' && unlockPassword.peek() === password;
      if (tried.includes('done')) {
        // It has done its job; whatever it did not open gets a field of its own.
        if (stillInField) {
          batch(() => {
            unlockPassword.value = '';
            unlockRevealed.value = false;
          });
        }
      } else if (tried.includes('rejected') && stillInField) {
        unlockRejected.value = true;
      }
      keepRetryFields();
      dropUnusedUnlockPassword();
    });
    return toReport(outcomes);
  }

  async function retryUnlock(
    id: string,
    password: string = record(id)?.retry.peek() ?? '',
  ): Promise<RunReport> {
    const entry = record(id);
    if (!entry) return refused('nothing-to-do');
    const state = entryState(entry.inspection.peek(), entry.runs.unlock.peek(), 'unlock');
    const locked = state === 'needs-password' || state === 'wrong-password';
    if (!locked && state !== 'restricted') return refused('nothing-to-do');
    if (locked && password === '') return refused('password-required');
    const job: Job = {
      entry,
      password: locked ? password : '',
      operation: { kind: 'decrypt' },
      settings: null,
    };
    // The cards have taken over: the shared password was tried and is of no further use, and
    // the action area must not go on showing it, or the message about it.
    if (locked && unlockRejected.peek()) {
      batch(() => {
        unlockPassword.value = '';
        unlockRevealed.value = false;
        unlockRejected.value = false;
      });
    }
    keepRetryFields();
    const outcomes = await runJobs('unlock', [job], () => {
      keepRetryFields();
      dropUnusedUnlockPassword();
    });
    return toReport(outcomes);
  }

  async function lockAll(options?: EncryptOptions): Promise<RunReport> {
    let encrypt: EncryptOptions;
    if (options) {
      const problem = checkNewPasswords(options);
      if (problem) return refused(problem);
      encrypt = options;
    } else {
      const submitted = deps.lockForm.submit();
      if (!submitted.ok) return refused('invalid-form', submitted.field);
      encrypt = submitted.options;
    }

    // Settings that something in the list was made with keep their number, and with it those
    // results; anything else is a new set.
    const known = revisionOf(lockRevisions.peek(), encrypt);
    const revision = known ?? lastRevision + 1;
    const operation: Operation = { kind: 'encrypt', options: encrypt };

    const jobs: Job[] = [];
    let waiting = 0;
    batch(() => {
      for (const entry of records.peek()) {
        const inspection = entry.inspection.peek();
        const run = entry.runs.lock.peek();
        const state = entryState(inspection, run, 'lock');
        // Made, or being made, with other settings: the file is processed again from its input,
        // so that every result in the list ends up with the settings submitted now.
        const again =
          state === 'done'
            ? run.result?.settings !== revision
            : state === 'processing' && lockSubmitted.peek() !== revision;
        const from = again ? entryState(inspection, IDLE_RUN, 'lock') : state;
        if (from === 'ready') {
          jobs.push({ entry, password: '', operation, settings: revision });
        } else if (from === 'encrypted') {
          const reopened = again ? entry.opened : '';
          const current = needsOpenPassword(inspection) ? reopened || entry.password.peek() : '';
          if (needsOpenPassword(inspection) && current === '') {
            waiting++;
            if (!again) patchRun(entry, 'lock', { passwordMissing: true });
          } else {
            jobs.push({ entry, password: current, operation, settings: revision });
          }
        } else if (from === 'wrong-password') {
          // The rejected password is still in the field; it has to be corrected first.
          waiting++;
        }
      }
      if (jobs.length > 0) {
        lastRevision = Math.max(lastRevision, revision);
        if (known === undefined) {
          lockRevisions.value = new Map(lockRevisions.peek()).set(revision, encrypt);
        }
        lockSubmitted.value = revision;
        for (const { entry, password } of jobs) {
          const run = entry.runs.lock.peek();
          // What is finished is kept aside until its replacement is; what is still running is
          // dropped, and what that run was to replace stays aside for the new one.
          if (run.status === 'done') entry.replaced.value = run;
          else abortRun(entry, 'lock');
          entry.opened = password;
        }
      }
    });
    if (jobs.length === 0) {
      return refused(waiting > 0 ? 'current-password-required' : 'nothing-to-do');
    }

    const outcomes = await runJobs('lock', jobs, (results) => {
      batch(() => {
        results.forEach((outcome, index) => {
          const { entry } = jobs[index]!;
          // The old password of a file that now has a new one has no place in its field.
          if (outcome === 'done') entry.password.value = '';
          forgetOpened(entry);
        });
        dropUnusedLockSettings();
      });
    });
    return toReport(outcomes);
  }

  // --- Cancelling, removing --------------------------------------------------------------------

  /** Stops the engine's work on a file without touching the file's state. */
  function abortRun(entry: EntryRecord, mode: Mode): boolean {
    const controller = entry.aborts[mode];
    if (!controller) return false;
    // Detached first: the state changes now, not when the engine has noticed the abort.
    entry.aborts[mode] = null;
    controller.abort();
    return true;
  }

  function stopRun(entry: EntryRecord, mode: Mode): void {
    if (abortRun(entry, mode)) rest(entry, mode);
  }

  function detach(entry: EntryRecord): void {
    const inspection = entry.aborts.inspect;
    entry.aborts.inspect = null;
    inspection?.abort();
    for (const mode of MODES) {
      const controller = entry.aborts[mode];
      entry.aborts[mode] = null;
      controller?.abort();
    }
    entry.password.value = '';
    entry.retry.value = '';
    entry.opened = '';
    entry.replaced.value = null;
  }

  /** Nothing is left to use a password on: all of them go, the lock form's included. */
  function forgetPasswords(): void {
    batch(() => {
      unlockPassword.value = '';
      unlockRevealed.value = false;
      unlockRejected.value = false;
      lockRevisions.value = new Map();
      deps.lockForm.clearSecrets();
    });
  }

  function remove(id: string): void {
    const entry = record(id);
    if (!entry) return;
    batch(() => {
      detach(entry);
      records.value = records.peek().filter((other) => other !== entry);
      for (const mode of MODES) {
        batches[mode].value = batches[mode].peek().filter((other) => other !== id);
      }
      if (records.peek().length === 0) {
        forgetPasswords();
      } else {
        dropUnusedUnlockPassword();
        dropUnusedLockSettings();
        dropLonelyRetryField();
      }
    });
  }

  /**
   * Unlock: a file that is alone in the list is retried with the shared field. The phone shows
   * it without a card, so a field of its own, and what was typed there, would be out of sight
   * and still be tried by the main button.
   */
  function dropLonelyRetryField(): void {
    const [only, ...others] = records.peek();
    if (!only || others.length > 0) return;
    only.retry.value = '';
    if (only.runs.unlock.peek().ownField) patchRun(only, 'unlock', { ownField: false });
  }

  function clear(): void {
    batch(() => {
      records.peek().forEach(detach);
      records.value = [];
      for (const mode of MODES) batches[mode].value = [];
      forgetPasswords();
    });
  }

  // --- Results ---------------------------------------------------------------------------------

  function toOutput(result: EntryResult): OutputFile {
    return { name: result.name, blob: result.blob };
  }

  function markSaved(mode: Mode, results: readonly EntryResult[], saved = true): void {
    const wanted = new Set(results.map((result) => result.blob));
    batch(() => {
      for (const entry of records.peek()) {
        const run = entry.runs[mode].peek();
        // Matched by output, not by entry: the file may have been processed again meanwhile.
        if (run.result && wanted.has(run.result.blob) && run.result.saved !== saved) {
          entry.runs[mode].value = { ...run, result: { ...run.result, saved } };
        }
      }
    });
  }

  /** The result of a file in `mode`, unless it is withheld (see `ResultView.withheld`). */
  function offered(entry: EntryRecord | undefined, mode: Mode): EntryResult | null {
    const result = entry?.runs[mode].peek().result ?? null;
    const target = mode === 'lock' ? lockTarget.peek() : null;
    return result && target !== null && result.settings !== target ? null : result;
  }

  function currentResults(): { mode: Mode; results: EntryResult[] } {
    const mode = deps.mode.peek();
    const results = records
      .peek()
      .map((entry) => offered(entry, mode))
      .filter((result): result is EntryResult => result !== null);
    return { mode, results };
  }

  function resultOf(id: string): { mode: Mode; result: EntryResult } | null {
    const mode = deps.mode.peek();
    const result = offered(record(id), mode);
    return result ? { mode, result } : null;
  }

  /** Awaits a save that was already started (synchronously) and reports how it went. */
  async function reportSave(
    mode: Mode,
    results: readonly EntryResult[],
    started: () => Promise<SaveOutcome>,
  ): Promise<void> {
    try {
      const outcome = await started();
      if (outcome === 'cancelled') return;
      markSaved(mode, results);
      const message: Message =
        outcome === 'downloaded'
          ? { key: 'toast.downloaded' }
          : results.length > 1
            ? { key: 'toast.savedCount', params: { count: results.length } }
            : { key: 'toast.saved' };
      toasts.show(message, { tone: 'success' });
    } catch {
      toasts.show({ key: 'toast.saveFailed' }, { tone: 'error' });
    }
  }

  /** Same for the share sheet. */
  async function reportShare(started: () => Promise<saveLib.ShareOutcome>): Promise<void> {
    try {
      if ((await started()) === 'unsupported') {
        toasts.show({ key: 'toast.shareUnsupported' }, { tone: 'error' });
      }
    } catch {
      toasts.show({ key: 'toast.shareFailed' }, { tone: 'error' });
    }
  }

  // `started()` is invoked before the first await of these functions, i.e. within the click.

  function save(id: string): Promise<void> {
    const found = resultOf(id);
    if (!found) return Promise.resolve();
    return reportSave(found.mode, [found.result], () => deps.save.saveFile(toOutput(found.result)));
  }

  function saveAll(target: SaveAllTarget = 'zip'): Promise<void> {
    const { mode, results } = currentResults();
    if (results.length === 0) return Promise.resolve();
    const files = results.map(toOutput);
    return reportSave(mode, results, () => {
      if (files.length === 1) return deps.save.saveFile(files[0]!);
      return target === 'folder' && getCapabilities().canPickDirectory
        ? deps.save.saveToDirectory(files)
        : deps.save.saveAsZip(files, `${deps.archiveName(mode)}.zip`);
    });
  }

  function share(id: string): Promise<void> {
    const found = resultOf(id);
    if (!found) return Promise.resolve();
    return reportShare(() => deps.save.shareFiles([toOutput(found.result)]));
  }

  function shareAll(): Promise<void> {
    const { results } = currentResults();
    if (results.length === 0) return Promise.resolve();
    return reportShare(() => deps.save.shareFiles(results.map(toOutput)));
  }

  function open(id: string): void {
    const found = resultOf(id);
    if (!found) return;
    try {
      deps.save.openInNewTab(toOutput(found.result));
    } catch {
      toasts.show({ key: 'toast.openFailed' }, { tone: 'error' });
    }
  }

  // --- Public surface --------------------------------------------------------------------------

  return {
    entries: records,
    summary,
    overallProgress,
    unlockPassword,
    unlockRevealed,
    lockApplied,
    unsavedWork,
    get capabilities() {
      return getCapabilities();
    },
    find: record,
    addFiles: (files, source) => track(addFiles(files, source)),

    setUnlockPassword(value) {
      if (value === unlockPassword.peek()) return;
      batch(() => {
        unlockPassword.value = value;
        unlockRejected.value = false;
      });
    },
    setUnlockRevealed(revealed) {
      unlockRevealed.value = revealed;
    },
    unlockAll: (password) => track(unlockAll(password)),
    setRetryPassword(id, value) {
      const entry = record(id);
      if (entry) entry.retry.value = value;
    },
    retryUnlock: (id, password) => track(retryUnlock(id, password)),

    setCurrentPassword(id, value) {
      const entry = record(id);
      if (!entry) return;
      batch(() => {
        entry.password.value = value;
        const run = entry.runs.lock.peek();
        if (run.passwordRejected || run.passwordMissing) {
          patchRun(entry, 'lock', { passwordRejected: false, passwordMissing: false });
        }
      });
    },
    lockAll: (options) => track(lockAll(options)),
    copyLockPassword() {
      return deps.lockForm.copyText(lockApplied.peek()?.password ?? '');
    },
    runPrimary() {
      return track(deps.mode.peek() === 'unlock' ? unlockAll() : lockAll());
    },

    cancel(id) {
      const entry = record(id);
      if (!entry) return;
      batch(() => {
        stopRun(entry, deps.mode.peek());
        dropUnusedLockSettings();
      });
    },
    cancelAll() {
      const mode = deps.mode.peek();
      batch(() => {
        records.peek().forEach((entry) => stopRun(entry, mode));
        dropUnusedLockSettings();
      });
    },
    remove,
    clear,
    retry(id) {
      const entry = record(id);
      if (!entry) return;
      const mode = deps.mode.peek();
      if (entry.runs[mode].peek().status === 'failed') {
        rest(entry, mode);
      } else if (entry.inspection.peek().status === 'failed') {
        inspect(entry);
      }
    },
    redo(id) {
      const entry = record(id);
      const mode = deps.mode.peek();
      if (entry && entry.runs[mode].peek().status === 'done') {
        batch(() => {
          entry.runs[mode].value = IDLE_RUN;
          entry.progressOf[mode].value = 0;
          forgetOpened(entry);
          dropUnusedLockSettings();
        });
      }
    },
    retryInspections(code) {
      for (const entry of records.peek()) {
        const inspection = entry.inspection.peek();
        if (inspection.status === 'failed' && (!code || inspection.error.code === code)) {
          inspect(entry);
        }
      }
    },

    save,
    share,
    open,
    saveAll,
    shareAll,

    async settled() {
      while (pending.size > 0) await Promise.all([...pending]);
    },
  };
}

/** The app's file list. */
export const jobs: JobsController = createJobsController({
  engine: appEngine,
  mode: appMode,
  settings: appSettings,
  toasts: appToasts,
  lockForm: appLockForm,
  save: { ...saveLib, createZip },
  archiveName: (mode) =>
    translate(locale.peek(), mode === 'unlock' ? 'zip.unlocked' : 'zip.locked'),
});

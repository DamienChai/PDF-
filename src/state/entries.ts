/**
 * The file list's data model and everything that is *derived* from it for display: the state of
 * a card, its chips, notes and inline password field, the details sheet, and the summary that
 * drives the action area. Pure functions; the controller in jobs.ts owns the signals.
 *
 * An entry has one inspection (what the file is) and one run per mode (what was done to it in
 * that mode). What a card shows is a function of the inspection, the run of the current mode,
 * and the mode.
 */
import type { EncryptOptions, InspectResult } from '../engine/types';
import {
  PERMISSION_ORDER,
  algorithmChipLabel,
  algorithmLabel,
  errorText,
  isOutdatedAlgorithm,
  permissionLabel,
  restrictionList,
  type ErrorCode,
  type Message,
  type PermissionId,
  type Text,
} from '../i18n';
import type { SaveCapabilities } from '../lib/save';
import type { Mode } from './mode';

// --- Model -------------------------------------------------------------------------------------

export interface EntryError {
  code: ErrorCode;
  /** Low-level text for the "technical details" disclosure. */
  detail: string | null;
}

export interface EntryResult {
  operation: 'decrypt' | 'encrypt';
  /** Output file name, unique among all outputs in the list. */
  name: string;
  blob: Blob;
  /** Size of the output in bytes. */
  size: number;
  inputSize: number;
  /** Time the engine took, in milliseconds. */
  durationMs: number;
  pageCount: number;
  /** The output was re-opened and checked by the engine. */
  verified: boolean;
  warnings: readonly string[];
  /** Encryption of the output; null for unlocked files. */
  algorithm: EncryptOptions['algorithm'] | null;
  /**
   * Lock: the number of the submitted settings that produced this output (see `lockApplied` of
   * the controller); null for unlocked files. A number, so that no result carries a password.
   */
  settings: number | null;
  /** Saved, downloaded or auto-saved at least once. */
  saved: boolean;
}

export type Inspection =
  | { status: 'pending' }
  | { status: 'ready'; info: InspectResult }
  | { status: 'failed'; error: EntryError };

export type RunStatus = 'idle' | 'queued' | 'running' | 'done' | 'failed';

/** What one mode did, or is doing, to an entry. */
export interface Run {
  status: RunStatus;
  /** The password tried last did not open the file. */
  passwordRejected: boolean;
  /** Lock mode: "Lock" was pressed while this card had no current password. */
  passwordMissing: boolean;
  /**
   * Unlock mode: the card has its own retry field and keeps it until the file is unlocked,
   * whatever happens to the other files meanwhile.
   */
  ownField: boolean;
  /** Reserved while processing, final once done. */
  outputName: string | null;
  result: EntryResult | null;
  error: EntryError | null;
}

export const IDLE_RUN: Readonly<Run> = Object.freeze({
  status: 'idle',
  passwordRejected: false,
  passwordMissing: false,
  ownField: false,
  outputName: null,
  result: null,
  error: null,
});

// --- Card state --------------------------------------------------------------------------------

/**
 * Unlock mode: analysing → needs-password | restricted | not-encrypted → processing → done,
 * with wrong-password and error on the side. Lock mode: analysing → ready | encrypted →
 * processing → done, with wrong-password (current password rejected) and error.
 */
export type EntryState =
  | 'analysing'
  | 'needs-password'
  | 'restricted'
  | 'not-encrypted'
  | 'ready'
  | 'encrypted'
  | 'wrong-password'
  | 'processing'
  | 'done'
  | 'error';

export function entryState(inspection: Inspection, run: Run, mode: Mode): EntryState {
  if (run.status === 'queued' || run.status === 'running') return 'processing';
  if (run.status === 'done') return 'done';
  if (run.status === 'failed') return 'error';
  if (inspection.status === 'pending') return 'analysing';
  if (inspection.status === 'failed') return 'error';
  if (run.passwordRejected) return 'wrong-password';
  const { info } = inspection;
  if (mode === 'lock') return info.encrypted ? 'encrypted' : 'ready';
  if (!info.encrypted) return 'not-encrypted';
  return info.opensWithoutPassword ? 'restricted' : 'needs-password';
}

/** The input needs a password to be opened at all. */
export function needsOpenPassword(inspection: Inspection): boolean {
  return (
    inspection.status === 'ready' &&
    inspection.info.encrypted &&
    !inspection.info.opensWithoutPassword
  );
}

// --- Card view ---------------------------------------------------------------------------------

export type Tone = 'neutral' | 'info' | 'warning' | 'success' | 'danger';

export interface ChipView {
  label: Message;
  tone: Tone;
}

export interface AlgorithmChipView {
  label: Message;
  /** RC4: show it as a warning. */
  outdated: boolean;
}

export interface PasswordFieldView {
  /**
   * `retry`: unlock mode, a field with its own submit button; call `retryUnlock(id, password)`.
   * `current`: lock mode, bound to `entry.currentPassword` / `setCurrentPassword(id, value)`.
   */
  kind: 'retry' | 'current';
  label: Message;
  placeholder: Message;
  hint: Message | null;
  error: Message | null;
  submitLabel: Message | null;
}

export interface ResultView {
  name: string;
  size: number;
  inputSize: number;
  durationMs: number;
  pageCount: number;
  verified: boolean;
  saved: boolean;
  /** Offer "Share": the platform can share PDF files. */
  canShare: boolean;
}

export interface ErrorView {
  code: ErrorCode;
  title: Message;
  advice: Message;
  /** For the "technical details" disclosure; null if there is nothing to show. */
  detail: string | null;
}

export interface EntryView {
  id: string;
  name: string;
  /** Size of the input in bytes. */
  size: number;
  /** null while unknown (analysing, locked, failed). */
  pageCount: number | null;
  mode: Mode;
  state: EntryState;
  chip: ChipView;
  algorithm: AlgorithmChipView | null;
  /** One quiet line under the name, e.g. the restrictions or "Will be encrypted". */
  note: Text | null;
  /** The file was readable only after repairs. */
  warning: Message | null;
  /** Inline password field of the card, if it shows one. */
  password: PasswordFieldView | null;
  /** `state === 'processing'` but the engine has not started this file yet. */
  queued: boolean;
  result: ResultView | null;
  error: ErrorView | null;
  canCancel: boolean;
  /** Error state: `retry(id)` is worth offering. */
  canRetry: boolean;
  /** Done: `redo(id)` discards the result so the file can be processed again. */
  canRedo: boolean;
  canShowDetails: boolean;
}

export interface ViewContext {
  mode: Mode;
  /** Unlock mode: number of files that still need a password (never tried or rejected). */
  lockedCount: number;
  canShare: boolean;
}

export interface EntryBase {
  id: string;
  name: string;
  size: number;
}

/** Failures that will not go away by trying again with the same file. */
const PERMANENT_FAILURES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'not-pdf',
  'damaged',
  'unsupported-encryption',
]);

function errorView(error: EntryError): ErrorView {
  return { code: error.code, ...errorText(error.code), detail: error.detail };
}

function chipFor(state: EntryState, mode: Mode, queued: boolean): ChipView {
  switch (state) {
    case 'analysing':
      return { label: { key: 'chip.analysing' }, tone: 'neutral' };
    // `info` is the accent: the password the user is about to type acts on this file.
    case 'needs-password':
      return { label: { key: 'chip.needsPassword' }, tone: 'info' };
    case 'restricted':
      return { label: { key: 'chip.restricted' }, tone: 'warning' };
    case 'not-encrypted':
    case 'ready':
      return { label: { key: 'chip.notEncrypted' }, tone: 'neutral' };
    case 'encrypted':
      return { label: { key: 'chip.encrypted' }, tone: 'info' };
    case 'wrong-password':
      return { label: { key: 'chip.wrongPassword' }, tone: 'danger' };
    case 'processing':
      return { label: { key: queued ? 'chip.queued' : 'chip.processing' }, tone: 'neutral' };
    case 'done':
      return {
        label: { key: mode === 'unlock' ? 'chip.unlocked' : 'chip.locked' },
        tone: 'success',
      };
    case 'error':
      return { label: { key: 'chip.error' }, tone: 'danger' };
  }
}

function noteFor(state: EntryState, info: InspectResult | null): Text | null {
  switch (state) {
    case 'restricted': {
      const restrictions = info?.encryption ? restrictionList(info.encryption.permissions) : null;
      return restrictions && restrictions.list.length > 0
        ? restrictions
        : { key: 'entry.note.noRestrictions' };
    }
    case 'not-encrypted':
      return { key: 'entry.note.nothingToUnlock' };
    case 'ready':
      return { key: 'entry.note.willEncrypt' };
    case 'encrypted':
      return { key: 'entry.note.willReplace' };
    default:
      return null;
  }
}

function passwordFieldFor(
  state: EntryState,
  inspection: Inspection,
  run: Run,
  context: ViewContext,
): PasswordFieldView | null {
  if (context.mode === 'unlock') {
    // A single locked file is retried with the main password field; several each get their own,
    // and a card that has its own keeps it.
    if (state !== 'wrong-password' || !(run.ownField || context.lockedCount > 1)) return null;
    return {
      kind: 'retry',
      label: { key: 'entry.password.label' },
      placeholder: { key: 'entry.password.placeholder' },
      hint: null,
      error: { key: 'entry.password.wrong' },
      submitLabel: { key: 'entry.password.submit' },
    };
  }
  if ((state !== 'encrypted' && state !== 'wrong-password') || !needsOpenPassword(inspection)) {
    return null;
  }
  return {
    kind: 'current',
    label: { key: 'entry.currentPassword.label' },
    placeholder: { key: 'entry.currentPassword.placeholder' },
    hint: { key: 'entry.note.needsCurrentPassword' },
    error: run.passwordRejected
      ? { key: 'entry.currentPassword.wrong' }
      : run.passwordMissing
        ? { key: 'entry.currentPassword.required' }
        : null,
    submitLabel: null,
  };
}

function algorithmChipFor(
  state: EntryState,
  info: InspectResult | null,
  result: EntryResult | null,
): AlgorithmChipView | null {
  if (state === 'done') {
    if (!result?.algorithm) return null;
    const keyBits = result.algorithm === 'aes-256' ? 256 : 128;
    return { label: algorithmChipLabel({ algorithm: result.algorithm, keyBits }), outdated: false };
  }
  if (state === 'error' || !info?.encryption) return null;
  return {
    label: algorithmChipLabel(info.encryption),
    outdated: isOutdatedAlgorithm(info.encryption.algorithm),
  };
}

function resultView(result: EntryResult, canShare: boolean): ResultView {
  return {
    name: result.name,
    size: result.size,
    inputSize: result.inputSize,
    durationMs: result.durationMs,
    pageCount: result.pageCount,
    verified: result.verified,
    saved: result.saved,
    canShare,
  };
}

export function deriveEntryView(
  base: EntryBase,
  inspection: Inspection,
  run: Run,
  context: ViewContext,
): EntryView {
  const state = entryState(inspection, run, context.mode);
  const info = inspection.status === 'ready' ? inspection.info : null;
  const queued = run.status === 'queued';
  const error =
    state !== 'error'
      ? null
      : (run.error ?? (inspection.status === 'failed' ? inspection.error : null));
  const warnings = run.result?.warnings ?? info?.warnings ?? [];
  return {
    id: base.id,
    name: base.name,
    size: base.size,
    pageCount: run.result?.pageCount ?? info?.pageCount ?? null,
    mode: context.mode,
    state,
    chip: chipFor(state, context.mode, queued),
    algorithm: algorithmChipFor(state, info, run.result),
    note: noteFor(state, info),
    warning:
      warnings.length > 0 && state !== 'error'
        ? { key: 'entry.warnings', params: { count: warnings.length } }
        : null,
    password: passwordFieldFor(state, inspection, run, context),
    queued,
    result: state === 'done' && run.result ? resultView(run.result, context.canShare) : null,
    error: error ? errorView(error) : null,
    canCancel: state === 'processing',
    canRetry: error !== null && (run.error !== null || !PERMANENT_FAILURES.has(error.code)),
    canRedo: state === 'done',
    canShowDetails: info !== null,
  };
}

// --- Details sheet -----------------------------------------------------------------------------

export interface PermissionRow {
  id: PermissionId;
  label: Message;
  status: 'allowed' | 'limited' | 'denied';
  statusLabel: Message;
}

export interface DetailsView {
  id: string;
  name: string;
  size: number;
  /** False while analysing or when the file could not be read: only name and size are known. */
  available: boolean;
  /** "Not encrypted" / "Password required to open" / "Restrictions only …". */
  protection: Message | null;
  encrypted: boolean;
  /** Full algorithm name, e.g. "RC4 40-bit (outdated)"; null if not encrypted. */
  algorithm: Message | null;
  /** Advice shown when the algorithm is outdated. */
  outdatedNote: Message | null;
  keyLength: Message | null;
  pdfVersion: string | null;
  /** null while the file is locked. */
  pageCount: number | null;
  linearized: boolean | null;
  /** null if not encrypted. */
  metadataEncrypted: boolean | null;
  /** Empty when nothing is known. */
  permissions: PermissionRow[];
  permissionsNote: Message | null;
  /** Engine messages about repairs, verbatim (English). */
  warnings: readonly string[];
  /** The result of the current mode, if there is one. */
  result: ResultView | null;
  error: ErrorView | null;
}

function permissionRows(info: InspectResult): PermissionRow[] {
  const permissions = info.encryption?.permissions;
  return PERMISSION_ORDER.map((id) => {
    const value = permissions ? permissions[id] : true;
    const status: PermissionRow['status'] =
      value === true || value === 'full' ? 'allowed' : value === 'low' ? 'limited' : 'denied';
    return {
      id,
      label: permissionLabel(id),
      status,
      statusLabel: {
        key:
          status === 'allowed'
            ? 'permission.allowed'
            : status === 'limited'
              ? 'permission.lowResolution'
              : 'permission.denied',
      },
    };
  });
}

export function deriveDetails(
  base: EntryBase,
  inspection: Inspection,
  run: Run,
  context: ViewContext,
): DetailsView {
  const result = run.result ? resultView(run.result, context.canShare) : null;
  const failure = run.error ?? (inspection.status === 'failed' ? inspection.error : null);
  const error = failure ? errorView(failure) : null;
  if (inspection.status !== 'ready') {
    return {
      ...base,
      available: false,
      protection: null,
      encrypted: false,
      algorithm: null,
      outdatedNote: null,
      keyLength: null,
      pdfVersion: null,
      pageCount: null,
      linearized: null,
      metadataEncrypted: null,
      permissions: [],
      permissionsNote: null,
      warnings: [],
      result,
      error,
    };
  }
  const { info } = inspection;
  const { encryption } = info;
  return {
    ...base,
    available: true,
    protection: {
      key: !info.encrypted
        ? 'details.protection.none'
        : info.opensWithoutPassword
          ? 'details.protection.restrictions'
          : 'details.protection.password',
    },
    encrypted: info.encrypted,
    algorithm: encryption ? algorithmLabel(encryption) : null,
    outdatedNote:
      encryption && isOutdatedAlgorithm(encryption.algorithm) ? { key: 'details.outdated' } : null,
    keyLength: encryption ? { key: 'details.bits', params: { bits: encryption.keyBits } } : null,
    pdfVersion: info.pdfVersion,
    pageCount: run.result?.pageCount ?? info.pageCount,
    linearized: info.linearized,
    metadataEncrypted: encryption ? encryption.encryptMetadata : null,
    permissions: permissionRows(info),
    permissionsNote: {
      key: info.encrypted ? 'details.permissions.withPassword' : 'details.permissions.all',
    },
    warnings: run.result?.warnings ?? info.warnings,
    result,
    error,
  };
}

// --- Summary: what the action area shows ----------------------------------------------------------

/**
 * - `empty`       no files: the empty state
 * - `analysing`   files are being inspected and nothing can be done yet
 * - `ready`       the form and the primary button
 * - `processing`  progress and "cancel"
 * - `finished`    nothing left to do and at least one result: the batch actions
 * - `idle`        files, but nothing to do with them in this mode (see `status`)
 */
export type WorkspacePhase = 'empty' | 'analysing' | 'ready' | 'processing' | 'finished' | 'idle';

export interface PrimaryAction {
  kind: 'unlock' | 'remove-restrictions' | 'lock';
  /** "Unlock", "Unlock 3 files", "Remove restrictions", "Lock" … */
  label: Message;
  /** Number of files it would process. */
  count: number;
  enabled: boolean;
}

export interface Summary {
  mode: Mode;
  phase: WorkspacePhase;
  total: number;
  analysing: number;
  /** Files the primary action would process. */
  actionable: number;
  /**
   * Lock: finished files among them. They were locked with other settings than the ones about
   * to be submitted and are locked again, so that one password opens every result.
   */
  relock: number;
  /**
   * Unlock: files that need a password (never tried, or rejected). Lock: encrypted files whose
   * card still waits for the current password.
   */
  needPassword: number;
  /** Unlock: files that only carry restrictions. */
  restricted: number;
  /** Unlock: files with nothing to do. */
  notEncrypted: number;
  processing: number;
  done: number;
  failed: number;
  /** Files whose password was tried and rejected (in lock mode: the current password). */
  rejected: number;
  /** Unlock: show the shared password field of the action area. */
  passwordField: boolean;
  /** Under that field when several files will be tried with it. */
  passwordHint: Message | null;
  /** The password just tried opened nothing. Cleared by typing. */
  passwordError: Message | null;
  primary: PrimaryAction | null;
  /** One line for the action area: progress, outcome, or why there is nothing to do. */
  status: Message | null;
  /** "2 files could not be processed", next to an outcome. */
  problems: Message | null;
  /** When a different mode would make sense of the files: offer to switch. */
  suggestion: { label: Message; mode: Mode } | null;
  /** Results of this mode that are still in the list. */
  results: { count: number; unsaved: number; totalSize: number };
  canSaveAll: boolean;
  /** Offer "Save to folder" next to "Save as ZIP". */
  canSaveToFolder: boolean;
  canShareAll: boolean;
  canCancelAll: boolean;
  canClear: boolean;
}

export interface SummaryItem {
  inspection: Inspection;
  run: Run;
  /** Lock mode: the card's current-password field is filled in. */
  hasCurrentPassword: boolean;
  /** Lock mode: the result was made with other settings than the ones about to be submitted. */
  outdated?: boolean;
}

export interface SummaryContext {
  mode: Mode;
  /** Unlock: the shared password field is not empty. */
  hasUnlockPassword: boolean;
  unlockRejected: boolean;
  capabilities: SaveCapabilities;
  /** Progress of the batch that is running: files finished / files in it. */
  batch: { finished: number; total: number };
}

function countLabel(
  count: number,
  single: 'action.unlock' | 'action.removeRestrictions' | 'action.lock',
): Message {
  return count > 1 ? { key: `${single}Count`, params: { count } } : { key: single };
}

export function summarize(items: readonly SummaryItem[], context: SummaryContext): Summary {
  const { mode } = context;
  let analysing = 0;
  let processing = 0;
  let done = 0;
  let failed = 0;
  let locked = 0;
  let restricted = 0;
  let notEncrypted = 0;
  let lockReady = 0;
  let lockWaiting = 0;
  let outdated = 0;
  let rejected = 0;
  let unsaved = 0;
  let totalSize = 0;

  for (const item of items) {
    switch (entryState(item.inspection, item.run, mode)) {
      case 'analysing':
        analysing++;
        break;
      case 'processing':
        processing++;
        break;
      case 'done':
        done++;
        if (item.run.result) {
          totalSize += item.run.result.size;
          if (!item.run.result.saved) unsaved++;
        }
        if (mode === 'lock' && item.outdated) outdated++;
        break;
      case 'error':
        failed++;
        break;
      case 'needs-password':
        locked++;
        break;
      case 'wrong-password':
        rejected++;
        // Lock mode: the rejected password has to be corrected on the card first.
        if (mode === 'unlock') locked++;
        else lockWaiting++;
        break;
      case 'restricted':
        restricted++;
        break;
      case 'not-encrypted':
        notEncrypted++;
        break;
      case 'ready':
        lockReady++;
        break;
      case 'encrypted':
        if (needsOpenPassword(item.inspection) && !item.hasCurrentPassword) lockWaiting++;
        else lockReady++;
        break;
    }
  }

  const total = items.length;
  // Finished files are only locked again along with something that is still to be locked:
  // while everything is finished there is no form to submit other settings with.
  const relock = lockReady + lockWaiting > 0 ? outdated : 0;
  const lockable = lockReady + relock;
  const actionable = mode === 'unlock' ? locked + restricted : lockable;
  const needPassword = mode === 'unlock' ? locked : lockWaiting;
  const busy = analysing > 0 || processing > 0;

  let primary: PrimaryAction | null = null;
  if (mode === 'unlock' && actionable > 0) {
    primary =
      locked > 0
        ? {
            kind: 'unlock',
            label: countLabel(actionable, 'action.unlock'),
            count: actionable,
            enabled: !busy && context.hasUnlockPassword,
          }
        : {
            kind: 'remove-restrictions',
            label: countLabel(actionable, 'action.removeRestrictions'),
            count: actionable,
            enabled: !busy,
          };
  } else if (mode === 'lock' && lockReady + lockWaiting > 0) {
    primary = {
      kind: 'lock',
      label: countLabel(lockable, 'action.lock'),
      count: lockable,
      enabled: !busy && lockable > 0,
    };
  }

  const phase: WorkspacePhase =
    total === 0
      ? 'empty'
      : processing > 0
        ? 'processing'
        : primary
          ? 'ready'
          : analysing > 0
            ? 'analysing'
            : done > 0
              ? 'finished'
              : 'idle';

  let status: Message | null = null;
  let suggestion: Summary['suggestion'] = null;
  if (phase === 'processing') {
    status =
      context.batch.total > 1
        ? {
            key: 'status.processingCount',
            params: { done: context.batch.finished, total: context.batch.total },
          }
        : { key: 'status.processing' };
  } else if (phase === 'analysing') {
    status = { key: 'status.analysing' };
  } else if (phase === 'ready') {
    if (mode === 'lock' && lockable === 0) status = { key: 'status.nothingToLock' };
  } else if (phase === 'finished') {
    status = {
      key: mode === 'unlock' ? 'status.unlocked' : 'status.locked',
      params: { count: done },
    };
  } else if (phase === 'idle') {
    if (mode === 'unlock' && notEncrypted === total) {
      status = { key: 'status.nothingToUnlock' };
      suggestion = { label: { key: 'action.switchToLock' }, mode: 'lock' };
    } else {
      status = { key: 'status.nothingToDo' };
    }
  }

  const showsUnlockField = mode === 'unlock' && locked > 0;
  return {
    mode,
    phase,
    total,
    analysing,
    actionable,
    relock: mode === 'lock' ? relock : 0,
    needPassword,
    restricted: mode === 'unlock' ? restricted : 0,
    notEncrypted: mode === 'unlock' ? notEncrypted : 0,
    processing,
    done,
    failed,
    rejected,
    passwordField: showsUnlockField,
    passwordHint: showsUnlockField && locked > 1 ? { key: 'unlock.password.sharedHint' } : null,
    passwordError:
      showsUnlockField && context.unlockRejected ? { key: 'unlock.password.wrong' } : null,
    primary,
    status,
    problems: failed > 0 ? { key: 'status.failed', params: { count: failed } } : null,
    suggestion,
    results: { count: done, unsaved, totalSize },
    canSaveAll: done > 0,
    canSaveToFolder: done > 1 && context.capabilities.canPickDirectory,
    canShareAll: done > 0 && context.capabilities.canShareFiles,
    canCancelAll: processing > 0,
    canClear: total > 0,
  };
}

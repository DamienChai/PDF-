/**
 * From the engine's and the libraries' vocabulary (error codes, algorithms, permissions, strength
 * hints) to messages. The template-literal keys make the compiler prove that every code has its
 * strings.
 */
import type {
  AlgorithmId,
  EncryptOptions,
  EncryptionInfo,
  EngineErrorCode,
  Permissions,
} from '../engine/types';
import type { StrengthHint, StrengthScore } from '../lib/password-strength';
import type { Message, MessageKey, MessageList } from './translate';

export type ErrorCode = EngineErrorCode | 'unknown';

export interface ErrorText {
  /** Short headline, e.g. "File is damaged". */
  title: Message;
  /** One sentence on what the user can do about it. */
  advice: Message;
}

export function errorText(code: ErrorCode): ErrorText {
  const title: MessageKey = `error.${code}.title`;
  const advice: MessageKey = `error.${code}.advice`;
  return { title: { key: title }, advice: { key: advice } };
}

export function strengthLabel(score: StrengthScore): Message {
  const key: MessageKey = `strength.${score}`;
  return { key };
}

export function strengthHintText(hint: StrengthHint): Message {
  const key: MessageKey = `strength.hint.${hint}`;
  return { key };
}

type AlgorithmSource = Pick<EncryptionInfo, 'algorithm' | 'keyBits'>;

/** RC4 is broken; files using it are marked so the user can re-encrypt them. */
export function isOutdatedAlgorithm(algorithm: AlgorithmId): boolean {
  return algorithm === 'rc4';
}

/** Full name for details, e.g. "RC4 40-bit (outdated)". */
export function algorithmLabel(encryption: AlgorithmSource): Message {
  if (encryption.algorithm === 'rc4') {
    return { key: 'algorithm.rc4', params: { bits: encryption.keyBits } };
  }
  const key: MessageKey = `algorithm.${encryption.algorithm}`;
  return { key };
}

/** Compact name for a chip, e.g. "AES-256", "RC4-128". */
export function algorithmChipLabel(encryption: AlgorithmSource): Message {
  switch (encryption.algorithm) {
    case 'rc4':
      return { key: 'algorithm.chip.rc4', params: { bits: encryption.keyBits } };
    case 'aes-128':
      return { key: 'algorithm.chip.aes-128' };
    case 'aes-256':
    case 'aes-256-r5':
      return { key: 'algorithm.chip.aes-256' };
    case 'unknown':
      return { key: 'algorithm.chip.unknown' };
  }
}

/** Label of an algorithm choice in the lock form, e.g. "AES-256 (recommended)". */
export function lockAlgorithmLabel(algorithm: EncryptOptions['algorithm']): Message {
  const key: MessageKey = `lock.algorithm.${algorithm}`;
  return { key };
}

export function lockAlgorithmDescription(algorithm: EncryptOptions['algorithm']): Message {
  const key: MessageKey = `lock.algorithm.${algorithm}.description`;
  return { key };
}

export type PermissionId = keyof Permissions;

/** Order in which permissions are listed everywhere. */
export const PERMISSION_ORDER: readonly PermissionId[] = [
  'print',
  'extract',
  'modify',
  'annotate',
  'fillForms',
  'assemble',
  'accessibility',
];

export function permissionLabel(id: PermissionId): Message {
  const key: MessageKey = `permission.${id}`;
  return { key };
}

/**
 * What a reader may not do, as short phrases for one line on a file card
 * ("No printing, No copying"). Empty when nothing is restricted.
 */
export function restrictionList(permissions: Permissions): MessageList {
  const list: Message[] = [];
  if (permissions.print === 'none') list.push({ key: 'restriction.print' });
  if (permissions.print === 'low') list.push({ key: 'restriction.printLow' });
  if (!permissions.extract) list.push({ key: 'restriction.extract' });
  if (!permissions.modify) list.push({ key: 'restriction.modify' });
  if (!permissions.annotate) list.push({ key: 'restriction.annotate' });
  if (!permissions.fillForms) list.push({ key: 'restriction.fillForms' });
  if (!permissions.assemble) list.push({ key: 'restriction.assemble' });
  return { list };
}

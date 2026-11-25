/** Offline password strength estimate. CONTRACT STUB — implemented by the platform workstream. */

export type StrengthScore = 0 | 1 | 2 | 3 | 4;

/** Machine-readable hints; the UI localises them. */
export type StrengthHint =
  | 'too-short'
  | 'common-password'
  | 'repeated-characters'
  | 'sequence'
  | 'single-character-class'
  | 'looks-like-date';

export interface StrengthEstimate {
  /** 0 = very weak … 4 = very strong. An empty password scores 0. */
  score: StrengthScore;
  /** Estimated entropy in bits (after pattern penalties). */
  bits: number;
  hints: StrengthHint[];
}

export function estimateStrength(_password: string): StrengthEstimate {
  throw new Error('not implemented');
}

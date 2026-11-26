/**
 * The two drawings of a document: the small glyph on file cards, whose mark tells the state by
 * shape as well as colour, and the larger illustration of the empty state and of a single file.
 */
import type { EntryState, Tone } from '../state';
import { Icon, type IconName } from './icons';

export type ArtTone = Tone | 'accent';

const STATE_MARK: Readonly<Record<EntryState, IconName>> = {
  analysing: 'spinner',
  'needs-password': 'lock',
  restricted: 'restricted',
  'not-encrypted': 'lines',
  ready: 'lines',
  encrypted: 'lock',
  'wrong-password': 'bang',
  processing: 'spinner',
  done: 'check',
  error: 'bang',
};

/** Which mark stands for a state; shared by the glyph, the illustration and the status chip. */
export function stateIcon(state: EntryState, queued = false): IconName {
  if (state === 'processing' && queued) return 'clock';
  return STATE_MARK[state];
}

export function isSpinning(state: EntryState, queued = false): boolean {
  return state === 'analysing' || (state === 'processing' && !queued);
}

/** The sheet-of-paper glyph of a file card. */
export function DocGlyph({
  state,
  tone,
  queued,
}: {
  state: EntryState;
  tone: Tone;
  queued: boolean;
}) {
  return (
    <span class={`doc doc--${tone}`} aria-hidden="true">
      <svg class="doc__page" viewBox="0 0 36 44" focusable="false">
        <path d="M8 .75h14.5l9.75 9.75V39A4.25 4.25 0 0 1 28 43.25H8A4.25 4.25 0 0 1 3.75 39V5A4.25 4.25 0 0 1 8 .75Z" />
        <path d="M22.5.75V7.5a3 3 0 0 0 3 3h6.75" fill="none" />
      </svg>
      <span class="doc__mark">
        <Icon name={stateIcon(state, queued)} size="sm" spin={isSpinning(state, queued)} />
      </span>
    </span>
  );
}

export type IllustrationKind =
  /** Empty state, unlock: a document, a keyhole badge and a password pill. */
  | 'unlock'
  /** Empty state, lock: the same document with a closed lock. */
  | 'lock'
  | EntryState;

interface Look {
  tone: ArtTone;
  icon: IconName | 'keyhole';
  pill: boolean;
  spin?: boolean;
}

const LOOKS: Readonly<Record<IllustrationKind, Look>> = {
  unlock: { tone: 'accent', icon: 'keyhole', pill: true },
  lock: { tone: 'accent', icon: 'lock', pill: true },
  analysing: { tone: 'neutral', icon: 'spinner', pill: false, spin: true },
  'needs-password': { tone: 'accent', icon: 'lock', pill: true },
  restricted: { tone: 'warning', icon: 'restricted', pill: false },
  'not-encrypted': { tone: 'neutral', icon: 'lines', pill: false },
  ready: { tone: 'neutral', icon: 'lines', pill: false },
  encrypted: { tone: 'accent', icon: 'lock', pill: false },
  'wrong-password': { tone: 'danger', icon: 'bang', pill: true },
  processing: { tone: 'accent', icon: 'spinner', pill: false, spin: true },
  done: { tone: 'success', icon: 'check', pill: false },
  error: { tone: 'danger', icon: 'bang', pill: false },
};

/**
 * A document with a round badge for its state and, where a password is the next step, a
 * password pill. Colours come from CSS (`.art--<tone>`), so it follows the theme.
 */
export function Illustration({ kind, class: extra }: { kind: IllustrationKind; class?: string }) {
  const look = LOOKS[kind];
  return (
    <svg
      class={`art art--${look.tone}${extra ? ` ${extra}` : ''}`}
      viewBox="0 0 160 140"
      aria-hidden="true"
      focusable="false"
    >
      <path
        class="art__page"
        d="M54 8h38l26 26v70a10 10 0 0 1-10 10H54a10 10 0 0 1-10-10V18A10 10 0 0 1 54 8Z"
      />
      <path class="art__fold" d="M92 8v16a10 10 0 0 0 10 10h16Z" />
      <g class="art__lines">
        <rect x="56" y="46" width="34" height="6" rx="3" />
        <rect x="56" y="60" width="48" height="6" rx="3" />
        <rect x="56" y="74" width="26" height="6" rx="3" />
      </g>
      {look.pill && (
        <g class="art__pill">
          <rect x="16" y="88" width="84" height="32" rx="16" />
          <circle cx="36" cy="104" r="4" />
          <circle cx="51" cy="104" r="4" />
          <circle cx="66" cy="104" r="4" />
          <circle cx="81" cy="104" r="4" />
        </g>
      )}
      <g class="art__badge" key={kind}>
        <circle cx="118" cy="104" r="24" />
        {look.icon === 'keyhole' ? (
          <path
            class="art__keyhole"
            d="M118 92a7.5 7.5 0 0 1 4.2 13.7l1.9 7.2a1.8 1.8 0 0 1-1.74 2.26h-8.72a1.8 1.8 0 0 1-1.74-2.26l1.9-7.2A7.5 7.5 0 0 1 118 92Z"
          />
        ) : (
          <g class={`art__icon${look.spin ? ' art__icon--spin' : ''}`}>
            <svg x="105" y="91" width="26" height="26" viewBox="0 0 24 24">
              <BadgeIcon name={look.icon} />
            </svg>
          </g>
        )}
      </g>
    </svg>
  );
}

/** The few icons the badge can show, as bare paths (an <svg> cannot nest the Icon component's). */
function BadgeIcon({ name }: { name: IconName }) {
  switch (name) {
    case 'lock':
      return (
        <>
          <rect x="5" y="10.5" width="14" height="10" rx="2.5" />
          <path d="M8.25 10.5V7.75a3.75 3.75 0 0 1 7.5 0v2.75" />
        </>
      );
    case 'restricted':
      return (
        <>
          <path d="M12 3.2 5 5.8v5.4c0 4.4 2.9 8.2 7 9.6 4.1-1.4 7-5.2 7-9.6V5.8l-7-2.6Z" />
          <path d="M9 12h6" />
        </>
      );
    case 'check':
      return <path d="m5 12.5 4.5 4.5L19 7" />;
    case 'bang':
      return (
        <>
          <path d="M12 4.5v9.5" />
          <circle cx="12" cy="18.8" r="1.4" fill="currentColor" stroke="none" />
        </>
      );
    case 'spinner':
      return (
        <>
          <circle cx="12" cy="12" r="8.5" opacity=".3" />
          <path d="M20.5 12A8.5 8.5 0 0 0 12 3.5" />
        </>
      );
    default:
      return <path d="M5 6.5h14M5 12h14M5 17.5h8" />;
  }
}

/** Status and algorithm chips of a file, and the progress bar. */
import type { ComponentChildren } from 'preact';
import { formatPercent, t } from '../i18n';
import type { Entry, EntryView } from '../state';
import { isSpinning, stateIcon } from './artwork';
import { Icon } from './icons';

/** The state of a file in a word, with an icon so that it is seen before it is read. */
export function StatusChip({ view, children }: { view: EntryView; children?: ComponentChildren }) {
  // "Not encrypted" is nothing to act on: outline only, so that it recedes.
  const quiet = view.state === 'not-encrypted' || view.state === 'ready';
  const tone = quiet ? 'outline' : view.chip.tone;
  return (
    <span class={`chip chip--${tone} chip--status`}>
      <Icon
        name={stateIcon(view.state, view.queued)}
        size="xs"
        spin={isSpinning(view.state, view.queued)}
      />
      {t(view.chip.label)}
      {children}
    </span>
  );
}

/**
 * The percentage of a running file. Its own component: progress changes many times a second and
 * must not re-render the card around it.
 */
export function ProgressPercent({ entry }: { entry: Entry }) {
  return <span class="num"> {formatPercent(entry.progress.value)}</span>;
}

/** The progress bar of a running file. */
export function EntryProgress({ entry, class: extra }: { entry: Entry; class?: string }) {
  return (
    <div class={extra}>
      <Progress value={entry.progress.value} label={`${t('aria.progress')}: ${entry.name}`} />
    </div>
  );
}

export function AlgorithmChip({ view }: { view: EntryView }) {
  if (!view.algorithm) return null;
  return (
    <span
      class={`chip chip--fact${view.algorithm.outdated ? ' chip--warning' : ''}`}
      title={view.algorithm.outdated ? t('algorithm.outdated') : undefined}
    >
      {t(view.algorithm.label)}
      {view.algorithm.outdated && <span class="sr-only"> ({t('algorithm.outdated')})</span>}
    </span>
  );
}

export function Progress({ value, label }: { value: number; label?: string }) {
  const clamped = Math.min(1, Math.max(0, value));
  return (
    <div
      class="progress"
      role="progressbar"
      aria-label={label ?? t('aria.progress')}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.floor(clamped * 100)}
    >
      <div class="progress__fill" style={{ '--value': clamped }} />
    </div>
  );
}

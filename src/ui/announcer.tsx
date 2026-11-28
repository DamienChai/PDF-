/**
 * One polite live region for everything a sighted user sees change without acting on it:
 * a file turning out to need attention, a batch finishing, a toast. Progress percentages are
 * not announced; the progress bars carry them for whoever asks.
 */
import { effect, signal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import { locale, translate, type Text } from '../i18n';
import { jobs, toasts, type EntryState } from '../state';

const message = signal('');
let clearTimer: ReturnType<typeof setTimeout> | undefined;

function say(text: string): void {
  if (text === '') return;
  // The same sentence twice in a row has to change the node to be spoken again.
  message.value = message.peek() === text ? `${text} ` : text;
  clearTimeout(clearTimer);
  clearTimer = setTimeout(() => {
    message.value = '';
  }, 6000);
}

function plain(text: Text): string {
  const target = locale.peek();
  return 'list' in text
    ? text.list.map((item) => translate(target, item.key, item.params)).join(', ')
    : translate(target, text.key, text.params);
}

/** States worth interrupting for; the rest is visible on request. */
const NOTABLE: ReadonlySet<EntryState> = new Set<EntryState>(['wrong-password', 'error']);

function watch(): () => void {
  const states = new Map<string, EntryState>();
  let phase = jobs.summary.peek().phase;
  const spoken = new Set<number>();

  const stopEntries = effect(() => {
    const seen = new Set<string>();
    for (const entry of jobs.entries.value) {
      seen.add(entry.id);
      const view = entry.view.value;
      const before = states.get(entry.id);
      states.set(entry.id, view.state);
      if (before !== undefined && before !== view.state && NOTABLE.has(view.state)) {
        say(`${view.name}: ${plain(view.error?.title ?? view.chip.label)}`);
      }
    }
    for (const id of states.keys()) if (!seen.has(id)) states.delete(id);
  });

  const stopSummary = effect(() => {
    const summary = jobs.summary.value;
    if (summary.phase === phase) return;
    phase = summary.phase;
    if ((phase === 'processing' || phase === 'finished' || phase === 'idle') && summary.status) {
      const parts = [plain(summary.status)];
      if (phase === 'finished' && summary.problems) parts.push(plain(summary.problems));
      say(parts.join('. '));
    }
  });

  const stopToasts = effect(() => {
    for (const toast of toasts.toasts.value) {
      if (spoken.has(toast.id)) continue;
      spoken.add(toast.id);
      say(plain(toast.message));
    }
  });

  return () => {
    stopEntries();
    stopSummary();
    stopToasts();
  };
}

export function Announcer() {
  useEffect(watch, []);
  return (
    <div class="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {message.value}
    </div>
  );
}

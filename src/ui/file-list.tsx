/** The workspace when there are files: a header with count and "add", then the files. */
import { formatFiles, formatSize, t, type Message } from '../i18n';
import { jobs, mode, pickFiles, type Entry, type Summary } from '../state';
import { FileCard } from './file-card';
import { inlinePasswordField } from './file-parts';
import { Icon } from './icons';
import { Spotlight } from './spotlight';
import { isApplePlatform, isDesktop } from './viewport';

interface Segment {
  text: Message;
  /** Files that need the user: the segment is a button that goes to the first of them. */
  jump?: (entry: Entry) => boolean;
  tone?: 'danger' | 'accent';
}

/** The state of the batch in words: "2 need a password · 1 has restrictions only". */
function segments(summary: Summary): Segment[] {
  const list: Segment[] = [];
  const count = (key: Message['key'], value: number): Message => ({
    key,
    params: { count: value },
  });
  if (summary.rejected > 0) {
    list.push({
      text: count('list.summary.rejected', summary.rejected),
      jump: (entry) => entry.view.peek().state === 'wrong-password',
      tone: 'danger',
    });
  }
  if (summary.failed > 0) {
    list.push({
      text: count('list.summary.failed', summary.failed),
      jump: (entry) => entry.view.peek().state === 'error',
      tone: 'danger',
    });
  }
  const waiting = summary.needPassword - summary.rejected;
  if (waiting > 0) {
    if (summary.mode === 'unlock') {
      list.push({ text: count('list.summary.needPassword', waiting) });
    } else {
      list.push({
        text: count('list.summary.needCurrent', waiting),
        jump: (entry) =>
          entry.view.peek().password?.kind === 'current' && entry.currentPassword.peek() === '',
        tone: 'accent',
      });
    }
  }
  if (summary.restricted > 0)
    list.push({ text: count('list.summary.restricted', summary.restricted) });
  if (summary.notEncrypted > 0) {
    list.push({ text: count('list.summary.notEncrypted', summary.notEncrypted) });
  }
  if (summary.done > 0) list.push({ text: count('list.summary.done', summary.done) });
  if (summary.relock > 0) list.push({ text: count('list.summary.relock', summary.relock) });
  return list;
}

function goTo(matches: (entry: Entry) => boolean): void {
  const entry = jobs.entries.peek().find(matches);
  if (!entry) return;
  const card = document.querySelector<HTMLElement>(`[data-entry="${entry.id}"]`);
  if (!card) return;
  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
  card.scrollIntoView({ block: 'center', behavior: calm ? 'auto' : 'smooth' });
  (inlinePasswordField(entry.id) ?? card).focus({ preventScroll: true });
}

function ListHeader({ summary }: { summary: Summary }) {
  const entries = jobs.entries.value;
  const totalSize = entries.reduce((sum, entry) => sum + entry.size, 0);
  const parts = entries.length > 1 ? segments(summary) : [];
  return (
    <header class="listhead">
      <h2 class="listhead__title num">
        {formatFiles(summary.total)}
        <span class="listhead__size"> · {formatSize(totalSize)}</span>
      </h2>
      <div class="listhead__actions">
        <button type="button" class="btn btn--secondary btn--sm btn--header" onClick={pickFiles}>
          <Icon name="plus" size="sm" />
          {t('list.addMore')}
        </button>
        {/* Once everything is finished the action area offers "process new files" instead. */}
        {summary.canClear && summary.phase !== 'finished' && (
          <button
            type="button"
            class="btn btn--ghost btn--sm btn--header"
            onClick={() => jobs.clear()}
          >
            {t('action.clear')}
          </button>
        )}
      </div>
      {parts.length > 0 && (
        <p class="listhead__summary">
          {/* Each count with the dot that follows it is one unbreakable piece: where the line is
              too short it ends after a count, never inside one. */}
          {parts.flatMap((part, index) => [
            <span class="listhead__part" key={part.text.key}>
              {part.jump ? (
                <button
                  type="button"
                  class={`jump jump--${part.tone ?? 'accent'}`}
                  aria-label={t('aria.jumpTo', { label: t(part.text) })}
                  onClick={() => goTo(part.jump!)}
                >
                  {t(part.text)}
                </button>
              ) : (
                t(part.text)
              )}
              {index < parts.length - 1 && <span aria-hidden="true"> ·</span>}
            </span>,
            ' ',
          ])}
        </p>
      )}
    </header>
  );
}

/** Desktop: the room under a short list is a place to drop (or choose) more files. */
function DropMore() {
  return (
    <button type="button" class="dropmore" onClick={pickFiles}>
      <Icon name="file-plus" />
      <span class="dropmore__title">{t('list.dropMore')}</span>
      <span class="dropmore__hint">
        {t('list.dropMore.hint')}
        <kbd class="kbd">{isApplePlatform ? '⌘' : 'Ctrl'}</kbd>
        <kbd class="kbd">V</kbd>
      </span>
    </button>
  );
}

export function FileList() {
  const entries = jobs.entries.value;
  const summary = jobs.summary.value;
  // One file on the phone, unlocking: the file fills the stage instead of sitting in a list.
  const single = entries.length === 1 && mode.value === 'unlock' && !isDesktop.value;
  const only = entries[0];
  return (
    <section class={`workspace${single ? ' workspace--single' : ''}`} aria-label={t('list.label')}>
      <ListHeader summary={summary} />
      {single && only ? (
        <Spotlight entry={only} />
      ) : (
        // The box is the query container: a wide one lays the cards out as table rows.
        <div class="listbox">
          <ul class="list">
            {entries.map((entry) => (
              <FileCard key={entry.id} entry={entry} ownActions={entries.length > 1} />
            ))}
          </ul>
        </div>
      )}
      <DropMore />
    </section>
  );
}

/**
 * The pieces of a file's presentation that the list card and the single-file spotlight share:
 * the line of facts, the inline password fields, result actions and the error block.
 */
import { useId, useRef, useState } from 'preact/hooks';
import { formatPages, formatSize, phrasesOf, t, type Message, type Text } from '../i18n';
import { jobs, type Entry, type EntryView, type PasswordFieldView } from '../state';
import { FileName } from './file-name';
import { afterRender, focusQuietly } from './focus';
import { Icon } from './icons';
import { PasswordInput } from './password-input';

/** "2.4 MB · 12 pages", as far as it is known. */
export function metaText(view: EntryView): string {
  const parts = [formatSize(view.size)];
  if (view.pageCount !== null) parts.push(formatPages(view.pageCount));
  return parts.join(' · ');
}

/**
 * A note about a file. A list of restrictions is set phrase by phrase: a line may end after
 * "不可修改、" or "no editing," but never in the middle of one.
 */
export function NoteText({ text }: { text: Text }) {
  if (!('list' in text)) return <>{t(text)}</>;
  const { phrases, gap } = phrasesOf(text);
  return (
    <>
      {phrases.flatMap((phrase, index) => {
        const node = (
          <span class="phrase" key={index}>
            {phrase}
          </span>
        );
        return index > 0 && gap ? [gap, node] : [node];
      })}
    </>
  );
}

/** Size, pages and the quiet note of the state on one line. */
export function InfoLine({ view }: { view: EntryView }) {
  return (
    <p class="info">
      <span class="info__meta num">{metaText(view)}</span>
      {view.note && (
        <span class="info__note">
          <NoteText text={view.note} />
        </span>
      )}
      {view.warning && <span class="info__note">{t(view.warning)}</span>}
    </p>
  );
}

/** One sentence on what the finished file now is. */
export function doneMessage(entry: Entry): Message {
  if (entry.view.value.mode === 'lock') return { key: 'dock.done.lock' };
  const restrictionsOnly =
    entry.details.value.protection?.key === 'details.protection.restrictions';
  return { key: restrictionsOnly ? 'dock.done.restrictions' : 'dock.done.unlock' };
}

/** "↳ name_unlocked.pdf · 2.4 MB": what came out, in place of the facts about what went in. */
export function OutputLine({ view }: { view: EntryView }) {
  const { result } = view;
  if (!result) return null;
  return (
    <p class="output">
      <Icon name="output" size="sm" />
      <FileName name={result.name} class="output__name" />
      <span class="output__meta num">
        {formatSize(result.size)}
        {result.saved && (
          <span class="output__saved">
            <Icon name="check" size="xs" />
            {t('entry.saved')}
          </span>
        )}
      </span>
    </p>
  );
}

/** Finds the inline password field of a card, for moving the focus to it. */
export function inlinePasswordField(entryId: string): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>(
    `[data-entry="${entryId}"] [data-inline-password]`,
  );
}

/**
 * Unlock mode, several files: the shared password did not open this one. Its own field with a
 * labelled button, tried against this file only. While its password is being tried the field
 * stays (read-only), so that the focus and the keyboard do too.
 */
export function RetryForm({
  entry,
  field,
  busy,
}: {
  entry: Entry;
  field: PasswordFieldView;
  busy: boolean;
}) {
  const [value, setValue] = useState('');
  const [revealed, setRevealed] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const id = useId();

  function submit(): void {
    if (busy) return;
    if (value === '') {
      focusQuietly(input.current);
      return;
    }
    void jobs.retryUnlock(entry.id, value).then((report) => {
      // Still wrong: ready to be typed over.
      if (report.rejected > 0) afterRender(() => focusQuietly(input.current, true));
    });
  }

  return (
    <div class="inline-form">
      <label class="sr-only" for={id}>
        {t(field.label)}: {entry.name}
      </label>
      <div class="inline-form__row">
        <PasswordInput
          id={id}
          inputRef={input}
          value={value}
          onInput={setValue}
          revealed={revealed}
          onReveal={setRevealed}
          placeholder={t(field.placeholder)}
          autocomplete="off"
          enterkeyhint="go"
          onEnter={submit}
          readOnly={busy}
          invalid={!busy && field.error !== null}
          describedBy={`${id}-help`}
          inline
        />
        <button type="button" class="btn btn--secondary" disabled={busy} onClick={submit}>
          {field.submitLabel ? t(field.submitLabel) : t('entry.password.submit')}
        </button>
      </div>
      <p class="hint" id={`${id}-help`}>
        {t('error.password-incorrect.advice')}
      </p>
    </div>
  );
}

/** Lock mode: the file is already protected; replacing its protection needs the current password. */
export function CurrentPasswordField({ entry, view }: { entry: Entry; view: EntryView }) {
  const [revealed, setRevealed] = useState(false);
  const id = useId();
  const field = view.password;
  if (!field) return null;
  const message = field.error ?? field.hint;
  return (
    <div class="inline-form">
      <label class="sr-only" for={id}>
        {t(field.label)}: {view.name}
      </label>
      <div class="inline-form__row">
        <PasswordInput
          id={id}
          value={entry.currentPassword.value}
          onInput={(value) => jobs.setCurrentPassword(entry.id, value)}
          revealed={revealed}
          onReveal={setRevealed}
          placeholder={t(field.placeholder)}
          autocomplete="off"
          enterkeyhint="done"
          invalid={field.error !== null}
          describedBy={message ? `${id}-help` : undefined}
          inline
        />
      </div>
      {message && (
        <p
          class={`hint${field.error ? ' hint--danger' : ''}`}
          id={`${id}-help`}
          role={field.error ? 'alert' : undefined}
        >
          {t(message)}
        </p>
      )}
    </div>
  );
}

/** Save, share, open for one finished file. All of them need the click's user activation. */
export function ResultActions({ view }: { view: EntryView }) {
  const { result } = view;
  if (!result) return null;
  return (
    <div class="actions">
      <button
        type="button"
        class={`btn btn--sm ${result.saved ? 'btn--secondary' : 'btn--tonal'}`}
        onClick={() => void jobs.save(view.id)}
      >
        <Icon name="install" size="sm" />
        {t('entry.save')}
      </button>
      {result.canShare && (
        <button
          type="button"
          class="btn btn--secondary btn--sm"
          onClick={() => void jobs.share(view.id)}
        >
          <Icon name="share" size="sm" />
          {t('entry.share')}
        </button>
      )}
      <button type="button" class="btn btn--secondary btn--sm" onClick={() => jobs.open(view.id)}>
        <Icon name="open" size="sm" />
        {t('entry.open')}
      </button>
    </div>
  );
}

/** What went wrong and what to do about it, with the low-level text behind a disclosure. */
export function ErrorBlock({ view }: { view: EntryView }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const { error } = view;
  if (!error) return null;
  return (
    <div class="problem">
      <p class="problem__text">
        <strong class="problem__title">{t(error.title)}</strong>
        <span class="problem__advice">{t(error.advice)}</span>
      </p>
      <div class="problem__actions">
        {view.canRetry && (
          <button
            type="button"
            class="btn btn--secondary btn--sm"
            onClick={() => jobs.retry(view.id)}
          >
            <Icon name="redo" size="sm" />
            {t('entry.retry')}
          </button>
        )}
        {error.detail && (
          <button
            type="button"
            class="disclosure-toggle"
            aria-expanded={open}
            aria-controls={id}
            onClick={() => setOpen(!open)}
          >
            {t('entry.error.details')}
            <Icon name="chevron-down" size="sm" />
          </button>
        )}
      </div>
      {error.detail && open && (
        <pre class="problem__detail" id={id}>
          {error.detail}
        </pre>
      )}
    </div>
  );
}

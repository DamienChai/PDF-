/**
 * One file in the list. Narrow lists show it as a card (name, chips, facts, then whatever the
 * state needs, growing downwards); wide lists show the same markup as a table row with aligned
 * columns. The switch is a container query in files.css.
 */
import { useRef } from 'preact/hooks';
import { t } from '../i18n';
import { jobs, openMenu, overlay, type Entry, type PasswordFieldView } from '../state';
import { DocGlyph } from './artwork';
import { AlgorithmChip, EntryProgress, ProgressPercent, StatusChip } from './chips';
import { FileName } from './file-name';
import {
  CurrentPasswordField,
  ErrorBlock,
  InfoLine,
  OutputLine,
  ResultActions,
  RetryForm,
} from './file-parts';
import { Icon } from './icons';

export interface FileCardProps {
  entry: Entry;
  /** Results get their own save/share/open buttons; with a single file the action area has them. */
  ownActions: boolean;
}

export function FileCard({ entry, ownActions }: FileCardProps) {
  const view = entry.view.value;
  const { state } = view;
  const menuOpen = overlay.value?.kind === 'menu' && overlay.value.entryId === view.id;
  const running = state === 'processing' && !view.queued;

  // The retry field of a card outlives the attempt it started: see RetryForm.
  const lastRetry = useRef<PasswordFieldView | null>(null);
  if (view.password?.kind === 'retry') lastRetry.current = view.password;
  else if (state !== 'processing') lastRetry.current = null;
  const retry = view.password?.kind === 'retry' ? view.password : lastRetry.current;

  let detail = null;
  if (retry) detail = <RetryForm entry={entry} field={retry} busy={state === 'processing'} />;
  else if (view.password?.kind === 'current') {
    detail = <CurrentPasswordField entry={entry} view={view} />;
  } else if (state === 'done' && ownActions) detail = <ResultActions view={view} />;
  else if (state === 'error') detail = <ErrorBlock view={view} />;

  return (
    <li class={`card card--${state}`} data-entry={view.id} data-state={state} tabIndex={-1}>
      <DocGlyph state={state} tone={view.chip.tone} queued={view.queued} />
      <h3 class="card__name">
        <FileName name={view.name} />
      </h3>
      <div class="card__chips">
        <StatusChip view={view}>{running && <ProgressPercent entry={entry} />}</StatusChip>
        <AlgorithmChip view={view} />
      </div>
      <div class="card__info">
        {state === 'done' ? <OutputLine view={view} /> : <InfoLine view={view} />}
      </div>
      {detail && <div class="card__detail">{detail}</div>}
      <div class="card__end">
        {view.canCancel ? (
          <button
            type="button"
            class="icon-btn"
            aria-label={`${t('entry.cancel')}: ${view.name}`}
            onClick={() => jobs.cancel(view.id)}
          >
            <Icon name="x" />
          </button>
        ) : (
          <button
            type="button"
            class="icon-btn"
            aria-label={t('aria.fileMenu', { name: view.name })}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            data-menu-anchor={view.id}
            onClick={() => openMenu(view.id)}
          >
            <Icon name="more" />
          </button>
        )}
      </div>
      {state === 'processing' && <EntryProgress entry={entry} class="card__progress" />}
    </li>
  );
}

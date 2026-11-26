/**
 * Phone, unlock mode, exactly one file: instead of a small row at the top of an empty screen,
 * the file fills the stage above the action area, so that file, password and button read as one
 * group. Its actions (save, share, open) and its progress bar live in the action area below it.
 */
import { t } from '../i18n';
import { jobs, openMenu, overlay, type Entry } from '../state';
import { Illustration } from './artwork';
import { AlgorithmChip, ProgressPercent, StatusChip } from './chips';
import { ErrorBlock, OutputLine, doneMessage, metaText } from './file-parts';
import { Icon } from './icons';

export function Spotlight({ entry }: { entry: Entry }) {
  const view = entry.view.value;
  const { state } = view;
  const menuOpen = overlay.value?.kind === 'menu' && overlay.value.entryId === view.id;
  const running = state === 'processing' && !view.queued;

  return (
    <article
      class={`spotlight spotlight--${state}`}
      data-entry={view.id}
      data-state={state}
      tabIndex={-1}
    >
      <div class="spotlight__end">
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
      <div class="spotlight__art">
        <Illustration kind={state} />
      </div>
      <div class="spotlight__text">
        <h3 class="spotlight__name">{view.name}</h3>
        <p class="spotlight__meta num">{metaText(view)}</p>
        <div class="spotlight__chips">
          <StatusChip view={view}>{running && <ProgressPercent entry={entry} />}</StatusChip>
          <AlgorithmChip view={view} />
        </div>
        {view.note && state !== 'error' && <p class="spotlight__note">{t(view.note)}</p>}
        {view.warning && <p class="spotlight__note">{t(view.warning)}</p>}
        {state === 'done' && (
          <>
            <p class="spotlight__note">{t(doneMessage(entry))}</p>
            <OutputLine view={view} />
          </>
        )}
        {state === 'error' && <ErrorBlock view={view} />}
      </div>
    </article>
  );
}

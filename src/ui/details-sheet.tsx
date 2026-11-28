/** How one file is protected: a sentence, the key facts, the permissions, and what was done. */
import type { ComponentChildren } from 'preact';
import { formatDuration, formatNumber, formatSize, t, type Message } from '../i18n';
import { closeOverlay, detailsEntry, type DetailsView, type PermissionRow } from '../state';
import { Icon, type IconName } from './icons';
import { Prose } from './prose';
import { Sheet, useLast } from './sheet';

const STATUS_ICON: Readonly<Record<PermissionRow['status'], IconName>> = {
  allowed: 'check',
  limited: 'partial',
  denied: 'x',
};

function summaryText(details: DetailsView): Message {
  switch (details.protection?.key) {
    case 'details.protection.none':
      return { key: 'details.summary.none' };
    case 'details.protection.password':
      return { key: 'details.summary.password' };
    case 'details.protection.restrictions':
      return { key: 'details.summary.restrictions' };
    default:
      return { key: 'details.summary.unavailable' };
  }
}

function summaryLook(details: DetailsView): { tone: string; icon: IconName } {
  switch (details.protection?.key) {
    case 'details.protection.password':
      return { tone: 'info', icon: 'lock' };
    case 'details.protection.restrictions':
      return { tone: 'warning', icon: 'restricted' };
    case 'details.protection.none':
      return { tone: 'neutral', icon: 'lines' };
    default:
      return { tone: 'neutral', icon: 'info' };
  }
}

function Tile({ label, children }: { label: string; children: ComponentChildren }) {
  return (
    <div class="tile">
      <dt class="tile__label">{label}</dt>
      <dd class="tile__value num">{children}</dd>
    </div>
  );
}

function Content({ details }: { details: DetailsView }) {
  const look = summaryLook(details);
  const { result, error } = details;
  const quiet = <span class="tile__quiet">{t('details.unknown')}</span>;
  return (
    <>
      <div class={`banner banner--${look.tone}`}>
        <span class="banner__icon">
          <Icon name={look.icon} />
        </span>
        <div class="banner__text">
          {details.protection && <p class="banner__title">{t(details.protection)}</p>}
          <p class="banner__body">
            <Prose text={t(summaryText(details))} />
          </p>
        </div>
      </div>

      {error && (
        <div class="notice notice--boxed notice--danger" role="group" aria-label={t(error.title)}>
          <Icon name="alert" size="sm" />
          <div>
            <p>
              <strong>{t(error.title)}</strong> <Prose text={t(error.advice)} />
            </p>
            {error.detail && <pre class="problem__detail">{error.detail}</pre>}
          </div>
        </div>
      )}

      <dl class="tiles tiles--facts">
        {/* A file that is not encrypted has neither: the summary above says so. */}
        {details.algorithm && (
          <Tile label={t('details.algorithm')}>
            <Prose text={t(details.algorithm)} />
          </Tile>
        )}
        {details.keyLength && <Tile label={t('details.keyLength')}>{t(details.keyLength)}</Tile>}
        {details.available && (
          <>
            <Tile label={t('details.pdfVersion')}>{details.pdfVersion ?? '–'}</Tile>
            <Tile label={t('details.pages')}>
              {details.pageCount !== null ? formatNumber(details.pageCount) : quiet}
            </Tile>
          </>
        )}
        <Tile label={t('details.size')}>{formatSize(details.size)}</Tile>
        {details.metadataEncrypted !== null && (
          <Tile label={t('details.metadata')}>
            {t(details.metadataEncrypted ? 'details.metadata.encrypted' : 'details.metadata.clear')}
          </Tile>
        )}
        {details.linearized !== null && (
          <Tile label={t('details.fastWebView')}>
            {t(details.linearized ? 'details.yes' : 'details.no')}
          </Tile>
        )}
      </dl>

      {details.outdatedNote && (
        <p class="notice notice--boxed notice--warning">
          <Icon name="warning" size="sm" />
          <span>
            <Prose text={t(details.outdatedNote)} />
          </span>
        </p>
      )}

      {details.permissions.length > 0 && (
        <section class="sheet__section" aria-labelledby="details-permissions">
          <h3 class="section-title" id="details-permissions">
            {t('details.permissions')}
          </h3>
          {details.permissionsNote && (
            <p class="hint">
              <Prose text={t(details.permissionsNote)} />
            </p>
          )}
          <ul class="rows">
            {details.permissions.map((row) => (
              <li class="row" key={row.id}>
                <span class="row__title">{t(row.label)}</span>
                <span class={`mark mark--${row.status}`}>
                  <Icon name={STATUS_ICON[row.status]} size="sm" />
                  {t(row.statusLabel)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {details.warnings.length > 0 && (
        <section class="sheet__section" aria-labelledby="details-warnings">
          <h3 class="section-title" id="details-warnings">
            {t('details.warnings')}
          </h3>
          <div class="notice notice--boxed notice--warning">
            <Icon name="warning" size="sm" />
            <div>
              <p>{t('entry.warnings', { count: details.warnings.length })}</p>
              <ul class="warnings">
                {details.warnings.map((warning, index) => (
                  <li key={index}>{warning}</li>
                ))}
              </ul>
            </div>
          </div>
        </section>
      )}

      {result && (
        <section class="sheet__section" aria-labelledby="details-output">
          <h3 class="section-title" id="details-output">
            {t('details.output')}
          </h3>
          <dl class="tiles">
            <div class="tile tile--wide">
              <dt class="tile__label">{t('details.output')}</dt>
              <dd class="tile__value tile__value--name">{result.name}</dd>
            </div>
            <Tile label={t('details.size')}>{formatSize(result.size)}</Tile>
            <Tile label={t('details.duration')}>{formatDuration(result.durationMs)}</Tile>
          </dl>
          {result.verified && (
            <p class="notice notice--boxed notice--success">
              <Icon name="shield" size="sm" />
              {t('details.verified')}
            </p>
          )}
        </section>
      )}
    </>
  );
}

export function DetailsSheet() {
  const entry = detailsEntry.value;
  const last = useLast(entry);
  return (
    <Sheet
      open={entry !== null}
      onClose={closeOverlay}
      eyebrow={t('details.title')}
      title={last?.name ?? ''}
    >
      {last && <Content details={last.details.value} />}
    </Sheet>
  );
}

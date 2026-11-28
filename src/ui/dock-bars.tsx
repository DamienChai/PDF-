/**
 * What the action area shows in each situation. Every bar fills the same three slots (status
 * line, middle slot, primary button), so the area keeps its height from one to the next.
 */
import type { ComponentChildren } from 'preact';
import { t, type Message } from '../i18n';
import { jobs, pickFiles, setMode, type Summary } from '../state';
import {
  OverallPercent,
  OverallProgress,
  PrimaryButton,
  Status,
  UNLOCK_FIELD_ID,
  type TapGuard,
} from './dock-parts';
import { doneMessage } from './file-parts';
import { Icon } from './icons';
import { PasswordInput } from './password-input';
import { Prose } from './prose';

export interface BarProps {
  summary: Summary;
  guard: TapGuard;
}

/**
 * The shared password field with its button. While the password is being tried the field stays
 * where it is, read-only: it keeps the focus and with it the on-screen keyboard, so a wrong
 * password can be corrected at once.
 */
export function UnlockBar({ summary, guard }: BarProps) {
  const { primary } = summary;
  const processing = summary.phase === 'processing';
  const busy = summary.analysing > 0 || processing;
  const label = primary ? t(primary.label) : t('action.unlock');
  const error = processing ? null : summary.passwordError;

  let status: ComponentChildren;
  if (processing) {
    status = (
      <Status icon="spinner" spin aside={<OverallPercent />}>
        {summary.status ? t(summary.status) : t('status.processing')}
      </Status>
    );
  } else if (error) {
    status = (
      <Status icon="alert" tone="danger" labelFor={UNLOCK_FIELD_ID}>
        {t(error)}
      </Status>
    );
  } else if (summary.passwordHint) {
    status = (
      <Status tone="quiet" labelFor={UNLOCK_FIELD_ID}>
        {t(summary.passwordHint)}
      </Status>
    );
  } else if (!primary) {
    // Still reading the files: the field is usable already, the button is not.
    status = (
      <Status icon="spinner" spin tone="quiet" labelFor={UNLOCK_FIELD_ID}>
        {t('dock.analysing.headline')}
      </Status>
    );
  } else {
    status = <Status labelFor={UNLOCK_FIELD_ID}>{t('dock.unlock.headline')}</Status>;
  }

  return (
    <>
      {status}
      <div class="dock__slot">
        <PasswordInput
          id={UNLOCK_FIELD_ID}
          leadingIcon
          value={jobs.unlockPassword.value}
          onInput={jobs.setUnlockPassword}
          revealed={jobs.unlockRevealed.value}
          onReveal={jobs.setUnlockRevealed}
          placeholder={t('unlock.password.placeholder')}
          label={processing ? t('unlock.password.label') : undefined}
          autocomplete="off"
          enterkeyhint="go"
          readOnly={processing}
          invalid={error !== null}
          describedBy={error ? 'unlock-retry-hint' : undefined}
        />
        {/* The inspector's progress bar; on the phone the bar's top edge shows it (dock.tsx). */}
        {processing && <OverallProgress class="dock__inline-progress" />}
        {error && (
          <p class="hint dock__help" id="unlock-retry-hint">
            <Prose text={t('error.password-incorrect.advice')} />
          </p>
        )}
        {!error && !processing && summary.passwordHint && (
          <p class="hint dock__help dock__help--wide">{t('dock.unlock.sharedHelp')}</p>
        )}
      </div>
      <div class="dock__primary">
        {/* Keyed: "Cancel" must not become "Unlock" in the same DOM node. A click on Cancel would
            otherwise end on a submit button and start the run again. */}
        {processing ? (
          <PrimaryButton
            key="cancel"
            variant="secondary"
            label={t(summary.processing > 1 ? 'action.cancelAll' : 'action.cancel')}
            icon="x"
            onClick={guard(() => jobs.cancelAll())}
          />
        ) : (
          <PrimaryButton
            key="run"
            submit
            onClick={guard()}
            label={label}
            icon="unlock"
            keepFocus
            disabled={busy || !primary}
            softDisabled={!busy && primary !== null && !primary.enabled}
          />
        )}
      </div>
    </>
  );
}

export function FreeBar({ summary, guard }: BarProps) {
  const { primary } = summary;
  return (
    <>
      <Status icon="shield" tone="quiet">
        {t('dock.noPassword.headline')}
      </Status>
      <div class="dock__slot">
        <p class="dock__note">
          <span>
            <Prose text={t('dock.noPassword.note')} />
          </span>
        </p>
      </div>
      <div class="dock__primary">
        <PrimaryButton
          submit
          onClick={guard()}
          label={primary ? t(primary.label) : t('action.removeRestrictions')}
          icon="unlock"
          disabled={!primary?.enabled}
        />
      </div>
    </>
  );
}

export function BusyBar({ summary, guard }: BarProps) {
  const several = summary.processing > 1;
  return (
    <>
      <Status icon="spinner" spin aside={<OverallPercent />}>
        {summary.status ? t(summary.status) : t('status.processing')}
      </Status>
      <OverallProgress class="dock__slot dock__slot--progress" />
      <div class="dock__primary">
        <PrimaryButton
          variant="secondary"
          label={t(several ? 'action.cancelAll' : 'action.cancel')}
          icon="x"
          onClick={guard(() => jobs.cancelAll())}
        />
      </div>
    </>
  );
}

export function DoneBar({ summary, guard }: BarProps) {
  const { results } = summary;
  const single = results.count === 1;
  const onlyResult = single
    ? jobs.entries.value.find((entry) => entry.view.value.result !== null)
    : undefined;

  let aside: ComponentChildren;
  if (summary.problems) {
    aside = <span class="dock__aside-danger">{t(summary.problems)}</span>;
  } else if (results.unsaved === 0) {
    aside = (
      <span class="dock__aside-ok">
        <Icon name="check" size="xs" />
        {t('dock.saved')}
      </span>
    );
  } else if (single) {
    aside = t('dock.unsaved');
  } else {
    aside = t('dock.zipHint');
  }

  return (
    <>
      <Status icon="check" tone="success" aside={aside}>
        {summary.status ? t(summary.status) : ''}
      </Status>
      {onlyResult && (
        <p class="hint dock__help">
          <Prose text={t(doneMessage(onlyResult))} />
        </p>
      )}
      <div class="dock__slot dock__slot--actions">
        {summary.canShareAll && (
          <button
            type="button"
            class="btn btn--secondary"
            onClick={guard(() => void jobs.shareAll())}
          >
            <Icon name="share" size="sm" />
            <span class="btn__label">{t(single ? 'entry.share' : 'action.shareAll')}</span>
          </button>
        )}
        {onlyResult && (
          <button
            type="button"
            class="btn btn--secondary"
            onClick={guard(() => jobs.open(onlyResult.id))}
          >
            <Icon name="open" size="sm" />
            <span class="btn__label">{t('entry.open')}</span>
          </button>
        )}
        {summary.canSaveToFolder && (
          <button
            type="button"
            class="btn btn--secondary"
            onClick={guard(() => void jobs.saveAll('folder'))}
          >
            <Icon name="folder" size="sm" />
            <span class="btn__label">{t('action.saveAllFolder')}</span>
          </button>
        )}
        <button
          type="button"
          class="btn btn--ghost dock__reset"
          onClick={guard(() => jobs.clear())}
        >
          <span class="btn__label">{t('action.startOver')}</span>
        </button>
      </div>
      <div class="dock__primary">
        <PrimaryButton
          label={t(single ? 'entry.save' : 'action.saveAll')}
          icon="install"
          onClick={guard(() => void jobs.saveAll('zip'))}
        />
      </div>
    </>
  );
}

export function IdleBar({ summary, guard }: BarProps) {
  const { suggestion } = summary;
  return (
    <>
      <Status icon="info" tone="note">
        {summary.status ? t(summary.status) : ''}
      </Status>
      <div class="dock__primary">
        {suggestion ? (
          <PrimaryButton
            label={t(suggestion.label)}
            onClick={guard(() => setMode(suggestion.mode))}
          />
        ) : (
          <PrimaryButton variant="secondary" label={t('list.addMore')} onClick={guard(pickFiles)} />
        )}
      </div>
    </>
  );
}

export function LockBar({ summary, guard }: BarProps) {
  const { primary } = summary;
  const busy = summary.analysing > 0;
  // "Enter the current password on the card" replaces the reminder while nothing can be locked.
  const blocked: Message | null = summary.phase === 'ready' ? summary.status : null;
  return (
    <>
      <div class="dock__status dock__status--note">
        {blocked ? (
          <p class="dock__headline">
            <Icon name="info" size="sm" />
            <span>{t(blocked)}</span>
          </p>
        ) : (
          <p class="dock__headline dock__headline--warning">
            <Icon name="warning" size="sm" />
            <span>
              <Prose text={t('lock.warning')} />
            </span>
          </p>
        )}
      </div>
      <div class="dock__primary">
        <PrimaryButton
          submit
          onClick={guard()}
          label={primary && primary.count > 0 ? t(primary.label) : t('action.lock')}
          icon="lock"
          disabled={busy || !primary}
          softDisabled={!busy && primary !== null && !primary.enabled}
        />
      </div>
    </>
  );
}

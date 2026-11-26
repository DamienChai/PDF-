/**
 * The Lock form: the new password with generator and strength meter, its confirmation, and the
 * advanced options. Every rule (what is valid, when an error shows) lives in `lockForm`.
 */
import { useId } from 'preact/hooks';
import { algorithmChipLabel, lockAlgorithmDescription, t, type Message } from '../i18n';
import { lockForm, type LockAlgorithm, type LockField, type LockPermissions } from '../state';
import type { PrintPermission } from '../engine/types';
import { afterRender, focusQuietly } from './focus';
import { Icon } from './icons';
import { PasswordInput } from './password-input';
import { Segmented } from './segmented';
import { SwitchRow } from './switch';

const FIELD_IDS: Readonly<Record<LockField, string>> = {
  password: 'lock-password',
  confirmation: 'lock-confirmation',
  ownerPassword: 'lock-owner-password',
};

/** Moves the focus to a field of the form, opening the advanced options if it is in there. */
export function focusLockField(field: LockField): void {
  if (field === 'ownerPassword') lockForm.setAdvancedOpen(true);
  // The confirmation field only exists while the password is hidden.
  const target =
    field === 'confirmation' && !lockForm.confirmationNeeded.peek() ? 'password' : field;
  afterRender(() => focusQuietly(document.getElementById(FIELD_IDS[target]), true));
}

function FieldError({ id, error }: { id: string; error: Message | null }) {
  if (!error) return null;
  return (
    <p class="hint hint--danger" id={id} role="alert">
      {t(error)}
    </p>
  );
}

function StrengthMeter() {
  const strength = lockForm.strength.value;
  if (strength.empty) return null;
  const hint = strength.hints[0];
  return (
    <div class="meter" data-score={strength.score} id="lock-strength">
      <div class="meter__row">
        <span class="meter__bar" aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
        </span>
        <span class="meter__label">
          <span class="sr-only">{t('strength.label')}: </span>
          {t(strength.label)}
        </span>
      </div>
      {hint && <p class="hint">{t(hint)}</p>}
    </div>
  );
}

const ALGORITHMS: readonly LockAlgorithm[] = ['aes-256', 'aes-128'];
const PRINT_OPTIONS: readonly PrintPermission[] = ['full', 'low', 'none'];
const TOGGLES: readonly Exclude<keyof LockPermissions, 'print'>[] = [
  'extract',
  'modify',
  'annotate',
  'assemble',
];

function AdvancedOptions() {
  const id = useId();
  const algorithm = lockForm.algorithm.value;
  const separateOwner = lockForm.separateOwner.value;
  const permissions = lockForm.permissions.value;
  const errors = lockForm.errors.value;
  return (
    <>
      <fieldset class="group advanced__algorithm">
        <legend class="group__title">{t('lock.algorithm.label')}</legend>
        <div class="choices">
          {ALGORITHMS.map((option) => (
            <label class="choice" key={option}>
              <input
                type="radio"
                name="lock-algorithm"
                value={option}
                checked={algorithm === option}
                onChange={() => lockForm.setAlgorithm(option)}
              />
              <span class="choice__dot" aria-hidden="true" />
              <span class="choice__title">
                <span class="mono">
                  {t(
                    algorithmChipLabel({
                      algorithm: option,
                      keyBits: option === 'aes-256' ? 256 : 128,
                    }),
                  )}
                </span>
                <span class={`badge${option === 'aes-256' ? '' : ' badge--quiet'}`}>
                  {t(
                    option === 'aes-256'
                      ? 'lock.algorithm.recommended'
                      : 'lock.algorithm.compatible',
                  )}
                </span>
              </span>
              <span class="choice__desc">{t(lockAlgorithmDescription(option))}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <div class="group advanced__owner">
        <SwitchRow
          title={t('lock.owner.switch')}
          description={t('lock.owner.description')}
          checked={separateOwner}
          onChange={(checked) => {
            lockForm.setSeparateOwner(checked);
            if (checked)
              afterRender(() => focusQuietly(document.getElementById(FIELD_IDS.ownerPassword)));
          }}
        />
        {separateOwner && (
          <div class="group group--nested">
            <div class="field">
              <label class="label" for={FIELD_IDS.ownerPassword}>
                {t('lock.owner.label')}
              </label>
              <PasswordInput
                id={FIELD_IDS.ownerPassword}
                value={lockForm.ownerPassword.value}
                onInput={lockForm.setOwnerPassword}
                revealed={lockForm.ownerRevealed.value}
                onReveal={lockForm.setOwnerRevealed}
                placeholder={t('lock.owner.placeholder')}
                autocomplete="new-password"
                enterkeyhint="done"
                onBlur={() => lockForm.touch('ownerPassword')}
                invalid={errors.ownerPassword !== null}
                describedBy={errors.ownerPassword ? `${id}-owner-error` : undefined}
              />
              <FieldError id={`${id}-owner-error`} error={errors.ownerPassword} />
            </div>

            <fieldset class="group">
              <legend class="group__title">{t('lock.permissions.title')}</legend>
              <div class="perms">
                <div class="perms__print">
                  <span class="row__title" id={`${id}-print`}>
                    {t('lock.permission.print')}
                  </span>
                  <Segmented
                    labelledBy={`${id}-print`}
                    value={permissions.print}
                    onChange={(value) => lockForm.setPermission('print', value)}
                    options={PRINT_OPTIONS.map((value) => ({
                      value,
                      label: t({ key: `lock.print.${value}` }),
                    }))}
                  />
                </div>
                {TOGGLES.map((key) => (
                  <SwitchRow
                    key={key}
                    title={t({ key: `lock.permission.${key}` })}
                    checked={permissions[key]}
                    onChange={(checked) => lockForm.setPermission(key, checked)}
                  />
                ))}
              </div>
              <p class="hint">{t('lock.permissions.note')}</p>
            </fieldset>
          </div>
        )}
      </div>

      <div class="advanced__metadata">
        <SwitchRow
          title={t('lock.metadata.switch')}
          description={t('lock.metadata.description')}
          checked={lockForm.encryptMetadata.value}
          onChange={lockForm.setEncryptMetadata}
        />
      </div>
    </>
  );
}

export function LockForm({ disabled }: { disabled: boolean }) {
  const id = useId();
  const errors = lockForm.errors.value;
  const revealed = lockForm.revealed.value;
  const generated = lockForm.generated.value;
  const hint = lockForm.passwordHint.value;
  const advancedOpen = lockForm.advancedOpen.value;
  const described = [
    errors.password ? `${id}-password-error` : null,
    hint ? `${id}-password-hint` : null,
    lockForm.strength.value.empty ? null : 'lock-strength',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <fieldset class={`lockform${advancedOpen ? ' lockform--advanced' : ''}`} disabled={disabled}>
      <legend class="sr-only">{t('dock.lock.headline')}</legend>
      <div class="lockform__main">
        <div class="field">
          <label class="label" for={FIELD_IDS.password}>
            {t(lockForm.passwordLabel.value)}
          </label>
          <PasswordInput
            id={FIELD_IDS.password}
            name="new-password"
            leadingIcon
            value={lockForm.password.value}
            onInput={lockForm.setPassword}
            revealed={revealed}
            onReveal={lockForm.setRevealed}
            placeholder={t('lock.password.placeholder')}
            autocomplete="new-password"
            enterkeyhint={lockForm.confirmationNeeded.value ? 'next' : 'go'}
            onBlur={() => lockForm.touch('password')}
            invalid={errors.password !== null}
            describedBy={described || undefined}
          />
          <FieldError id={`${id}-password-error`} error={errors.password} />
          {hint && !errors.password && (
            <p class="hint" id={`${id}-password-hint`}>
              {t(hint)}
            </p>
          )}
          <StrengthMeter />
          {generated && (
            <p class="notice notice--boxed notice--info" role="status">
              <Icon name="info" size="sm" />
              {t('lock.generated')}
            </p>
          )}
          <div class="lockform__tools">
            <button
              type="button"
              class="btn btn--tonal btn--sm"
              onClick={() => lockForm.generate()}
            >
              <Icon name="sparkle" size="sm" />
              {t('lock.generate')}
            </button>
            {generated && (
              <button
                type="button"
                class="btn btn--secondary btn--sm"
                onClick={() => void lockForm.copyPassword()}
              >
                <Icon name="copy" size="sm" />
                {t('lock.copy')}
              </button>
            )}
          </div>
        </div>

        {lockForm.confirmationNeeded.value && (
          <div class="field">
            <label class="label" for={FIELD_IDS.confirmation}>
              {t('lock.confirm.label')}
            </label>
            <PasswordInput
              id={FIELD_IDS.confirmation}
              name="confirm-password"
              value={lockForm.confirmation.value}
              onInput={lockForm.setConfirmation}
              revealed={false}
              onReveal={lockForm.setRevealed}
              placeholder={t('lock.confirm.placeholder')}
              autocomplete="new-password"
              enterkeyhint="go"
              onBlur={() => lockForm.touch('confirmation')}
              invalid={errors.confirmation !== null}
              describedBy={errors.confirmation ? `${id}-confirmation-error` : undefined}
            />
            <FieldError id={`${id}-confirmation-error`} error={errors.confirmation} />
          </div>
        )}

        <button
          type="button"
          class="advanced-toggle"
          aria-expanded={advancedOpen}
          aria-controls={`${id}-advanced`}
          onClick={() => lockForm.setAdvancedOpen(!advancedOpen)}
        >
          <span class="advanced-toggle__title">{t('lock.advanced')}</span>
          <span class="advanced-toggle__summary">{t(lockForm.advancedSummary.value)}</span>
          <Icon name="chevron-down" />
        </button>
      </div>
      {advancedOpen && (
        <div class="lockform__advanced" id={`${id}-advanced`}>
          <AdvancedOptions />
        </div>
      )}
    </fieldset>
  );
}

/**
 * After locking: what was applied, and the password once more so that it can still be copied.
 * The form itself comes back when a file is added or processed again.
 */
export function LockResult() {
  const password = lockForm.password.value;
  const revealed = lockForm.revealed.value;
  return (
    <div class="lockresult">
      <div class="lockresult__row">
        <span class="label">{t('lock.result.title')}</span>
        <span class="lockresult__value">{t(lockForm.advancedSummary.value)}</span>
      </div>
      {password === '' ? (
        <p class="hint">{t('lock.result.noPassword')}</p>
      ) : (
        <div class="field">
          <label class="label" for="lock-result-password">
            {t(lockForm.passwordLabel.value)}
          </label>
          <div class="input">
            <input
              id="lock-result-password"
              class={`input__control${revealed ? ' input__control--mono' : ''}`}
              type={(revealed ? 'text' : 'password') as 'text'}
              value={password}
              readOnly
              autocomplete="off"
            />
            <button
              type="button"
              class="input__action"
              aria-label={t(revealed ? 'password.hide' : 'password.show')}
              aria-pressed={revealed}
              onClick={() => lockForm.setRevealed(!revealed)}
            >
              <Icon name={revealed ? 'eye-off' : 'eye'} />
            </button>
            <button
              type="button"
              class="input__action"
              aria-label={t('lock.copy')}
              onClick={() => void lockForm.copyPassword()}
            >
              <Icon name="copy" />
            </button>
          </div>
        </div>
      )}
      <p class="notice notice--warning">
        <Icon name="warning" size="sm" />
        {t('lock.warning')}
      </p>
    </div>
  );
}

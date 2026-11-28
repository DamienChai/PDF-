/**
 * The action area: what to do next with the files. A sticky bar at the bottom edge on the phone
 * (above the keyboard, inside the safe area), an inspector card beside the list on desktop.
 *
 * The bar always has the same three slots (a status line, a middle slot, the primary button), so
 * its height does not change between "type the password", "working" and "save", and the primary
 * button never moves. What goes into the slots follows `jobs.summary` (see dock-bars.tsx).
 */
import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef } from 'preact/hooks';
import { t } from '../i18n';
import { jobs, lockForm, mode, overlay, type RunReport, type Summary } from '../state';
import { BusyBar, DoneBar, FreeBar, IdleBar, LockBar, UnlockBar } from './dock-bars';
import { OverallProgress, UNLOCK_FIELD_ID, unlockField, useTapGuard } from './dock-parts';
import { inlinePasswordField } from './file-parts';
import { afterRender, focusQuietly } from './focus';
import { Icon } from './icons';
import { LockForm, LockResult, focusLockField } from './lock-form';
import { isApplePlatform, publishDockHeight } from './viewport';

/** After a run: put the focus where the user has to continue. */
function followUp(report: RunReport): void {
  if (report.refusal === 'invalid-form' && report.field) {
    focusLockField(report.field);
    return;
  }
  afterRender(() => {
    if (report.refusal === 'password-required') {
      focusQuietly(unlockField());
    } else if (report.refusal === 'current-password-required' || report.rejected > 0) {
      // One locked file: the shared field takes the retry. Several: the first card that needs it.
      const shared = jobs.summary.peek().passwordError ? unlockField() : null;
      const waiting = jobs.entries
        .peek()
        .map((entry) => inlinePasswordField(entry.id))
        .find(
          (field) =>
            field !== null && (field.value === '' || field.matches('[aria-invalid="true"]')),
        );
      focusQuietly(shared ?? waiting, true);
    }
  });
}

function run(): void {
  void jobs.runPrimary().then(followUp);
}

// --- Desktop extras ------------------------------------------------------------------------------

function Shortcuts({ runnable }: { runnable: boolean }) {
  const modifier = isApplePlatform ? '⌘' : 'Ctrl';
  return (
    <dl class="shortcuts" aria-label={t('shortcuts.title')}>
      <div class="shortcuts__row">
        <dt>{t('shortcuts.choose')}</dt>
        <dd>
          <kbd class="kbd">{modifier}</kbd>
          <kbd class="kbd">O</kbd>
        </dd>
      </div>
      <div class="shortcuts__row">
        <dt>{t('shortcuts.paste')}</dt>
        <dd>
          <kbd class="kbd">{modifier}</kbd>
          <kbd class="kbd">V</kbd>
        </dd>
      </div>
      {runnable && (
        <div class="shortcuts__row">
          <dt>{t('shortcuts.run')}</dt>
          <dd>
            <kbd class="kbd">Enter</kbd>
          </dd>
        </div>
      )}
    </dl>
  );
}

/**
 * - `password`  the shared unlock field, also while its password is being tried
 * - `free`      unlock without a password (restrictions only)
 * - `lock`      the lock form's reminder and button
 * - `busy`      progress and cancel
 * - `done`      the results
 * - `idle`      nothing to do in this mode
 */
type BarKind = 'password' | 'free' | 'lock' | 'busy' | 'done' | 'idle';

function barKind(summary: Summary, typed: boolean): BarKind {
  if (summary.phase === 'finished') return 'done';
  if (summary.phase === 'processing') {
    return summary.mode === 'unlock' && typed ? 'password' : 'busy';
  }
  if (summary.mode === 'lock') return 'lock';
  if (summary.primary?.kind === 'remove-restrictions') return 'free';
  // While files are still being read the password field is offered already.
  if (summary.phase === 'ready' || summary.phase === 'analysing') return 'password';
  return 'idle';
}

export function Dock() {
  const summary = jobs.summary.value;
  const currentMode = mode.value;
  const kind = barKind(summary, jobs.unlockPassword.value !== '');
  const bar = useRef<HTMLDivElement>(null);
  const processing = summary.phase === 'processing';
  // What the primary button does: when that changes under the finger, taps are held off briefly.
  const guard = useTapGuard(`${currentMode}:${kind}:${processing}`);
  const lock = currentMode === 'lock';

  useLayoutEffect(() => (bar.current ? publishDockHeight(bar.current) : undefined), []);

  // A file that needs a password has arrived (or the password was wrong): the cursor goes to the
  // field. Never while a sheet is open, never away from another field the user is typing in,
  // and not because the mode was switched: then the focus is on the switch and stays there.
  const wanted = kind === 'password' ? summary.needPassword : 0;
  const rejected = summary.passwordError !== null && !processing;
  const previous = useRef({ wanted: 0, rejected: false, mode: currentMode });
  useEffect(() => {
    const before = previous.current;
    previous.current = { wanted, rejected, mode: currentMode };
    const arrived = wanted > before.wanted && before.mode === currentMode;
    const failed = rejected && !before.rejected;
    if ((!arrived && !failed) || overlay.peek() !== null) return;
    const active = document.activeElement;
    const typing = active instanceof HTMLInputElement && active.id !== UNLOCK_FIELD_ID;
    if (typing && !failed) return;
    focusQuietly(unlockField(), failed);
  }, [wanted, rejected, currentMode]);

  const title = lock ? t('dock.lock.headline') : t('dock.unlock.title');

  let content: ComponentChildren;
  if (kind === 'busy') content = <BusyBar summary={summary} guard={guard} />;
  else if (kind === 'done') content = <DoneBar summary={summary} guard={guard} />;
  else if (kind === 'lock') content = <LockBar summary={summary} guard={guard} />;
  else if (kind === 'password') content = <UnlockBar summary={summary} guard={guard} />;
  else if (kind === 'free') content = <FreeBar summary={summary} guard={guard} />;
  else content = <IdleBar summary={summary} guard={guard} />;

  const classes = ['dock', `dock--${kind}`];
  if (lock) classes.push('dock--long');
  if (lock && kind !== 'done' && lockForm.advancedOpen.value) classes.push('dock--wide');

  return (
    <form
      class={classes.join(' ')}
      aria-label={title}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (!processing && (kind === 'password' || kind === 'free' || kind === 'lock')) run();
      }}
    >
      <div class="dock__head">
        <h2 class="dock__title">{title}</h2>
      </div>
      {lock && (
        <div class="dock__form">
          {kind === 'done' ? <LockResult /> : <LockForm disabled={processing} />}
        </div>
      )}
      <div class="dock__bar" ref={bar} data-kind={kind}>
        {/* Phone: the typed password is being tried and the bar keeps its field; progress runs
            along the bar's top edge (the inspector shows it under the field, see UnlockBar). */}
        {kind === 'password' && processing && <OverallProgress class="dock__edge-progress" />}
        {/* Keyed: a different kind of bar is new content (and animates in), the same kind is not. */}
        <div class="dock__content" key={kind}>
          {content}
        </div>
      </div>
      <div class="dock__foot">
        <p class="privacy">
          <Icon name="shield" size="sm" />
          {t('empty.privacy')}
        </p>
        {!lock && <Shortcuts runnable={kind === 'password' || kind === 'free'} />}
      </div>
    </form>
  );
}

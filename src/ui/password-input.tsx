/**
 * A password field with a show/hide toggle. Typing aids that would leak or mangle a password
 * (capitalisation, correction, spell checking) are switched off.
 */
import type { ComponentChildren, Ref } from 'preact';
import { t } from '../i18n';
import { Icon } from './icons';

export interface PasswordInputProps {
  id: string;
  value: string;
  onInput(value: string): void;
  revealed: boolean;
  onReveal(revealed: boolean): void;
  placeholder?: string;
  /** `off` for passwords of existing files, `new-password` where one is being chosen. */
  autocomplete: 'off' | 'new-password';
  enterkeyhint: 'go' | 'done' | 'next';
  onEnter?: (() => void) | undefined;
  onBlur?: (() => void) | undefined;
  invalid?: boolean;
  disabled?: boolean;
  /** Keeps the focus (and the on-screen keyboard) while the value is being tried. */
  readOnly?: boolean;
  describedBy?: string | undefined;
  /** Accessible name when no visible <label for> exists. */
  label?: string | undefined;
  /** A leading key icon: marks the main password field of a screen. */
  leadingIcon?: boolean;
  /** Further actions inside the field, after the show/hide toggle. */
  children?: ComponentChildren;
  inputRef?: Ref<HTMLInputElement>;
  name?: string;
  /** The field belongs to one file card; the action area finds it through this mark. */
  inline?: boolean;
}

/**
 * Switches autocorrection off on a text field. Set as an attribute: where the browser also has
 * an `autocorrect` property it is a boolean, and assigning the string "off" would switch it on.
 */
export function literalEntry(element: HTMLInputElement | null): void {
  element?.setAttribute('autocorrect', 'off');
}

function assign<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (typeof ref === 'function') ref(value);
  else if (ref) ref.current = value;
}

export function PasswordInput({
  id,
  value,
  onInput,
  revealed,
  onReveal,
  placeholder,
  autocomplete,
  enterkeyhint,
  onEnter,
  onBlur,
  invalid = false,
  disabled = false,
  readOnly = false,
  describedBy,
  label,
  leadingIcon = false,
  children,
  inputRef,
  name,
  inline = false,
}: PasswordInputProps) {
  const classes = ['input'];
  if (invalid) classes.push('input--invalid');
  if (disabled) classes.push('input--disabled');
  if (readOnly) classes.push('input--busy');
  return (
    <div class={classes.join(' ')}>
      {leadingIcon && <Icon name="key" class="input__icon" />}
      <input
        ref={(element) => {
          literalEntry(element);
          assign(inputRef, element);
        }}
        id={id}
        name={name}
        class={`input__control${revealed ? ' input__control--mono' : ''}`}
        // One literal type for the attribute's union: both values take the same other attributes.
        type={(revealed ? 'text' : 'password') as 'text'}
        value={value}
        placeholder={placeholder}
        autocomplete={autocomplete}
        autocapitalize="none"
        spellcheck={false}
        enterkeyhint={enterkeyhint}
        aria-label={label}
        aria-invalid={invalid}
        aria-describedby={describedBy}
        disabled={disabled}
        readOnly={readOnly}
        data-inline-password={inline || undefined}
        onInput={(event) => onInput(event.currentTarget.value)}
        onBlur={onBlur}
        onKeyDown={(event) => {
          // Not while an input method is composing: there Enter confirms the composition.
          if (event.key === 'Enter' && !event.isComposing && onEnter) {
            event.preventDefault();
            onEnter();
          }
        }}
      />
      <button
        type="button"
        class="input__action"
        aria-label={t(revealed ? 'password.hide' : 'password.show')}
        aria-pressed={revealed}
        disabled={disabled}
        onClick={() => onReveal(!revealed)}
      >
        <Icon name={revealed ? 'eye-off' : 'eye'} />
      </button>
      {children}
    </div>
  );
}

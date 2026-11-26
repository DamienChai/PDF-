/** A switch, and the usual row around it: title and description on the left, switch on the right. */
import type { ComponentChildren } from 'preact';
import { useId } from 'preact/hooks';
import { Icon } from './icons';

export interface SwitchProps {
  checked: boolean;
  onChange(checked: boolean): void;
  labelledBy: string;
  describedBy?: string | undefined;
  disabled?: boolean;
}

export function Switch({ checked, onChange, labelledBy, describedBy, disabled }: SwitchProps) {
  return (
    <button
      type="button"
      class="switch"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      disabled={disabled}
      onClick={(event) => {
        // The row around it toggles too; one click must count once.
        event.stopPropagation();
        onChange(!checked);
      }}
    >
      <span class="switch__thumb">
        <Icon name="check" size="xs" />
      </span>
    </button>
  );
}

export interface SwitchRowProps {
  title: string;
  description?: string | undefined;
  checked: boolean;
  onChange(checked: boolean): void;
  children?: ComponentChildren;
}

/** The whole row is the target; the switch inside it is the control assistive technology sees. */
export function SwitchRow({ title, description, checked, onChange }: SwitchRowProps) {
  const id = useId();
  return (
    <div class="row row--toggle" onClick={() => onChange(!checked)}>
      <div class="row__text">
        <span class="row__title" id={`${id}-t`}>
          {title}
        </span>
        {description && (
          <span class="row__desc" id={`${id}-d`}>
            {description}
          </span>
        )}
      </div>
      <Switch
        checked={checked}
        onChange={onChange}
        labelledBy={`${id}-t`}
        describedBy={description ? `${id}-d` : undefined}
      />
    </div>
  );
}

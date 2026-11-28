/**
 * Inline SVG icons. One 24-unit grid, round caps and joins, stroke width set by the `.icon`
 * class; they take the colour of the text around them.
 */
import type { ComponentChildren } from 'preact';

const dot = (cx: number, cy: number, r = 1) => (
  <circle cx={cx} cy={cy} r={r} fill="currentColor" stroke="none" />
);

const ICONS = {
  settings: (
    <>
      <path d="M10.26 5.01 10.42 2.53h3.16l.16 2.48 1.97.82 1.87-1.64 2.23 2.23-1.64 1.87.82 1.97 2.48.16v3.16l-2.48.16-.82 1.97 1.64 1.87-2.23 2.23-1.87-1.64-1.97.82-.16 2.48h-3.16l-.16-2.48-1.97-.82-1.87 1.64-2.23-2.23 1.64-1.87-.82-1.97-2.48-.16v-3.16l2.48-.16.82-1.97-1.64-1.87 2.23-2.23 1.87 1.64Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  install: (
    <path d="M12 4v10.5M8 10.5l4 4 4-4M5 16.5v1A2.5 2.5 0 0 0 7.5 20h9a2.5 2.5 0 0 0 2.5-2.5v-1" />
  ),
  lock: (
    <>
      <rect x="5" y="10.5" width="14" height="10" rx="2.5" />
      <path d="M8.25 10.5V7.75a3.75 3.75 0 0 1 7.5 0v2.75" />
    </>
  ),
  unlock: (
    <>
      <rect x="5" y="10.5" width="14" height="10" rx="2.5" />
      <path d="M8.25 10.5V7.75a3.75 3.75 0 0 1 7.1-1.7" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3.2 5 5.8v5.4c0 4.4 2.9 8.2 7 9.6 4.1-1.4 7-5.2 7-9.6V5.8l-7-2.6Z" />
      <path d="m9.2 12 2 2 3.6-4" />
    </>
  ),
  /** Restrictions: a shield with a bar across it. */
  restricted: (
    <>
      <path d="M12 3.2 5 5.8v5.4c0 4.4 2.9 8.2 7 9.6 4.1-1.4 7-5.2 7-9.6V5.8l-7-2.6Z" />
      <path d="M9 12h6" />
    </>
  ),
  lines: <path d="M5 6.5h14M5 12h14M5 17.5h8" />,
  check: <path d="m5 12.5 4.5 4.5L19 7" />,
  x: <path d="m6.5 6.5 11 11m0-11-11 11" />,
  plus: <path d="M12 5.5v13M5.5 12h13" />,
  more: (
    <>
      {dot(12, 5.5, 1.6)}
      {dot(12, 12, 1.6)}
      {dot(12, 18.5, 1.6)}
    </>
  ),
  'chevron-down': <path d="M6.5 9.5 12 15l5.5-5.5" />,
  eye: (
    <>
      <path d="M2.2 12S5.8 5.5 12 5.5 21.8 12 21.8 12 18.2 18.5 12 18.5 2.2 12 2.2 12Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  'eye-off': (
    <>
      <path d="M4 4l16 16" />
      <path d="M10.4 5.6c.5-.07 1.05-.1 1.6-.1 6.2 0 9.8 6.5 9.8 6.5a17.6 17.6 0 0 1-2.75 3.6M6.7 7.3A16.8 16.8 0 0 0 2.2 12s3.6 6.5 9.8 6.5c1.75 0 3.3-.5 4.65-1.25" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
    </>
  ),
  key: (
    <>
      <circle cx="7.75" cy="16.25" r="4.25" />
      <path d="M10.75 13.25 20 4M16 8l3 3M12.75 11.25l2.25 2.25" />
    </>
  ),
  copy: (
    <>
      <rect x="8.5" y="8.5" width="11" height="11" rx="2.5" />
      <path d="M15.5 8.5V7A2.5 2.5 0 0 0 13 4.5H7A2.5 2.5 0 0 0 4.5 7v6A2.5 2.5 0 0 0 7 15.5h1.5" />
    </>
  ),
  alert: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.8v4.9" />
      {dot(12, 16)}
    </>
  ),
  bang: (
    <>
      <path d="M12 4.5v9.5" />
      {dot(12, 18.8, 1.4)}
    </>
  ),
  warning: (
    <>
      <path d="M10.6 4.3 2.9 17.6A1.6 1.6 0 0 0 4.3 20h15.4a1.6 1.6 0 0 0 1.4-2.4L13.4 4.3a1.6 1.6 0 0 0-2.8 0Z" />
      <path d="M12 9.5V14" />
      {dot(12, 16.9)}
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11.3v4.9" />
      {dot(12, 8)}
    </>
  ),
  spinner: (
    <>
      <circle cx="12" cy="12" r="8.5" opacity=".28" />
      <path d="M20.5 12A8.5 8.5 0 0 0 12 3.5" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  output: <path d="M6 5v6a3 3 0 0 0 3 3h9M14.5 10.5 18 14l-3.5 3.5" />,
  'file-plus': (
    <>
      <path d="M13.5 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-10l-5-5Z" />
      <path d="M13.5 3.5v5h5M12 12v5M9.5 14.5h5" />
    </>
  ),
  trash: (
    <path d="M4.5 7h15M9.5 7V5.5A1.5 1.5 0 0 1 11 4h2a1.5 1.5 0 0 1 1.5 1.5V7M6.5 7l.8 11.1A2 2 0 0 0 9.3 20h5.4a2 2 0 0 0 2-1.9L17.5 7" />
  ),
  share: (
    <>
      <circle cx="17.5" cy="5.5" r="2.5" />
      <circle cx="6.5" cy="12" r="2.5" />
      <circle cx="17.5" cy="18.5" r="2.5" />
      <path d="m8.7 10.7 6.6-3.9M8.7 13.3l6.6 3.9" />
    </>
  ),
  open: (
    <>
      <path d="M13 5h6v6M19 5l-8.5 8.5" />
      <path d="M10 6H7.5A2.5 2.5 0 0 0 5 8.5v8A2.5 2.5 0 0 0 7.5 19h8a2.5 2.5 0 0 0 2.5-2.5V14" />
    </>
  ),
  redo: (
    <>
      <path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" />
      <path d="M19.5 4.5v4h-4" />
    </>
  ),
  sparkle: (
    <>
      <path d="M11 4.5c.5 3.6 1.9 5 5.5 5.5-3.6.5-5 1.9-5.5 5.5-.5-3.6-1.9-5-5.5-5.5 3.6-.5 5-1.9 5.5-5.5Z" />
      <path d="M18 14.5c.25 1.6.9 2.25 2.5 2.5-1.6.25-2.25.9-2.5 2.5-.25-1.6-.9-2.25-2.5-2.5 1.6-.25 2.25-.9 2.5-2.5Z" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="3.75" />
      <path d="M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2M6 6l1.4 1.4M16.6 16.6 18 18M6 18l1.4-1.4M16.6 7.4 18 6" />
    </>
  ),
  moon: <path d="M19.5 14.2A7.8 7.8 0 0 1 9.8 4.5a7.8 7.8 0 1 0 9.7 9.7Z" />,
  /** "Follow the system": a disc that is half light, half dark. */
  auto: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 3.5a8.5 8.5 0 0 1 0 17Z" fill="currentColor" stroke="none" />
    </>
  ),
  folder: (
    <path d="M4 7.5A2.5 2.5 0 0 1 6.5 5h3.2l2 2.5h5.8A2.5 2.5 0 0 1 20 10v6.5a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 16.5v-9Z" />
  ),
  /** Partly allowed (low-resolution printing): a half-filled circle. */
  partial: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 3.5a8.5 8.5 0 0 0 0 17Z" fill="currentColor" stroke="none" />
    </>
  ),
} as const;

export type IconName = keyof typeof ICONS;

export interface IconProps {
  name: IconName;
  size?: 'xs' | 'sm' | 'md' | 'lg';
  spin?: boolean;
  class?: string;
}

/** A decorative icon: hidden from assistive technology, the control around it carries the label. */
export function Icon({ name, size = 'md', spin = false, class: extra }: IconProps) {
  const classes = ['icon'];
  if (size !== 'md') classes.push(`icon--${size}`);
  if (spin) classes.push('icon--spin');
  if (extra) classes.push(extra);
  return (
    <svg class={classes.join(' ')} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {ICONS[name] as ComponentChildren}
    </svg>
  );
}

/** The app's mark, as in the icon files: a sheet of paper with a keyhole on indigo. */
export function BrandMark({ class: extra }: { class?: string }) {
  return (
    <svg class={extra} viewBox="0 0 512 512" aria-hidden="true" focusable="false">
      <rect width="512" height="512" rx="124" fill="#4655D6" />
      <g transform="translate(256 256) scale(1.3) translate(-256 -256)">
        <path
          fill="#FFF"
          d="M164 108h136l72 72v200a24 24 0 0 1-24 24H164a24 24 0 0 1-24-24V132a24 24 0 0 1 24-24z"
        />
        <path fill="#C3C9F4" d="M300 108l72 72h-48a24 24 0 0 1-24-24z" />
        <path
          fill="#4655D6"
          d="M256 198a42 42 0 0 1 23.6 76.7l14.2 54.2a10 10 0 0 1-9.7 12.5h-56.2a10 10 0 0 1-9.7-12.5l14.2-54.2A42 42 0 0 1 256 198z"
        />
      </g>
    </svg>
  );
}

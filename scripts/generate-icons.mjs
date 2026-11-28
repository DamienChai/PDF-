// Generates every icon of the app from one description of the logo:
//
//   node scripts/generate-icons.mjs
//
// Writes the SVG sources (public/favicon.svg, public/icons/icon.svg) and renders the PNGs the web
// manifest and index.html refer to. Rendering uses the Chromium that Playwright installs anyway,
// so no image library is needed. The results are committed; re-run after changing the design.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = join(root, 'public');
const iconsDir = join(publicDir, 'icons');

const INDIGO = '#4655D6';
const INDIGO_DEEP = '#3644BE';
const PAPER = '#FFFFFF';
const FOLD = '#C3C9F4';

// --- The logo: a sheet of paper with a folded corner and a keyhole ------------------------------
// Drawn on a 512 x 512 canvas, centred on (256, 256). The sheet's corners lie 188 units from the
// centre, inside the "safe zone" circle (radius 204.8) that maskable icons must respect.

const SHEET =
  'M164 108h136l72 72v200a24 24 0 0 1-24 24H164a24 24 0 0 1-24-24V132a24 24 0 0 1 24-24z';
const CORNER = 'M300 108l72 72h-48a24 24 0 0 1-24-24z';
// A circle sitting on a flared stem, a little above the middle to balance the folded corner.
const KEYHOLE =
  'M256 198a42 42 0 0 1 23.6 76.7l14.2 54.2a10 10 0 0 1-9.7 12.5h-56.2' +
  'a10 10 0 0 1-9.7-12.5l14.2-54.2A42 42 0 0 1 256 198z';

/** The logo's parts, optionally scaled about the centre of the canvas. */
function glyph({ scale = 1, paper = PAPER, fold = FOLD, hole = INDIGO } = {}) {
  const transform =
    scale === 1 ? '' : ` transform="translate(256 256) scale(${scale}) translate(-256 -256)"`;
  return [
    `<g${transform}>`,
    `<path fill="${paper}" d="${SHEET}"/>`,
    `<path fill="${fold}" d="${CORNER}"/>`,
    `<path fill="${hole}" d="${KEYHOLE}"/>`,
    '</g>',
  ].join('');
}

function svg(body, { size = 512, title } = {}) {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="${size}" height="${size}">` +
    (title ? `<title>${title}</title>` : '') +
    body +
    '</svg>\n'
  );
}

const gradient =
  '<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">' +
  `<stop offset="0" stop-color="${INDIGO}"/><stop offset="1" stop-color="${INDIGO_DEEP}"/>` +
  '</linearGradient></defs>';

/** Rounded tile with a small transparent margin: launcher, taskbar and dock icon. */
const appIcon = () =>
  svg(
    `${gradient}<rect x="24" y="24" width="464" height="464" rx="104" fill="url(#g)"/>${glyph({ scale: 1.12 })}`,
    {
      title: 'PDF Key',
    },
  );

/** Full-bleed tile for the browser tab: every pixel counts at 16 px, so the logo is larger. */
const favicon = () =>
  svg(`<rect width="512" height="512" rx="112" fill="${INDIGO}"/>${glyph({ scale: 1.3 })}`, {
    title: 'PDF Key',
  });

/** Maskable: the launcher cuts its own shape out of a full-bleed square. */
const maskable = () => svg(`${gradient}<rect width="512" height="512" fill="url(#g)"/>${glyph()}`);

/** iOS rounds the corners itself and does not support transparency. */
const appleTouch = () =>
  svg(`${gradient}<rect width="512" height="512" fill="url(#g)"/>${glyph({ scale: 1.16 })}`);

/** Monochrome: only the alpha channel is used (Android themed icons, notification badges). */
const monochrome = () => svg(`<path fill="#fff" fill-rule="evenodd" d="${SHEET}${KEYHOLE}"/>`);

// --- App shortcut icons: a padlock, open or closed, on a round indigo badge ---------------------

function padlock(open) {
  // Open: the shackle is lifted clear of the body on the left, so the two states stay
  // distinguishable at 48 px. The whole lock sits lower to remain centred.
  const top = open ? 250 : 228;
  const shackle = open
    ? `M316 ${top + 4}v-88a60 60 0 0 0-120 0v10`
    : `M196 ${top + 4}v-44a60 60 0 0 1 120 0v44`;
  return svg(
    `<circle cx="256" cy="256" r="256" fill="${INDIGO}"/>` +
      `<path fill="none" stroke="${PAPER}" stroke-width="34" stroke-linecap="round" d="${shackle}"/>` +
      `<rect x="152" y="${top}" width="208" height="164" rx="30" fill="${PAPER}"/>` +
      `<circle cx="256" cy="${top + 70}" r="24" fill="${INDIGO}"/>` +
      `<rect x="245" y="${top + 74}" width="22" height="50" rx="11" fill="${INDIGO}"/>`,
  );
}

// --- Output -------------------------------------------------------------------------------------

/** [file, svg source, size in pixels] */
const PNGS = [
  ['icon-192.png', appIcon(), 192],
  ['icon-512.png', appIcon(), 512],
  ['maskable-192.png', maskable(), 192],
  ['maskable-512.png', maskable(), 512],
  ['monochrome-512.png', monochrome(), 512],
  ['apple-touch-icon.png', appleTouch(), 180],
  ['favicon-48.png', favicon(), 48],
  ['shortcut-unlock-96.png', padlock(true), 96],
  ['shortcut-unlock-192.png', padlock(true), 192],
  ['shortcut-lock-96.png', padlock(false), 96],
  ['shortcut-lock-192.png', padlock(false), 192],
];

await mkdir(iconsDir, { recursive: true });
await writeFile(join(iconsDir, 'icon.svg'), appIcon());
await writeFile(join(publicDir, 'favicon.svg'), favicon());

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const [file, source, size] of PNGS) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
      `<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${source}`,
    );
    const png = await page.screenshot({
      omitBackground: true,
      clip: { x: 0, y: 0, width: size, height: size },
    });
    await writeFile(join(iconsDir, file), png);
    console.log(`${file}  ${size}x${size}  ${png.length} bytes`);
  }
} finally {
  await browser.close();
}

/**
 * Layout guards. For every combination of window size, language and theme the main states of
 * the app are visited and measured:
 *
 *   - the page never scrolls sideways and nothing reaches outside the window;
 *   - no label is cut off with an ellipsis and none is squeezed out of its button (file names
 *     are the exception: they are shortened on purpose);
 *   - nothing in the pinned list header reaches below it, visible or not;
 *   - no note or advice ends in a stub of a last line;
 *   - the primary button is completely on screen and can be pressed;
 *   - a focused field comes to rest clear of the pinned action area and the top bar;
 *   - the last file of a long list can be scrolled clear of the pinned action area;
 *   - sheets and dialogs fit the window.
 *
 * 412 × 520 is the phone with its keyboard open: the window is loaded at full height and shrinks
 * when the first field has the focus, exactly as Android Chrome resizes it.
 *
 * Runs in its own Playwright project (`layout`), once per combination.
 */
import { readFileSync } from 'node:fs';
import { devices, type Locator, type Page } from '@playwright/test';
import { expect, test, type App } from './support/app';
import { LARGE_PDF, fixturePath } from './support/files';

interface Size {
  name: string;
  width: number;
  height: number;
  mobile: boolean;
  /** Start at this height and shrink to `height` once a field has the focus. */
  keyboardFrom?: number;
}

const SIZES: readonly Size[] = [
  { name: 'small phone 360×740', width: 360, height: 740, mobile: true },
  { name: 'Pixel 412×915', width: 412, height: 915, mobile: true },
  { name: 'Pixel with keyboard 412×520', width: 412, height: 520, mobile: true, keyboardFrom: 915 },
  { name: 'desktop 1440×900', width: 1440, height: 900, mobile: false },
  // A narrower list beside the inspector: files as wide cards instead of table rows.
  { name: 'laptop 1280×800', width: 1280, height: 800, mobile: false },
];
const LOCALES = ['zh-CN', 'en-US'] as const;
const THEMES = ['light', 'dark'] as const;

/** File names as people have them: long, without a single place to break. */
const LONG_NAMES = [
  '2024年度财务报表及审计报告最终版本（含附注与补充说明）_第三次修订_final_FINAL(3).pdf',
  'a_very_long_file_name_without_any_spaces_or_breaks_that_goes_on_and_on_2025-11-26_v12.pdf',
] as const;

// Without the browser type: that one belongs to the project, not to a group of tests.
const { defaultBrowserType: _phoneBrowser, ...PHONE } = devices['Pixel 7'];
const { defaultBrowserType: _desktopBrowser, ...DESKTOP } = devices['Desktop Chrome'];

interface Problem {
  what: string;
}

/** Everything that reaches outside the window, and whether the page scrolls sideways. */
function overflow(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const problems: string[] = [];
    const root = document.documentElement;
    const width = root.clientWidth;
    if (root.scrollWidth > width) {
      problems.push(
        `the page scrolls sideways (${root.scrollWidth}px wide in a ${width}px window)`,
      );
    }
    const describe = (element: Element): string => {
      const text = (element.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
      const classes = element.getAttribute('class');
      return `<${element.tagName.toLowerCase()}${classes ? ` class="${classes}"` : ''}> "${text}"`;
    };
    /** An ancestor that itself fits the window cuts off whatever sticks out of it. */
    const clipped = (element: Element): boolean => {
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        if (getComputedStyle(parent).overflowX === 'visible') continue;
        const box = parent.getBoundingClientRect();
        if (box.left >= -1 && box.right <= width + 1) return true;
      }
      return false;
    };
    for (const element of document.body.querySelectorAll('*')) {
      // Shapes inside an icon are positioned by the icon.
      if (element.closest('svg') && element.tagName.toLowerCase() !== 'svg') continue;
      if (element.closest('.sr-only')) continue;
      if (!(element as HTMLElement).checkVisibility({ checkVisibilityCSS: true })) continue;
      const box = element.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      if (box.left >= -1 && box.right <= width + 1) continue;
      if (clipped(element)) continue;
      problems.push(
        `${describe(element)} reaches outside the window: ${box.left.toFixed(1)}…${box.right.toFixed(1)} of ${width}`,
      );
    }
    return problems;
  });
}

/**
 * Text that does not get the room it needs: cut off with an ellipsis, clamped to fewer lines than
 * it has, or wider than the inside of its button or chip. File names are shortened on purpose
 * and fields scroll; what is hidden from sight for screen readers only does not count.
 */
function cutOff(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const problems: string[] = [];
    const describe = (element: Element): string => {
      const text = (element.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
      const classes = element.getAttribute('class');
      return `<${element.tagName.toLowerCase()}${classes ? ` class="${classes}"` : ''}> "${text}"`;
    };
    const hiddenFromSight = (element: Element): boolean => {
      for (let node: Element | null = element; node && node !== document.body;) {
        const style = getComputedStyle(node);
        if (style.clipPath !== 'none' && node.getBoundingClientRect().width <= 2) return true;
        node = node.parentElement;
      }
      return false;
    };
    const seen = (element: Element): boolean =>
      (element as HTMLElement).checkVisibility({ checkVisibilityCSS: true }) &&
      !hiddenFromSight(element);

    for (const element of document.body.querySelectorAll('*')) {
      if (element.closest('svg, .sr-only, .filename, [data-entry] h3')) continue;
      if (element.matches('input, pre') || !(element.textContent ?? '').trim()) continue;
      if (!seen(element)) continue;
      const style = getComputedStyle(element);
      const ellipsis =
        style.textOverflow === 'ellipsis' &&
        style.overflowX !== 'visible' &&
        // Without tolerance: a label that is a fraction of a pixel too wide loses its last
        // letters to the ellipsis all the same.
        element.scrollWidth > element.clientWidth;
      const clamped =
        style.getPropertyValue('-webkit-line-clamp') !== 'none' &&
        element.scrollHeight > element.clientHeight + 1;
      if (ellipsis || clamped) problems.push(`${describe(element)} is cut off`);
    }

    for (const element of document.body.querySelectorAll('button, .chip, .badge')) {
      if (element.closest('.sr-only') || !seen(element)) continue;
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      const left = box.left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft);
      const right = box.right - parseFloat(style.borderRightWidth) - parseFloat(style.paddingRight);
      let from = Infinity;
      let to = -Infinity;
      const take = (rect: DOMRect): void => {
        if (rect.width === 0) return;
        from = Math.min(from, rect.left);
        to = Math.max(to, rect.right);
      };
      for (const node of element.childNodes) {
        if (node instanceof Text) {
          if (!node.data.trim()) continue;
          const range = document.createRange();
          range.selectNodeContents(node);
          take(range.getBoundingClientRect());
        } else if (node instanceof Element) {
          // A spinner's box turns with it; a label positioned out of the flow is not laid out
          // inside the button.
          if (node.matches('.sr-only, .icon--spin') || !seen(node)) continue;
          if (getComputedStyle(node).position === 'absolute') continue;
          take(node.getBoundingClientRect());
        }
      }
      if (from < left - 1 || to > right + 1) {
        problems.push(`${describe(element)} does not fit inside its own padding`);
      }
    }
    return problems;
  });
}

/**
 * The list header is pinned while the list scrolls under it, which makes it a layer of its own
 * in the browser. Nothing in it may reach below its bottom edge, not even the invisible hit area
 * of a small control: Chromium has left stale pixels in the part of such a layer that nothing
 * paints (a strip of the empty state's button under the header, every few page loads).
 */
function belowPinnedHeader(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const problems: string[] = [];
    const header = document.querySelector('.listhead');
    if (!header || getComputedStyle(header).position !== 'sticky') return problems;
    const edge = header.getBoundingClientRect().bottom;
    const describe = (element: Element): string => {
      const text = (element.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
      return `<${element.tagName.toLowerCase()} class="${element.getAttribute('class') ?? ''}"> "${text}"`;
    };
    for (const element of header.querySelectorAll('*')) {
      if (element.closest('svg') && element.tagName.toLowerCase() !== 'svg') continue;
      const box = element.getBoundingClientRect();
      if (box.height === 0) continue;
      if (box.bottom > edge + 0.5) {
        problems.push(
          `${describe(element)} reaches ${(box.bottom - edge).toFixed(1)}px below the pinned list header`,
        );
      }
      for (const pseudo of ['::before', '::after']) {
        const style = getComputedStyle(element, pseudo);
        if (style.content === 'none' || style.position !== 'absolute') continue;
        const shift = style.transform === 'none' ? 0 : new DOMMatrix(style.transform).m42;
        const bottom =
          box.top + element.clientTop + parseFloat(style.top) + parseFloat(style.height) + shift;
        if (bottom > edge + 0.5) {
          problems.push(
            `the hit area of ${describe(element)} reaches ${(bottom - edge).toFixed(1)}px below the pinned list header`,
          );
        }
      }
    }
    return problems;
  });
}

/**
 * Notes and advice keep the end of their text together (prose.tsx), so that the last line is
 * never a stub: "……文件也将无法 / 打开。" or one English word alone. This measures the outcome
 * in every text that has such an end piece: its last line as the browser has set it.
 */
function stubLines(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const problems: string[] = [];
    // Not what is there for screen readers only (the reminder of the bar with the keyboard open).
    const seen = (element: Element): boolean => {
      if (!(element as HTMLElement).checkVisibility({ checkVisibilityCSS: true })) return false;
      for (let node: Element | null = element; node && node !== document.body;) {
        const style = getComputedStyle(node);
        if (style.clipPath !== 'none' && node.getBoundingClientRect().width <= 2) return false;
        node = node.parentElement;
      }
      return true;
    };
    const blocks = new Set<Element>();
    for (const piece of document.querySelectorAll('.keep')) {
      let block: Element | null = piece;
      while (block && (block.matches('.keep') || getComputedStyle(block).display === 'inline')) {
        block = block.parentElement;
      }
      if (block && seen(block)) blocks.add(block);
    }
    for (const block of blocks) {
      // The characters of the text, line by line. A heading inside the block ("File is damaged")
      // is a block of its own and not part of the text.
      const lines: { middle: number; text: string }[] = [];
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
      const range = document.createRange();
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        let owner = node.parentElement;
        while (
          owner &&
          owner !== block &&
          !/^(block|flex|grid)$/.test(getComputedStyle(owner).display)
        ) {
          owner = owner.parentElement;
        }
        if (owner !== block) continue;
        const text = node.nodeValue ?? '';
        for (let index = 0; index < text.length; index++) {
          range.setStart(node, index);
          range.setEnd(node, index + 1);
          const box = range.getClientRects()[0];
          if (!box || box.width === 0) continue;
          const middle = (box.top + box.bottom) / 2;
          const line = lines.find((other) => Math.abs(other.middle - middle) < 6);
          if (line) line.text += text.charAt(index);
          else lines.push({ middle, text: text.charAt(index) });
        }
      }
      if (lines.length < 2) continue;
      lines.sort((a, b) => a.middle - b.middle);
      const last = lines[lines.length - 1]!.text.trim();
      const letters = last.replace(/[\s，。；：！？、,.;:!?…]/g, '');
      const stub = /[\u3400-\u9fff]/.test(last)
        ? letters.length < 4
        : last.split(/\s+/).length < 2 && letters.length < 12;
      if (stub) {
        const whole = lines.map((line) => line.text.trim()).join(' / ');
        problems.push(`the last line of "${whole}" is a stub`);
      }
    }
    return problems;
  });
}

/** What covers an element at its centre and near its edges, if anything does. */
function coveredBy(target: Locator): Promise<string[]> {
  return target.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const points: [number, number][] = [
      [box.left + box.width / 2, box.top + box.height / 2],
      [box.left + box.width / 2, box.top + 3],
      [box.left + box.width / 2, box.bottom - 3],
    ];
    const found: string[] = [];
    for (const [x, y] of points) {
      const hit = document.elementFromPoint(x, y);
      // The field's own frame (icon, show/hide button) belongs to it.
      const frame = element.closest('.input') ?? element;
      if (hit && (hit === element || element.contains(hit) || frame.contains(hit))) continue;
      const classes = hit?.getAttribute('class');
      found.push(
        hit
          ? `<${hit.tagName.toLowerCase()}${classes ? ` class="${classes}"` : ''}> at ${Math.round(x)},${Math.round(y)}`
          : `nothing at ${Math.round(x)},${Math.round(y)} (outside the window)`,
      );
    }
    return found;
  });
}

interface Checks {
  /** Must be completely on screen and uncovered, wherever the page is scrolled to. */
  primary?: Locator;
  /** Given the focus and scrolled to, as the browser does; must then be uncovered. */
  field?: Locator;
  /** With the page scrolled to its end, the last file must be clear of the action area. */
  lastCard?: boolean;
  /** The open sheet or dialog must fit the window and not scroll sideways. */
  dialog?: Locator;
}

async function check(app: App, state: string, checks: Checks): Promise<void> {
  const { page } = app;
  const problems: Problem[] = [];
  const note = (what: string): void => void problems.push({ what });

  // What is still sliding or turning into place is measured where it comes to rest.
  await app.settled();
  for (const found of await overflow(page)) note(found);
  for (const found of await cutOff(page)) note(found);
  for (const found of await belowPinnedHeader(page)) note(found);
  for (const found of await stubLines(page)) note(found);

  const scrollTo = (position: 'top' | 'end'): Promise<void> =>
    page.evaluate((where) => {
      window.scrollTo(0, where === 'top' ? 0 : document.documentElement.scrollHeight);
    }, position);

  if (checks.primary) {
    for (const position of ['top', 'end'] as const) {
      // On desktop the action area is part of the page; it is on screen at the top of it.
      if (position === 'end' && !app.phone) continue;
      await scrollTo(position);
      await expect(
        checks.primary,
        `${state}: primary button on screen (page at ${position})`,
      ).toBeInViewport({ ratio: 1 });
      for (const cover of await coveredBy(checks.primary)) {
        note(`the primary button is covered by ${cover} (page at ${position})`);
      }
    }
    await scrollTo('top');
  }

  if (checks.field) {
    await checks.field.focus();
    // What the browser does with the focused field when the keyboard opens or a key is typed.
    await checks.field.evaluate((element) => element.scrollIntoView({ block: 'nearest' }));
    await expect(checks.field, `${state}: focused field on screen`).toBeInViewport({ ratio: 1 });
    for (const cover of await coveredBy(checks.field)) {
      note(`the focused field is covered by ${cover}`);
    }
  }

  if (checks.lastCard) {
    await scrollTo('end');
    const last = app.cards.last();
    await expect(last, `${state}: last file on screen at the end of the page`).toBeInViewport({
      ratio: 1,
    });
    for (const cover of await coveredBy(last)) note(`the last file is covered by ${cover}`);
    await scrollTo('top');
  }

  if (checks.dialog) {
    await expect(checks.dialog, `${state}: dialog on screen`).toBeInViewport({ ratio: 1 });
    const inside = await checks.dialog.evaluate((element) => {
      const wide: string[] = [];
      for (const node of [element, ...element.querySelectorAll('*')]) {
        if (node.tagName.toLowerCase() === 'pre') continue; // technical details scroll by design
        if (
          node.scrollWidth > node.clientWidth + 1 &&
          getComputedStyle(node).overflowX !== 'visible'
        ) {
          wide.push(`<${node.tagName.toLowerCase()} class="${node.getAttribute('class') ?? ''}">`);
        }
      }
      return wide;
    });
    for (const node of inside) note(`${node} scrolls sideways inside the dialog`);
  }

  expect(
    problems.map((problem) => problem.what),
    `layout problems in state "${state}"`,
  ).toEqual([]);
}

test.describe('the guards themselves', () => {
  test.use({ ...PHONE, viewport: { width: 412, height: 915 }, locale: 'zh-CN' });

  test('notice a layout that is broken on purpose', async ({ app, page }) => {
    await app.open();
    await app.addFixtures('aes-256-r6.pdf', 'aes-128-r4.pdf', 'plain.pdf');
    await app.analysed(3);
    expect(await overflow(page)).toEqual([]);
    expect(await coveredBy(app.dockButton('action.unlockCount', { count: 2 }))).toEqual([]);

    // A card that is wider than the window.
    await page.addStyleTag({ content: '[data-entry]:first-child { width: 520px; }' });
    const wide = await overflow(page);
    expect(wide.join('\n')).toContain('the page scrolls sideways');
    expect(wide.join('\n')).toContain('reaches outside the window');

    // Something lying on top of the bottom edge: the primary button and the last card's place.
    await page.addStyleTag({
      content:
        '[data-entry]:first-child { width: auto; } body::after { content: ""; position: fixed; inset: auto 0 0 0; height: 60px; z-index: 99; }',
    });
    expect(await overflow(page)).toEqual([]);
    expect(await coveredBy(app.dockButton('action.unlockCount', { count: 2 }))).not.toEqual([]);
  });

  test('notice text that is cut off or squeezed', async ({ app, page }) => {
    await app.open();
    await app.addFixtures('aes-256-r6.pdf', 'owner-only-r6.pdf');
    await app.analysed(2);
    await app.unlockField.fill('user');
    expect(await cutOff(page)).toEqual([]);

    // A primary button too narrow for its label: the label ends in an ellipsis.
    await page.addStyleTag({ content: 'form button[type="submit"] { width: 96px; }' });
    expect((await cutOff(page)).join('\n')).toContain('is cut off');

    // A button that is narrower than what is in it: the label reaches into the padding.
    await page.addStyleTag({
      content:
        'form button[type="submit"] { width: auto; } header button:not([aria-label]) { width: 40px; }',
    });
    expect((await cutOff(page)).join('\n')).toContain('does not fit inside its own padding');
  });

  test('notice a last line that is a stub', async ({ app, page }) => {
    await app.open();
    // Ten characters in a column of eight and a half: the end piece decides where the line
    // breaks, if it is kept together.
    const set = (head: string, end: string, kept: boolean): Promise<void> =>
      page.evaluate(
        (text) => {
          document.querySelector('#stub-probe')?.remove();
          const probe = document.createElement('p');
          probe.id = 'stub-probe';
          probe.style.cssText = 'width: 8.5em; font-size: 16px; letter-spacing: 0;';
          const piece = document.createElement('span');
          piece.className = 'keep';
          if (!text.kept) piece.style.display = 'inline';
          piece.textContent = text.end;
          probe.append(text.head, piece);
          document.body.append(probe);
        },
        { head, end, kept },
      );

    await set('一二三四五', '六七八九十。', true);
    expect(await stubLines(page)).toEqual([]);
    await set('一二三四五六七八', '九十。', false);
    expect((await stubLines(page)).join('\n')).toContain('九十。" is a stub');
  });
});

/** A share sheet for PDF files, as Chrome on Android has one. */
async function withShareSheet(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true });
    Object.defineProperty(navigator, 'share', { configurable: true, value: async () => undefined });
  });
}

declare global {
  interface Window {
    e2eProgressLine?: { top: number; left: number; width: number; areaWidth: number };
  }
}

test.describe('the progress of a typed password, on the phone', () => {
  test.use({ ...PHONE, viewport: { width: 412, height: 915 }, locale: 'zh-CN' });

  test('runs along the top edge of the action area, from side to side', async ({ app, page }) => {
    await app.open();
    await app.addFiles([LARGE_PDF.path]);
    await app.expectState(LARGE_PDF.name, 'needs-password');

    // Measured the moment the line appears: the run is over in less than a second, and the
    // action area itself may still be moving into place.
    await page.evaluate(() => {
      const observer = new MutationObserver(() => {
        const line = [...document.querySelectorAll('form [role="progressbar"]')].find((bar) =>
          (bar as HTMLElement).checkVisibility(),
        );
        const area = line?.closest('form');
        if (!line || !area) return;
        const lineBox = line.getBoundingClientRect();
        const areaBox = area.getBoundingClientRect();
        window.e2eProgressLine = {
          top: lineBox.top - areaBox.top,
          left: lineBox.left - areaBox.left,
          width: lineBox.width,
          areaWidth: areaBox.width,
        };
        observer.disconnect();
      });
      observer.observe(document.body, { childList: true, subtree: true });
    });
    await app.unlockWith(LARGE_PDF.password);
    await app.expectState(LARGE_PDF.name, 'done');

    const line = await page.evaluate(() => window.e2eProgressLine);
    expect(line, 'a progress line was shown').toBeDefined();
    expect(Math.abs(line!.top), 'on the top edge').toBeLessThanOrEqual(1);
    expect(line!.left, 'from the left edge').toBe(0);
    expect(line!.width, 'to the right edge').toBe(line!.areaWidth);
  });
});

for (const size of SIZES.filter((candidate) => candidate.mobile && !candidate.keyboardFrom)) {
  test.describe(`a generated password, ${size.name}`, () => {
    test.use({ ...PHONE, viewport: { width: size.width, height: size.height }, locale: 'zh-CN' });

    /** How far the text of a field reaches beyond the field: 0 when all of it is in sight. */
    const hidden = (field: Locator): Promise<number> =>
      field.evaluate((element) => Math.max(0, element.scrollWidth - element.clientWidth));

    test('is shown whole, in the form and with the results', async ({ app, page }) => {
      await app.open();
      await app.addFixtures('plain.pdf');
      await app.analysed(1);
      await app.switchMode('lock');
      await app.dock.getByRole('button', { name: app.t('lock.generate'), exact: true }).click();
      await expect(app.lockPassword).toHaveValue(/^.{16,}$/);
      await app.settled();
      expect(await hidden(app.lockPassword), 'cut off in the form').toBe(0);

      await app.press(app.dockButton('action.lock'));
      await app.expectState('plain.pdf', 'done', 'lock');
      const applied = page.locator('#lock-result-password');
      await expect(applied).toHaveValue(/^.{16,}$/);
      await app.settled();
      expect(await hidden(applied), 'cut off beside the results').toBe(0);
    });
  });
}

for (const size of SIZES) {
  for (const locale of LOCALES) {
    for (const theme of THEMES) {
      test.describe(`${size.name}, ${locale}, ${theme}`, () => {
        test.use({
          ...(size.mobile ? PHONE : DESKTOP),
          viewport: { width: size.width, height: size.keyboardFrom ?? size.height },
          locale,
          colorScheme: theme,
        });

        test('every main state keeps its layout', async ({ app, page }) => {
          await app.open();
          await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
          await check(app, 'empty', { primary: app.chooseButton });

          // --- One file --------------------------------------------------------------------
          await app.addFixtures('aes-256-r6.pdf');
          await app.expectState('aes-256-r6.pdf', 'needs-password');
          if (size.keyboardFrom) {
            // The keyboard opens under the focused field: the window loses its lower part.
            await expect(app.unlockField).toBeFocused();
            await page.setViewportSize({ width: size.width, height: size.height });
            await expect(page.locator('html')).toHaveAttribute('data-compact', '');
          }
          await check(app, 'one file that needs a password', {
            primary: app.dockButton('action.unlock'),
            field: app.unlockField,
          });

          await app.unlockWith('wrong');
          await expect(app.dock).toContainText(app.t('unlock.password.wrong'));
          await check(app, 'wrong password', {
            primary: app.dockButton('action.unlock'),
            field: app.unlockField,
          });

          await app.unlockWith('user');
          await app.expectState('aes-256-r6.pdf', 'done');
          await check(app, 'one file unlocked', { primary: app.dockButton('entry.save') });

          // --- A list: every kind of card, long names --------------------------------------
          const chooser = page.waitForEvent('filechooser');
          await app.addButton.click();
          await (
            await chooser
          ).setFiles([
            {
              name: LONG_NAMES[0],
              mimeType: 'application/pdf',
              buffer: readFileSync(fixturePath('unicode-saslprep-r6.pdf')),
            },
            {
              name: LONG_NAMES[1],
              mimeType: 'application/pdf',
              buffer: readFileSync(fixturePath('gbk-r3.pdf')),
            },
            ...['owner-only-r6.pdf', 'plain.pdf', 'damaged-unrecoverable.pdf', 'rc4-40-r2.pdf'].map(
              (name) => ({
                name,
                mimeType: 'application/pdf',
                buffer: readFileSync(fixturePath(name)),
              }),
            ),
          ]);
          await app.analysed(7);
          await check(app, 'a mixed list', {
            primary: app.dockButton('action.unlockCount', { count: 4 }),
            field: app.unlockField,
            lastCard: true,
          });

          // One password opens one of them; the two long names get retry fields on their cards.
          await app.unlockWith('user');
          await app.expectState('rc4-40-r2.pdf', 'done');
          await app.expectState(LONG_NAMES[1], 'wrong-password');
          await check(app, 'a list with results, errors and retry fields', {
            primary: app.dockButton('action.unlockCount', { count: 2 }),
            field: app.cardField(LONG_NAMES[1]),
            lastCard: true,
          });

          // --- Lock mode: the form, then with every option open ----------------------------
          await app.switchMode('lock');
          await expect(app.lockPassword).toBeVisible();
          await check(app, 'lock form', {
            primary: app.dockButton('action.lockCount', { count: 2 }),
            field: app.lockPassword,
          });
          await check(app, 'lock form, current password on a card', {
            field: app.cardField(LONG_NAMES[0]),
          });

          await app.lockPassword.fill('a password long enough to show the strength meter');
          await app.openAdvanced();
          await app.switch('lock.owner.switch', app.dock).click();
          await expect(app.ownerPassword).toBeVisible();
          await check(app, 'lock form with advanced options', {
            primary: app.dockButton('action.lockCount', { count: 2 }),
            field: app.ownerPassword,
          });
          await check(app, 'lock form, confirmation', { field: app.lockConfirmation });

          // --- Sheets and dialogs -----------------------------------------------------------
          await page.evaluate(() => window.scrollTo(0, 0));
          const settings = await app.openSettings();
          await check(app, 'settings', { dialog: settings });
          await app.closeDialog();

          const details = await app.openDetails('rc4-40-r2.pdf');
          await check(app, 'file details', { dialog: details });
          await app.closeDialog();

          await app.menuButton(LONG_NAMES[0]).click();
          const menu = page.getByRole('menu');
          await expect(menu).toBeVisible();
          await check(app, 'file menu', {});
          await expect(menu).toBeInViewport({ ratio: 1 });
        });

        // What a current Pixel offers after a batch: share, save to a folder, save as a ZIP and
        // start over, all in one row above the primary button. Once per size and language.
        if (theme === 'light' && !size.keyboardFrom) {
          test.describe('with a share sheet and a folder picker', () => {
            test.use({ filePickers: 'opfs' });

            test('the results of several files keep their layout', async ({ app, page }) => {
              await withShareSheet(page);
              await app.open();
              await app.addFixtures(
                'aes-256-r6.pdf',
                'owner-only-r6.pdf',
                'damaged-unrecoverable.pdf',
              );
              await app.analysed(3);
              await app.unlockWith('user');
              await app.expectState('aes-256-r6.pdf', 'done');
              await app.expectState('owner-only-r6.pdf', 'done');
              await expect(app.dockButton('action.shareAll')).toBeVisible();
              await expect(app.dockButton('action.saveAllFolder')).toBeVisible();
              await expect(app.dockButton('action.startOver')).toBeVisible();
              await expect(app.dock).toContainText(app.t('status.failed', { count: 1 }));
              await check(app, 'results of several files, one of them failed', {
                primary: app.dockButton('action.saveAll'),
                lastCard: true,
              });

              // One result: its own actions move into the action area.
              await app.menuCommand('owner-only-r6.pdf', 'entry.menu.remove');
              await app.menuCommand('damaged-unrecoverable.pdf', 'entry.menu.remove');
              await expect(app.dockButton('entry.share')).toBeVisible();
              await expect(app.dockButton('entry.open')).toBeVisible();
              await check(app, 'the result of one file', {
                primary: app.dockButton('entry.save'),
              });
            });
          });
        }
      });
    }
  }
}

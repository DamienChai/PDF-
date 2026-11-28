/**
 * A large file (about 30 MB, AES-256; created by support/global-setup.ts): the work happens off
 * the main thread, progress is shown while it runs, it can be cancelled, and the result is right.
 */
import { streamHashes } from '../../src/engine/test-support';
import { expect, test } from './support/app';
import { LARGE_PDF, unlockedName } from './support/files';
import { buildLargePdf } from './support/large-pdf';
import { inspectPdf, rawFacts } from './support/pdf';

interface Watch {
  /** Every progress value the page rendered, in order. */
  progress: number[];
  /** The longest time the main thread went without rendering a frame, in milliseconds. */
  longestStall: number;
}

declare global {
  interface Window {
    e2eWatch?: Watch & { stop(): Watch };
  }
}

test.describe('a large file', () => {
  // Generous: on a loaded CI machine 30 MB of AES take a while, twice.
  test.setTimeout(90_000);

  test('unlocks with visible progress and a responsive page, and can be cancelled', async ({
    app,
    page,
  }) => {
    await app.open();
    await app.addFiles([LARGE_PDF.path]);
    await app.expectState(LARGE_PDF.name, 'needs-password');
    await expect(app.card(LARGE_PDF.name)).toContainText('AES-256');
    await expect(app.card(LARGE_PDF.name)).toContainText(/30(\.\d+)? MB/);

    // Watch what the page renders while it works: progress values and stalls of the main thread.
    await page.evaluate(() => {
      const watch: Watch = { progress: [], longestStall: 0 };
      const observer = new MutationObserver(() => {
        const bar = document.querySelector('[role="progressbar"]');
        if (!bar) return;
        const value = Number(bar.getAttribute('aria-valuenow'));
        if (watch.progress[watch.progress.length - 1] !== value) watch.progress.push(value);
      });
      observer.observe(document.body, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['aria-valuenow'],
      });
      let last = performance.now();
      let running = true;
      const frame = (now: number): void => {
        watch.longestStall = Math.max(watch.longestStall, now - last);
        last = now;
        if (running) requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
      window.e2eWatch = {
        ...watch,
        stop() {
          running = false;
          observer.disconnect();
          return watch;
        },
      };
    });

    await app.unlockWith(LARGE_PDF.password);
    await app.expectState(LARGE_PDF.name, 'done');
    const watch = await page.evaluate(() => window.e2eWatch!.stop());

    // Progress was rendered step by step, never backwards: the page was alive all the time.
    const steps = watch.progress.filter((value) => value > 0 && value < 100);
    expect(steps.length, `progress values seen: ${watch.progress.join(', ')}`).toBeGreaterThan(3);
    expect([...watch.progress].sort((a, b) => a - b)).toEqual(watch.progress);
    // The engine runs in a worker: the main thread never stalls for anything like the time the
    // work takes.
    expect(watch.longestStall).toBeLessThan(1000);

    // The result: named after the input, as large as it, and correct.
    await expect(app.card(LARGE_PDF.name)).toContainText(unlockedName(LARGE_PDF.name));
    const saved = await app.saveAll();
    expect(saved.name).toBe(unlockedName(LARGE_PDF.name));
    expect(saved.bytes.length).toBeGreaterThan(LARGE_PDF.pages * LARGE_PDF.bytesPerPage);
    expect(rawFacts(saved.bytes)).toMatchObject({
      header: true,
      endMarker: true,
      encryptEntry: false,
    });
    expect(await inspectPdf(saved.bytes)).toMatchObject({
      encrypted: false,
      pageCount: LARGE_PDF.pages,
      warnings: [],
    });
    // Every image of the generated original is in the output, bit for bit.
    const original = streamHashes(buildLargePdf(LARGE_PDF.pages, LARGE_PDF.bytesPerPage));
    const produced = streamHashes(saved.bytes);
    expect(original.size).toBeGreaterThanOrEqual(LARGE_PDF.pages);
    expect([...original].filter((hash) => !produced.has(hash))).toEqual([]);

    // --- Second run: cancel in the middle ---------------------------------------------------
    await app.menuCommand(LARGE_PDF.name, 'entry.menu.redo');
    await app.expectState(LARGE_PDF.name, 'needs-password');

    // "Cancel" is pressed by the page itself the moment the first progress is rendered, so that
    // the press lands in the middle of the work however fast or slow this machine is.
    await page.evaluate((label) => {
      const observer = new MutationObserver(() => {
        const bar = document.querySelector('[role="progressbar"]');
        if (!bar || Number(bar.getAttribute('aria-valuenow')) < 5) return;
        const cancel = [...document.querySelectorAll<HTMLButtonElement>('form button')].find(
          (button) => button.textContent?.trim() === label,
        );
        if (!cancel) return;
        observer.disconnect();
        cancel.click();
        document.documentElement.setAttribute(
          'data-e2e-cancelled',
          bar.getAttribute('aria-valuenow')!,
        );
      });
      observer.observe(document.body, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['aria-valuenow'],
      });
    }, app.t('action.cancel'));

    await app.unlockWith(LARGE_PDF.password);
    await expect(page.locator('html')).toHaveAttribute('data-e2e-cancelled', /^\d+$/);
    const cancelledAt = Number(await page.locator('html').getAttribute('data-e2e-cancelled'));
    expect(cancelledAt).toBeLessThan(100);

    // Back to where it was at once: no result, the password field is ready again.
    await app.expectState(LARGE_PDF.name, 'needs-password');
    await expect(app.dockButton('entry.save')).toHaveCount(0);
    await expect(app.unlockField).toBeEditable();
    await expect(page.getByRole('progressbar')).toHaveCount(0);

    // And the engine is none the worse for it: a small file goes through right away.
    await app.addFixtures('owner-only-r6.pdf');
    await app.expectState('owner-only-r6.pdf', 'restricted');
    await app.unlockField.fill('definitely not the password');
    await app.unlockField.press('Enter');
    await app.expectState('owner-only-r6.pdf', 'done');
    await app.expectState(LARGE_PDF.name, 'wrong-password');
  });
});

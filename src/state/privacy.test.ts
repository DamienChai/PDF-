/**
 * Guards for the promise the app makes: passwords live in memory only. These tests read the
 * sources of the state layer, so that an innocent-looking addition (a debug log, a second thing
 * put into storage, a password in the address) does not go unnoticed.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEMO_PASSWORD } from '../../tests/support/fake-engine';
import { createHarness } from '../../tests/support/jobs-harness';
import { DEFAULT_SETTINGS, SETTINGS_KEY, createSettingsStore } from './settings';

const directory = new URL('./', import.meta.url);
const sources = readdirSync(directory)
  .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
  .map((name) => ({ name, code: readFileSync(new URL(name, directory), 'utf8') }));

function filesMatching(pattern: RegExp): string[] {
  return sources.filter(({ code }) => pattern.test(code)).map(({ name }) => name);
}

describe('where the state layer talks to the outside', () => {
  it('covers the whole layer', () => {
    expect(sources.map(({ name }) => name)).toEqual(
      expect.arrayContaining(['app.ts', 'jobs.ts', 'lock-form.ts', 'settings.ts', 'engine.ts']),
    );
  });

  it('only the settings module uses persistent storage', () => {
    expect(filesMatching(/\b(?:localStorage|sessionStorage|indexedDB|document\.cookie)\b/)).toEqual(
      ['settings.ts'],
    );
  });

  it('logs nothing but unexpected start-up failures', () => {
    expect(filesMatching(/\bconsole\./)).toEqual(['app.ts']);
    const app = sources.find(({ name }) => name === 'app.ts')!.code;
    expect(app.match(/\bconsole\.\w+/g)).toEqual(['console.error']);
  });

  it('never writes to the address, and makes no network requests', () => {
    expect(filesMatching(/\b(?:replaceState|location\.(?:href|search|hash)\s*=|assign\()/)).toEqual(
      [],
    );
    expect(
      filesMatching(
        /\bfetch\s*\(|\bsendBeacon\s*\(|new\s+(?:XMLHttpRequest|WebSocket|EventSource)\b/,
      ),
    ).toEqual([]);
    // The one history entry the app pushes carries a constant marker, nothing else.
    expect(filesMatching(/pushState/)).toEqual(['overlay.ts']);
  });
});

describe('what is stored', () => {
  it('is the settings and nothing else, whatever went on in the app', async () => {
    const stored = new Map<string, string>();
    const store = createSettingsStore({
      storage: {
        getItem: (key) => stored.get(key) ?? null,
        setItem: (key, value) => void stored.set(key, value),
      },
    });
    const h = createHarness({ mode: 'lock' });
    await h.add('needs-password.pdf', 'plain.pdf');
    h.jobs.setCurrentPassword(h.entry('needs-password.pdf').id, DEMO_PASSWORD);
    h.lockForm.setRevealed(true);
    h.lockForm.setPassword('a-NEW-secret-42');
    await h.jobs.lockAll();
    store.update({ autoSave: true, theme: 'dark' });

    expect([...stored.keys()]).toEqual([SETTINGS_KEY]);
    const text = stored.get(SETTINGS_KEY)!;
    expect(Object.keys(JSON.parse(text)).sort()).toEqual(Object.keys(DEFAULT_SETTINGS).sort());
    expect(text).not.toContain(DEMO_PASSWORD);
    expect(text).not.toContain('a-NEW-secret-42');
  });

  it('keeps passwords out of everything the controller exposes for display', async () => {
    const h = createHarness({ mode: 'lock' });
    await h.add('needs-password.pdf', 'aes128.pdf', 'plain.pdf');
    h.jobs.setCurrentPassword(h.entry('needs-password.pdf').id, DEMO_PASSWORD);
    h.jobs.setCurrentPassword(h.entry('aes128.pdf').id, 'wrong-CURRENT-pw');
    h.lockForm.setRevealed(true);
    h.lockForm.setPassword('a-NEW-secret-42');
    await h.jobs.lockAll();
    const shown = JSON.stringify({
      views: h.jobs.entries.value.map((entry) => [entry.view.value, entry.details.value]),
      summary: h.jobs.summary.value,
      toasts: h.toasts.toasts.value,
    });
    for (const secret of [DEMO_PASSWORD, 'wrong-CURRENT-pw', 'a-NEW-secret-42']) {
      expect(shown).not.toContain(secret);
    }
  });
});

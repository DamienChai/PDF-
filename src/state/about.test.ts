import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import {
  BUNDLED_PACKAGES,
  NOTICES_FILE,
  parseEngineComponents,
} from '../../scripts/third-party-notices';
import { APP_VERSION, OPEN_SOURCE_COMPONENTS, THIRD_PARTY_NOTICES_URL, aboutInfo } from './about';
import { installDevTools } from './dev';
import { engineState } from './engine';
import { jobs } from './jobs';

afterAll(() => {
  jobs.clear();
  engineState.dispose();
});

const packageJson = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { version: string; dependencies: Record<string, string> };

describe('about', () => {
  it('reports the version of package.json', () => {
    expect(APP_VERSION).toBe(packageJson.version);
  });

  it('lists the engine components of the build notes and the runtime libraries', () => {
    const notices = readFileSync(
      new URL('../../engine/THIRD_PARTY_NOTICES.md', import.meta.url),
      'utf8',
    );
    const names = OPEN_SOURCE_COMPONENTS.map((component) => component.name);
    expect(names).toEqual(expect.arrayContaining(['qpdf', 'zlib', 'Preact', 'Preact Signals']));
    expect(new Set(names).size).toBe(names.length);
    for (const component of OPEN_SOURCE_COMPONENTS) {
      expect(component.license, component.name).not.toBe('');
    }
    const qpdf = OPEN_SOURCE_COMPONENTS.find((component) => component.name === 'qpdf')!;
    expect(qpdf.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(notices).toContain(`| ${qpdf.version}`);
    expect(notices).toContain('Apache-2.0');
    // Every runtime dependency of the app is credited.
    expect(Object.keys(packageJson.dependencies).sort()).toEqual(['@preact/signals', 'preact']);
  });

  it('names every component the notices file covers, with the same versions', () => {
    const listed = (pattern: RegExp) =>
      OPEN_SOURCE_COMPONENTS.find((component) => pattern.test(component.name));
    const notices = readFileSync(
      new URL('../../engine/THIRD_PARTY_NOTICES.md', import.meta.url),
      'utf8',
    );
    // The first word of a component of the engine's notices is its name here.
    for (const component of parseEngineComponents(notices)) {
      const word = /^\w+/.exec(component.name)![0];
      const shown = listed(new RegExp(`^${word}\\b`, 'i'));
      expect(shown, component.name).toBeDefined();
      if (shown!.version !== '') expect(shown!.version, component.name).toBe(component.version);
    }
    const families: [pattern: RegExp, name: string][] = [
      [/^preact$/, 'Preact'],
      [/^@preact\/signals/, 'Preact Signals'],
      [/^workbox-/, 'Workbox'],
      [/^(?:vite|rolldown)$/, 'Vite / Rolldown'],
    ];
    for (const name of BUNDLED_PACKAGES) {
      const family = families.find(([pattern]) => pattern.test(name));
      expect(family, name).toBeDefined();
      expect(OPEN_SOURCE_COMPONENTS.map((component) => component.name)).toContain(family![1]);
    }
    expect(THIRD_PARTY_NOTICES_URL).toBe(`./${NOTICES_FILE}`);
  });

  it('follows the engine: nothing loaded at first, the qpdf version once it is', async () => {
    expect(aboutInfo.value).toEqual({
      appVersion: packageJson.version,
      engineStatus: 'idle',
      qpdfVersion: null,
      compatibilityMode: false,
    });
    await engineState.load();
    const qpdf = OPEN_SOURCE_COMPONENTS.find((component) => component.name === 'qpdf')!;
    expect(aboutInfo.value).toEqual({
      appVersion: packageJson.version,
      engineStatus: 'ready',
      // The version the engine reports is the one the build notes name.
      qpdfVersion: qpdf.version,
      // Node has no Web Workers.
      compatibilityMode: true,
    });
  });
});

describe('development tools', () => {
  it('expose the state modules and load the requested demo files', async () => {
    const tools = installDevTools('?fake&demo=plain.pdf,needs-password.pdf');
    expect((globalThis as { __pdfkey?: unknown }).__pdfkey).toBe(tools);
    expect(tools.jobs).toBe(jobs);
    expect(tools.demo.names).toContain('slow.pdf');
    await jobs.settled();
    expect(jobs.entries.value.map((entry) => [entry.name, entry.source])).toEqual([
      ['plain.pdf', 'demo'],
      ['needs-password.pdf', 'demo'],
    ]);
    // Outside a `?fake` page the real engine is at work, and to it both are ordinary PDFs.
    expect(jobs.entries.value.map((entry) => entry.view.value.state)).toEqual([
      'not-encrypted',
      'not-encrypted',
    ]);
  });

  it('load nothing without the demo parameter', async () => {
    jobs.clear();
    installDevTools('?fake');
    await jobs.settled();
    expect(jobs.entries.value).toEqual([]);
  });
});

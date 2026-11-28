/**
 * The notices of the third-party code a build distributes, as one plain-text file.
 *
 * Nothing is written by hand here. The engine's part comes from engine/THIRD_PARTY_NOTICES.md
 * (checked against the versions in src/engine/dist/BUILDINFO.json), the JavaScript part from the
 * LICENSE files and package.json of the installed packages, i.e. of exactly what is bundled.
 * vite.config.ts emits the result as `licenses.txt` and fails the build when a chunk contains
 * code of a package that is not listed in `BUNDLED_PACKAGES`.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** Name of the shipped file, next to index.html. Repeated in src/state/about.ts. */
export const NOTICES_FILE = 'licenses.txt';

/**
 * npm packages with code in the build output: the UI libraries, the Workbox modules of the
 * service worker, and the bundler, whose module-loading helpers end up in the main chunk.
 */
export const BUNDLED_PACKAGES = [
  'preact',
  '@preact/signals',
  '@preact/signals-core',
  'workbox-core',
  'workbox-precaching',
  'workbox-routing',
  'workbox-strategies',
  'vite',
  'rolldown',
] as const;

/** Where each kind of bundled code is, for the list at the top of the file. */
const PACKAGE_ROLES: Readonly<Record<(typeof BUNDLED_PACKAGES)[number], string>> = {
  preact: 'user interface',
  '@preact/signals': 'user interface',
  '@preact/signals-core': 'user interface',
  'workbox-core': 'service worker',
  'workbox-precaching': 'service worker',
  'workbox-routing': 'service worker',
  'workbox-strategies': 'service worker',
  vite: 'module loading helpers',
  rolldown: 'module loading helpers',
};

/** Vite's licence file goes on with the licences of what the tool itself bundles. */
const VITE_BUNDLED_DEPENDENCIES = /^# Licenses of bundled dependencies$/m;

/** Sets a component's section off; unlike the rules inside the licence texts themselves. */
const RULE = '*'.repeat(78);

export interface EngineComponent {
  name: string;
  version: string;
  license: string;
  source: string;
}

export interface NpmComponent {
  name: string;
  version: string;
  license: string;
  homepage: string;
  role: string;
  /** The package's licence file, as published. */
  text: string;
}

/**
 * The package a module of a bundle belongs to; null for the project's own files. Virtual modules
 * of the bundler (`\0vite/preload-helper.js`) count as the bundler's code, which they are.
 */
export function packageOfModule(id: string): string | null {
  const virtual = /^\0(vite|rolldown)\//.exec(id);
  if (virtual) return virtual[1]!;
  const normalized = id.replaceAll('\\', '/');
  const at = normalized.lastIndexOf('/node_modules/');
  if (at < 0) return id.startsWith('\0') ? id : null;
  const [first = '', second = ''] = normalized.slice(at + '/node_modules/'.length).split('/');
  return first.startsWith('@') ? `${first}/${second}` : first;
}

function read(root: string, ...segments: string[]): string {
  return readFileSync(path.join(root, ...segments), 'utf8');
}

function trimBlankLines(text: string): string {
  return text.replace(/^(?:[ \t]*\n)+/, '').replace(/\s+$/, '');
}

/** The component table of engine/THIRD_PARTY_NOTICES.md. */
export function parseEngineComponents(markdown: string): EngineComponent[] {
  const rows = markdown
    .split('\n')
    .filter((line) => line.startsWith('|'))
    .map((line) =>
      line
        .slice(1, line.lastIndexOf('|'))
        .split('|')
        .map((cell) => cell.trim()),
    )
    // Header and separator.
    .slice(2);
  return rows.map(([name = '', version = '', license = '', source = '']) => ({
    name,
    version,
    license,
    source,
  }));
}

/** Fails when the notices name another version than the engine was built from. */
function checkEngineVersions(components: readonly EngineComponent[], root: string): void {
  const built = JSON.parse(read(root, 'src/engine/dist/BUILDINFO.json')) as Record<string, unknown>;
  const expected: [pattern: RegExp, key: string][] = [
    [/^qpdf\b/, 'qpdf'],
    [/^zlib\b/, 'zlib'],
    [/^libjpeg\b/, 'jpeg'],
    [/^Emscripten\b/, 'emscripten'],
  ];
  for (const [pattern, key] of expected) {
    const component = components.find((candidate) => pattern.test(candidate.name));
    if (!component) {
      throw new Error(`engine/THIRD_PARTY_NOTICES.md does not list ${key}`);
    }
    if (component.version !== built[key]) {
      throw new Error(
        `engine/THIRD_PARTY_NOTICES.md names ${component.name} ${component.version}, ` +
          `but the engine was built from ${String(built[key])} (BUILDINFO.json)`,
      );
    }
  }
}

/** Markdown of the notices as plain text: headings underlined, code fences dropped. */
function markdownToText(markdown: string): string {
  const lines: string[] = [];
  for (const line of markdown.split('\n')) {
    if (line.trim() === '```') continue;
    const heading = /^(#{2,3}) (.+)$/.exec(line);
    if (!heading) {
      lines.push(line);
    } else if (heading[1] === '##') {
      lines.push(RULE, heading[2]!, RULE);
    } else {
      lines.push(heading[2]!, '-'.repeat(heading[2]!.length));
    }
  }
  return trimBlankLines(lines.join('\n').replace(/\n{3,}/g, '\n\n'));
}

function readNpmComponent(root: string, name: (typeof BUNDLED_PACKAGES)[number]): NpmComponent {
  const directory = path.join(root, 'node_modules', name);
  const manifest = JSON.parse(read(directory, 'package.json')) as {
    version: string;
    license?: string;
    homepage?: string;
    repository?: string | { url?: string };
  };
  const file = ['LICENSE', 'LICENSE.md', 'LICENSE.txt'].find((candidate) =>
    existsSync(path.join(directory, candidate)),
  );
  if (!file || !manifest.license) {
    throw new Error(`${name}: no licence file or no licence in its package.json`);
  }
  let text = read(directory, file);
  if (name === 'vite') {
    const end = VITE_BUNDLED_DEPENDENCIES.exec(text);
    if (!end) throw new Error('vite: the layout of its licence file has changed');
    text = text.slice(0, end.index).replace(/^# .*\n/, '');
  }
  const repository =
    typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url;
  const homepage = (manifest.homepage ?? repository ?? `https://www.npmjs.com/package/${name}`)
    .replace(/^git\+/, '')
    .replace(/\.git$/, '');
  return {
    name,
    version: manifest.version,
    license: manifest.license,
    homepage,
    role: PACKAGE_ROLES[name],
    text: trimBlankLines(text.replaceAll('\r\n', '\n')),
  };
}

export function readNpmComponents(root: string): NpmComponent[] {
  return BUNDLED_PACKAGES.map((name) => readNpmComponent(root, name));
}

/** "name version" on one line, licence and origin on the next: readable on a narrow screen. */
function listing(
  components: readonly { name: string; version: string; license: string }[],
  origin: (index: number) => string,
): string[] {
  return components.flatMap((component, index) => [
    `  ${component.name} ${component.version}`.trimEnd(),
    `      ${component.license}, ${origin(index)}`,
  ]);
}

/** The complete text of `licenses.txt` for the project at `root`. */
export function buildNotices(root: string): string {
  const app = JSON.parse(read(root, 'package.json')) as { version: string };
  const markdown = read(root, 'engine/THIRD_PARTY_NOTICES.md').replaceAll('\r\n', '\n');
  const engine = parseEngineComponents(markdown);
  checkEngineVersions(engine, root);
  const npm = readNpmComponents(root);

  const firstSection = markdown.indexOf('\n## ');
  const tableEnd = markdown.lastIndexOf('\n|', firstSection);
  if (firstSection < 0 || tableEnd < 0) {
    throw new Error('engine/THIRD_PARTY_NOTICES.md: component table or sections not found');
  }
  // Between the table and the first section: what was changed, and the acknowledgement the
  // Independent JPEG Group asks for.
  const remarks = trimBlankLines(
    markdown.slice(markdown.indexOf('\n', tableEnd + 1), firstSection),
  );

  // Packages published with the same licence file share one copy of it.
  const texts = new Map<string, NpmComponent[]>();
  for (const component of npm) {
    const group = texts.get(component.text);
    if (group) group.push(component);
    else texts.set(component.text, [component]);
  }

  const title = `PDF Key ${app.version}: third-party notices`;
  const out: string[] = [
    title,
    '='.repeat(title.length),
    '',
    'PDF Key contains the open-source software listed here. This file reproduces the',
    'copyright notices and licence texts under which that software is distributed.',
    '',
    'PDF engine (the WebAssembly module and its JavaScript glue):',
    '',
    ...listing(engine, (index) => engine[index]!.source),
    '',
    remarks,
    '',
    'Application and service worker (JavaScript):',
    '',
    ...listing(npm, (index) => `${npm[index]!.homepage} (${npm[index]!.role})`),
    '',
    markdownToText(markdown.slice(firstSection + 1)),
    '',
  ];
  for (const [text, group] of texts) {
    out.push(
      RULE,
      group.map((component) => `${component.name} ${component.version}`).join(', '),
      RULE,
      '',
      text,
      '',
    );
  }
  // The byte order mark makes every browser read the file as UTF-8, whatever the server says.
  return `﻿${out.join('\n')}`;
}

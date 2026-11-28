/**
 * licenses.txt, the notices file every build ships: complete for what the build contains, and in
 * step with the versions that are actually built in.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  BUNDLED_PACKAGES,
  buildNotices,
  packageOfModule,
  parseEngineComponents,
  readNpmComponents,
} from '../../scripts/third-party-notices';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

function readJson<T>(...segments: string[]): T {
  return JSON.parse(readFileSync(path.join(ROOT, ...segments), 'utf8')) as T;
}

interface PackageManifest {
  version: string;
  dependencies?: Record<string, string>;
}

/** `names` and everything they depend on at run time, as installed. */
function withDependencies(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const visit = (name: string): void => {
    if (seen.has(name)) return;
    seen.add(name);
    const manifest = readJson<PackageManifest>('node_modules', name, 'package.json');
    Object.keys(manifest.dependencies ?? {}).forEach(visit);
  };
  names.forEach(visit);
  return [...seen].sort();
}

const notices = buildNotices(ROOT);

const scratch: string[] = [];
afterAll(() => {
  for (const directory of scratch) rmSync(directory, { recursive: true, force: true });
});

/** A copy of what the generator reads, for trying out a tree that has drifted. */
function copyOfProject(): string {
  const copy = mkdtempSync(path.join(tmpdir(), 'pdfkey-notices-'));
  scratch.push(copy);
  for (const file of [
    'package.json',
    'engine/THIRD_PARTY_NOTICES.md',
    'src/engine/dist/BUILDINFO.json',
  ]) {
    cpSync(path.join(ROOT, file), path.join(copy, file), { recursive: true });
  }
  symlinkSync(path.join(ROOT, 'node_modules'), path.join(copy, 'node_modules'), 'dir');
  return copy;
}

describe('the notices file', () => {
  it('is plain text that every browser reads as UTF-8', () => {
    expect(notices.startsWith('\uFEFF')).toBe(true);
    expect(notices).not.toMatch(/^```/m);
    expect(notices).not.toMatch(/^#{1,6} /m);
    expect(notices).not.toContain('\r');
    const app = readJson<PackageManifest>('package.json');
    expect(notices.slice(1).split('\n')[0]).toBe(`PDF Key ${app.version}: third-party notices`);
  });

  it('names the engine components with the versions the engine was built from', () => {
    const built = readJson<Record<string, string>>('src/engine/dist/BUILDINFO.json');
    for (const line of [
      `  qpdf ${built.qpdf}`,
      `  zlib ${built.zlib}`,
      `  libjpeg (Independent JPEG Group) ${built.jpeg}`,
      `  Emscripten runtime and JavaScript glue ${built.emscripten}`,
    ]) {
      expect(notices.split('\n'), line).toContain(line);
    }
    const components = parseEngineComponents(
      readFileSync(path.join(ROOT, 'engine/THIRD_PARTY_NOTICES.md'), 'utf8'),
    );
    expect(components.map((component) => component.name)).toEqual([
      'qpdf',
      'zlib',
      'libjpeg (Independent JPEG Group)',
      'Emscripten runtime and JavaScript glue',
      'musl libc (as shipped with Emscripten)',
      'LLVM libc++, libc++abi, libunwind, compiler-rt (as shipped with Emscripten)',
      'dlmalloc (as shipped with Emscripten)',
    ]);
    for (const component of components) {
      expect(notices, component.name).toContain(`  ${component.name} ${component.version}`.trim());
    }
  });

  it('carries the notices and licence texts of the engine', () => {
    for (const text of [
      // The acknowledgement the IJG licence asks for.
      'This software is based in part on the work of the Independent JPEG Group.',
      // qpdf: its NOTICE and the licence it refers to.
      'qpdf is copyright (c) 2005-2021 Jay Berkenbilt',
      'Copyright (c) 2007-2011 Projet RNRT SAPHIR',
      'Apache License\n                           Version 2.0, January 2004',
      'TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION',
      'END OF TERMS AND CONDITIONS',
      // zlib
      'Jean-loup Gailly and Mark Adler',
      'Altered source versions must be plainly marked as such',
      // libjpeg
      'This software is copyright (C) 1991-2024, Thomas G. Lane, Guido Vollbeding.',
      'the accompanying\ndocumentation must state that "this software is based in part on the work of\nthe Independent JPEG Group"',
      // Emscripten: MIT and NCSA
      'Emscripten is available under 2 licenses, the MIT license and the\nUniversity of Illinois/NCSA Open Source License.',
      'Copyright (c) 2010-2014 Emscripten authors, see AUTHORS file.',
      'Redistributions in binary form must reproduce the above',
      // musl
      'Copyright © 2005-2020 Rich Felker, et al.',
      // LLVM runtime libraries
      '---- LLVM Exceptions to the Apache 2.0 License ----',
      // dlmalloc
      "Doug Lea's malloc, version 2.8.6, released to the public domain",
    ]) {
      expect(notices, text).toContain(text);
    }
    for (const heading of [
      'qpdf',
      'zlib',
      'libjpeg',
      'Emscripten',
      'musl libc',
      'LLVM runtime libraries (libc++, libc++abi, libunwind, compiler-rt)',
      'dlmalloc',
    ]) {
      expect(notices, heading).toContain(`${'*'.repeat(78)}\n${heading}\n${'*'.repeat(78)}\n`);
    }
  });

  it('carries the licence file of every bundled npm package, with the installed version', () => {
    const components = readNpmComponents(ROOT);
    expect(components.map((component) => component.name)).toEqual([...BUNDLED_PACKAGES]);
    for (const component of components) {
      const installed = readJson<PackageManifest>('node_modules', component.name, 'package.json');
      expect(component.version).toBe(installed.version);
      expect(component.license, component.name).toBe('MIT');
      expect(component.text, component.name).toContain(
        'Permission is hereby granted, free of charge',
      );
      expect(component.text, component.name).toMatch(/^Copyright /m);
      expect(notices, component.name).toContain(component.text);
      expect(notices, component.name).toContain(`  ${component.name} ${component.version}\n`);
    }
    for (const holder of [
      'Copyright (c) 2015-present Jason Miller',
      'Copyright (c) 2022-present Preact Team',
      'Copyright 2018 Google LLC',
      'Copyright (c) 2019-present, VoidZero Inc. and Vite contributors',
      'Copyright (c) 2024-present VoidZero Inc. & Contributors',
    ]) {
      expect(notices, holder).toContain(holder);
    }
    // Of Vite only its own licence: what the tool bundles for itself is not in the app.
    expect(notices).not.toContain('Bundled dependencies');
    expect(notices.length).toBeLessThan(60_000);
  });

  it('covers every package the app and the service worker pull in', () => {
    const app = readJson<PackageManifest>('package.json');
    const worker = readFileSync(path.join(ROOT, 'src/pwa/sw.ts'), 'utf8');
    const imported = [...worker.matchAll(/from '(workbox-[\w-]+)'/g)].map((match) => match[1]!);
    expect(imported.length).toBeGreaterThan(0);
    const needed = withDependencies([...Object.keys(app.dependencies ?? {}), ...imported]);
    expect(
      needed.filter((name) => !(BUNDLED_PACKAGES as readonly string[]).includes(name)),
    ).toEqual([]);
  });

  it('refuses to be built when the notices name another version than the engine has', () => {
    const copy = copyOfProject();
    const file = path.join(copy, 'src/engine/dist/BUILDINFO.json');
    const built = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(buildNotices(copy)).toBe(notices);
    for (const key of ['qpdf', 'zlib', 'jpeg', 'emscripten']) {
      writeFileSync(file, JSON.stringify({ ...built, [key]: '99.0' }));
      expect(() => buildNotices(copy), key).toThrow(/BUILDINFO\.json/);
    }
  });

  it('refuses to be built without a component of the engine', () => {
    const copy = copyOfProject();
    const file = path.join(copy, 'engine/THIRD_PARTY_NOTICES.md');
    const markdown = readFileSync(file, 'utf8');
    writeFileSync(file, markdown.replace(/^\| zlib .*\n/m, ''));
    expect(() => buildNotices(copy)).toThrow(/does not list zlib/);
  });
});

describe('packageOfModule', () => {
  it('tells the project from its dependencies and from the bundler', () => {
    expect(packageOfModule('/work/app/src/main.tsx')).toBeNull();
    expect(packageOfModule('/work/app/package.json')).toBeNull();
    expect(packageOfModule('/work/app/src/engine/dist/pdfx.mjs')).toBeNull();
    expect(packageOfModule('/work/app/node_modules/preact/dist/preact.mjs')).toBe('preact');
    expect(packageOfModule('/work/app/node_modules/@preact/signals/dist/signals.module.js')).toBe(
      '@preact/signals',
    );
    expect(packageOfModule('C:\\work\\app\\node_modules\\workbox-core\\_version.js')).toBe(
      'workbox-core',
    );
    // A nested copy belongs to the package it is, not to the one that brought it.
    expect(packageOfModule('/work/app/node_modules/a/node_modules/@b/c/index.js')).toBe('@b/c');
    expect(packageOfModule('\0vite/preload-helper.js')).toBe('vite');
    expect(packageOfModule('\0rolldown/runtime.js')).toBe('rolldown');
    // Code from nowhere in particular is nobody's until someone decides.
    expect(packageOfModule('\0some-plugin:helper')).toBe('\0some-plugin:helper');
  });
});

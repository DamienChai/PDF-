/** What the About section shows besides translated text. */
import { computed, type ReadonlySignal } from '@preact/signals';
// Named imports: only these values end up in the bundle, not the whole files.
import { version } from '../../package.json';
import { emscripten, jpeg, qpdf, zlib } from '../engine/dist/BUILDINFO.json';
import { engineState, type EngineStatus } from './engine';

/** Version of the app, from package.json. */
export const APP_VERSION: string = version;

export interface OpenSourceComponent {
  name: string;
  /** Empty when the version is not tracked (libraries bundled by the build). */
  version: string;
  /** SPDX licence expression, or the common name where there is none. */
  license: string;
  url: string;
}

/** Licence of the app itself. */
export const APP_LICENSE = 'AGPL-3.0-or-later';

/**
 * Third-party code that is part of what the app ships: the engine's components (see
 * engine/THIRD_PARTY_NOTICES.md) and the JavaScript libraries.
 */
export const OPEN_SOURCE_COMPONENTS: readonly OpenSourceComponent[] = [
  { name: 'qpdf', version: qpdf, license: 'Apache-2.0', url: 'https://qpdf.org/' },
  { name: 'zlib', version: zlib, license: 'Zlib', url: 'https://zlib.net/' },
  { name: 'libjpeg (IJG)', version: jpeg, license: 'IJG', url: 'https://www.ijg.org/' },
  {
    name: 'Emscripten',
    version: emscripten,
    license: 'MIT OR NCSA',
    url: 'https://emscripten.org/',
  },
  { name: 'musl libc', version: '', license: 'MIT', url: 'https://musl.libc.org/' },
  {
    name: 'LLVM libc++ / compiler-rt',
    version: '',
    license: 'Apache-2.0 WITH LLVM-exception',
    url: 'https://llvm.org/',
  },
  { name: 'Preact', version: '', license: 'MIT', url: 'https://preactjs.com/' },
  {
    name: 'Preact Signals',
    version: '',
    license: 'MIT',
    url: 'https://github.com/preactjs/signals',
  },
  {
    name: 'Workbox',
    version: '',
    license: 'MIT',
    url: 'https://developer.chrome.com/docs/workbox',
  },
];

export interface AboutInfo {
  appVersion: string;
  engineStatus: EngineStatus;
  /** Version of the qpdf library inside the engine; null until the engine is loaded. */
  qpdfVersion: string | null;
  /** The engine runs on the main thread because workers are unavailable (slower, may stutter). */
  compatibilityMode: boolean;
}

export const aboutInfo: ReadonlySignal<AboutInfo> = computed(() => ({
  appVersion: APP_VERSION,
  engineStatus: engineState.status.value,
  qpdfVersion: engineState.info.value?.qpdfVersion ?? null,
  compatibilityMode: engineState.info.value?.mode === 'main-thread',
}));

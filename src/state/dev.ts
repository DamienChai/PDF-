/**
 * Development helpers. Loaded only by a development build opened with `?fake` (see app.ts): the
 * import is behind `import.meta.env.DEV`, so nothing of this file is in a production build.
 *
 *   ?fake&demo                       load every demo file at start
 *   ?fake&demo=plain.pdf,slow.pdf    load these
 *   window.__pdfkey                  the state modules, for the console and for screenshots
 */
import {
  DEMO_FILE_NAMES,
  DEMO_OWNER_PASSWORD,
  DEMO_PASSWORD,
  createDemoFile,
  createDemoFiles,
  demoFileNamesFromUrl,
} from '../../tests/support/fake-engine';
import { engineState } from './engine';
import { jobs } from './jobs';
import { lockForm } from './lock-form';
import { mode, setMode } from './mode';
import { settingsStore } from './settings';
import { toasts } from './toasts';

export interface DevTools {
  jobs: typeof jobs;
  lockForm: typeof lockForm;
  settings: typeof settingsStore;
  toasts: typeof toasts;
  engine: typeof engineState;
  mode: typeof mode;
  setMode: typeof setMode;
  demo: {
    names: readonly string[];
    password: string;
    ownerPassword: string;
    createFile: typeof createDemoFile;
    /** Adds demo files to the list; all of them without arguments. */
    add(...names: string[]): Promise<void>;
  };
}

export function installDevTools(search: string): DevTools {
  const tools: DevTools = {
    jobs,
    lockForm,
    settings: settingsStore,
    toasts,
    engine: engineState,
    mode,
    setMode,
    demo: {
      names: DEMO_FILE_NAMES,
      password: DEMO_PASSWORD,
      ownerPassword: DEMO_OWNER_PASSWORD,
      createFile: createDemoFile,
      async add(...names) {
        await jobs.addFiles(createDemoFiles(names.length > 0 ? names : DEMO_FILE_NAMES), 'demo');
      },
    },
  };
  (globalThis as { __pdfkey?: DevTools }).__pdfkey = tools;
  const requested = demoFileNamesFromUrl(new URLSearchParams(search));
  if (requested.length > 0) void tools.demo.add(...requested);
  return tools;
}

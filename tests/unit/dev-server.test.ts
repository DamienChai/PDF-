/**
 * The development server: `npx vite` must start cleanly. Its dependency scan follows every HTML
 * file under the project root unless the configuration names the entries.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger, createServer } from 'vite';
import { expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

it('starts with a dependency scan that finds the app and nothing else', async () => {
  // A cache of its own: a cold start every time, and no interference with a running dev server.
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'pdfkey-vite-'));
  const messages: string[] = [];
  const logger = createLogger('info', { allowClearScreen: false });
  for (const level of ['info', 'warn', 'warnOnce', 'error'] as const) {
    logger[level] = (message: string) => void messages.push(message);
  }
  const server = await createServer({
    root: ROOT,
    configFile: path.join(ROOT, 'vite.config.ts'),
    cacheDir,
    customLogger: logger,
    server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: null },
  });
  try {
    await server.listen();
    const optimizer = server.environments.client.depsOptimizer;
    expect(optimizer).toBeDefined();
    await optimizer!.scanProcessing;
    const log = messages.join('\n');
    expect(log).not.toMatch(/Failed to run dependency scan|could not be resolved/);
    // The scan did run and found what the app imports.
    expect(Object.keys(optimizer!.metadata.discovered).sort()).toEqual(
      expect.arrayContaining(['@preact/signals', 'preact']),
    );
  } finally {
    await server.close();
    await rm(cacheDir, { recursive: true, force: true });
  }
});

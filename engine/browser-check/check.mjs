#!/usr/bin/env node
// Real-browser check of the engine, independent of the application.
//
//   node engine/browser-check/check.mjs            # everything
//   node engine/browser-check/check.mjs prod       # one section: prod | mime | csp | noworker | dev
//
// Builds the tiny page in ./app with the repository's Vite (production build, base './'), serves
// it and drives it with Playwright's Chromium: real module workers, real FileReaderSync on File
// objects, real Blob output. It also covers what cannot be tested in Node: the fingerprinted
// worker and .wasm assets resolving under a sub-path, a server with the wrong MIME type for .wasm,
// a Content-Security-Policy, missing or blocked workers (main-thread fallback), a missing .wasm,
// and the Vite dev server. Nothing outside engine/build/ is written.
//
// If tests/fixtures/large/aes-256-100.pdf exists (created by `node engine/bench.mjs`), a 100 MB
// file is decrypted, aborted mid-run and processed four times in parallel as well.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { build, createServer } from 'vite';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const fixtures = path.join(repo, 'tests/fixtures');
const dist = path.join(repo, 'engine/build/browser-check');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm' };

const viteConfig = {
  configFile: false,
  root: path.join(here, 'app'),
  base: './',
  logLevel: 'warn',
  resolve: { alias: { '@engine': path.join(repo, 'src/engine/index.ts') } },
  build: { outDir: dist, emptyOutDir: true, target: 'es2022', sourcemap: false },
  worker: { format: 'es' },
  server: { fs: { allow: [repo] }, port: 5199, strictPort: true, host: '127.0.0.1' },
};

function serve(root, { wasmMime = 'application/wasm', subPath = '', csp = '' } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    requests.push(url.pathname);
    let rel = url.pathname;
    if (subPath && rel.startsWith(subPath)) rel = rel.slice(subPath.length);
    const file = path.join(root, rel === '/' || rel === '' ? 'index.html' : rel);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end('not found');
      return;
    }
    const ext = path.extname(file);
    const headers = {
      'content-type': ext === '.wasm' ? wasmMime : (MIME[ext] ?? 'application/octet-stream'),
    };
    if (csp) headers['content-security-policy'] = csp;
    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ server, requests, port: server.address().port })),
  );
}

const results = [];
function check(name, condition, detail = '') {
  results.push({ name, ok: Boolean(condition) });
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`);
}

async function withPage(browser, url, init, body) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const problems = [];
  const external = [];
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('request', (r) => {
    if (
      !r.url().startsWith(new URL(url).origin) &&
      !r.url().startsWith('blob:') &&
      !r.url().startsWith('data:')
    )
      external.push(r.url());
  });
  if (init) await page.addInitScript(init);
  await page.goto(url);
  await page.waitForFunction(() => 'engineCheck' in window);
  try {
    await body(page, problems);
  } finally {
    check(`  no page errors`, problems.length === 0, problems.join(' | '));
    check(`  no requests to other origins`, external.length === 0, external.join(' '));
    await context.close();
  }
}

const browser = await chromium.launch();
console.log(`chromium ${browser.version()}`);
const mode = process.argv[2] ?? 'all';

if (mode !== 'dev') {
  await build(viteConfig);
  const emitted = fs.readdirSync(path.join(dist, 'assets'));
  console.log(
    `built: ${emitted.map((f) => `${f} (${fs.statSync(path.join(dist, 'assets', f)).size} B)`).join(', ')}`,
  );
}

// --- 1. production build, served from a sub-path with relative URLs ---------------------------
if (mode === 'all' || mode === 'prod') {
  const { server, requests, port } = await serve(dist, { subPath: '/some/sub/path' });
  console.log('\n[production build, served under /some/sub/path/]');
  await withPage(browser, `http://127.0.0.1:${port}/some/sub/path/`, null, async (page) => {
    const ready = await page.evaluate(() => window.engineCheck.ready());
    check(
      'ready() in worker mode',
      ready.mode === 'worker' && ready.qpdfVersion === '12.4.2' && ready.concurrency === 2,
      JSON.stringify(ready),
    );

    await page.setInputFiles('#file', path.join(fixtures, 'aes-256-r6.pdf'));
    const locked = await page.evaluate(() => window.engineCheck.inspect());
    check(
      'inspect without password: locked, AES-256',
      locked.access === 'locked' &&
        locked.encryption?.algorithm === 'aes-256' &&
        locked.pageCount === null,
    );
    const opened = await page.evaluate(() => window.engineCheck.inspect('user'));
    check(
      'inspect with password: user access, 4 pages',
      opened.access === 'user' && opened.pageCount === 4,
    );
    const wrong = await page.evaluate(() => window.engineCheck.decrypt('wrong'));
    check('decrypt with wrong password: password-incorrect', wrong.error === 'password-incorrect');
    const decrypted = await page.evaluate(() => window.engineCheck.decrypt('user'));
    check(
      'decrypt: verified, right size and type',
      decrypted.verified &&
        decrypted.blobSize === decrypted.outputSize &&
        decrypted.blobType === 'application/pdf' &&
        decrypted.pageCount === 4 &&
        decrypted.afterEncrypted === false &&
        decrypted.afterPages === 4,
      JSON.stringify(decrypted),
    );
    check(
      'decrypt: progress monotonic, ends at 1',
      decrypted.monotonic && decrypted.progressLast === 1 && decrypted.progressCount > 2,
    );

    await page.setInputFiles('#file', path.join(fixtures, 'gbk-r3.pdf'));
    const gbk = await page.evaluate(() => window.engineCheck.inspect('中文密码'));
    check(
      'GBK-encoded password opens (TextDecoder reverse tables in the worker)',
      gbk.access === 'user',
      gbk.access,
    );

    await page.setInputFiles('#file', path.join(fixtures, 'plain.pdf'));
    const roundTrip = await page.evaluate(() => window.engineCheck.encryptRoundTrip(''));
    check(
      'encrypt -> inspect -> decrypt round trip',
      roundTrip.locked === 'locked' &&
        roundTrip.algorithm === 'aes-256' &&
        roundTrip.asUser === 'user' &&
        roundTrip.pages === 4 &&
        roundTrip.backAccess === 'owner',
      JSON.stringify(roundTrip),
    );

    await page.setInputFiles('#file', path.join(fixtures, 'not-a-pdf.bin'));
    const notPdf = await page.evaluate(() => window.engineCheck.inspect());
    check('non-PDF: not-pdf', notPdf.error === 'not-pdf');

    const large = path.join(fixtures, 'large/aes-256-100.pdf');
    if (fs.existsSync(large)) {
      await page.setInputFiles('#file', large);
      const first = await page.evaluate(() => window.engineCheck.decrypt('bench-user', false));
      const second = await page.evaluate(() => window.engineCheck.decrypt('bench-user', false));
      const mb = first.inputSize / 1048576;
      check(
        '100 MB file decrypts in a worker',
        first.verified && first.pageCount === 100,
        `${first.durationMs.toFixed(0)} ms cold, ${second.durationMs.toFixed(0)} ms warm = ${(mb / (second.durationMs / 1000)).toFixed(1)} MB/s incl. verification`,
      );
      const aborted = await page.evaluate(() => window.engineCheck.abort('bench-user', 150));
      check(
        'abort mid-run: cancelled quickly, engine usable again',
        aborted.outcome.error === 'cancelled' &&
          aborted.settledMs < 400 &&
          aborted.next.access === 'user',
        JSON.stringify({
          outcome: aborted.outcome,
          settledMs: Math.round(aborted.settledMs),
          next: aborted.next.access,
        }),
      );
      const parallel = await page.evaluate(() => window.engineCheck.parallel('bench-user', 4));
      check(
        '4 overlapping jobs on 2 workers',
        parallel.results.every((n) => n === 100),
        `${parallel.wallMs.toFixed(0)} ms for 4 x 100 MB`,
      );
      const heap = await page.evaluate(() =>
        performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
      );
      console.log(`     main-thread JS heap after the large jobs: ${heap} MB`);
    }
  });
  const assets = [...new Set(requests)].filter((r) => r.includes('/assets/'));
  check(
    '  assets fetched relative to the sub-path',
    assets.length >= 3 && assets.every((r) => r.startsWith('/some/sub/path/assets/')),
    assets.map((a) => path.basename(a)).join(' '),
  );
  check(
    '  wasm fetched once per worker at most',
    requests.filter((r) => r.endsWith('.wasm')).length <= 4,
    `${requests.filter((r) => r.endsWith('.wasm')).length} wasm requests`,
  );
  server.close();
}

// --- 2. wasm served with the wrong MIME type: streaming compilation is refused ---------------
if (mode === 'all' || mode === 'mime') {
  const { server, port } = await serve(dist, { wasmMime: 'application/octet-stream' });
  console.log('\n[production build, .wasm served as application/octet-stream]');
  await withPage(browser, `http://127.0.0.1:${port}/`, null, async (page, problems) => {
    await page.setInputFiles('#file', path.join(fixtures, 'aes-128-r4.pdf'));
    const decrypted = await page.evaluate(() => window.engineCheck.decrypt('user'));
    check(
      'falls back to arrayBuffer compilation',
      decrypted.verified === true && decrypted.pageCount === 4,
      JSON.stringify(decrypted.error ?? 'ok'),
    );
    problems.length = 0; // Chromium logs the refused streaming compile; that is expected here
  });
  server.close();
}

// --- 2b. Content-Security-Policy -------------------------------------------------------------------
if (mode === 'all' || mode === 'csp') {
  const strict =
    "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'";
  {
    const { server, port } = await serve(dist, { csp: strict });
    console.log(`\n[production build, CSP: ${strict}]`);
    await withPage(browser, `http://127.0.0.1:${port}/`, null, async (page) => {
      await page.setInputFiles('#file', path.join(fixtures, 'aes-256-r6.pdf'));
      const decrypted = await page.evaluate(() => window.engineCheck.decrypt('user'));
      const ready = await page.evaluate(() => window.engineCheck.ready());
      check(
        'works in a worker under a strict CSP',
        decrypted.verified === true && ready.mode === 'worker',
        JSON.stringify(decrypted.error ?? ready),
      );
    });
    server.close();
  }
  {
    const withoutWasm =
      "default-src 'none'; script-src 'self'; worker-src 'self'; connect-src 'self'";
    const { server, port } = await serve(dist, { csp: withoutWasm });
    console.log(`[production build, CSP without 'wasm-unsafe-eval']`);
    await withPage(browser, `http://127.0.0.1:${port}/`, null, async (page, problems) => {
      await page.setInputFiles('#file', path.join(fixtures, 'aes-256-r6.pdf'));
      const inspected = await page.evaluate(() => window.engineCheck.inspect());
      check(
        'engine-unavailable when the CSP forbids WebAssembly',
        inspected.error === 'engine-unavailable',
        JSON.stringify(inspected),
      );
      problems.length = 0; // the CSP violation is logged by the browser
    });
    server.close();
  }
}

// --- 3. no Worker available: main-thread fallback ------------------------------------------------
if (mode === 'all' || mode === 'noworker') {
  const { server, port } = await serve(dist);
  console.log('\n[production build, Worker constructor missing]');
  await withPage(
    browser,
    `http://127.0.0.1:${port}/`,
    () => {
      delete window.Worker;
    },
    async (page) => {
      const ready = await page.evaluate(() => window.engineCheck.ready());
      check(
        'ready() in main-thread mode',
        ready.mode === 'main-thread' && ready.concurrency === 1,
        JSON.stringify(ready),
      );
      await page.setInputFiles('#file', path.join(fixtures, 'objstm-r6.pdf'));
      const decrypted = await page.evaluate(() => window.engineCheck.decrypt('owner'));
      check('decrypt on the main thread', decrypted.verified === true && decrypted.pageCount === 4);
    },
  );
  console.log('[production build, Worker constructor throws]');
  await withPage(
    browser,
    `http://127.0.0.1:${port}/`,
    () => {
      window.Worker = function () {
        throw new DOMException('blocked', 'SecurityError');
      };
    },
    async (page) => {
      await page.setInputFiles('#file', path.join(fixtures, 'rc4-128-r3.pdf'));
      const decrypted = await page.evaluate(() => window.engineCheck.decrypt('user'));
      const ready = await page.evaluate(() => window.engineCheck.ready());
      check(
        'decrypt after falling back',
        decrypted.verified === true && ready.mode === 'main-thread',
      );
    },
  );
  console.log('[production build, worker script fails to load]');
  await withPage(browser, `http://127.0.0.1:${port}/`, null, async (page, problems) => {
    await page.route('**/worker-*.js', (route) => route.abort());
    await page.setInputFiles('#file', path.join(fixtures, 'aes-256-r6.pdf'));
    const decrypted = await page.evaluate(() => window.engineCheck.decrypt('user'));
    const ready = await page.evaluate(() => window.engineCheck.ready());
    check(
      'decrypt after the worker failed to start',
      decrypted.verified === true && ready.mode === 'main-thread',
      JSON.stringify(decrypted.error ?? ready),
    );
    problems.length = 0; // the failed worker load is logged by the browser
  });
  console.log('[production build, .wasm missing]');
  await withPage(browser, `http://127.0.0.1:${port}/`, null, async (page, problems) => {
    await page.route('**/*.wasm', (route) => route.fulfill({ status: 404, body: 'gone' }));
    await page.setInputFiles('#file', path.join(fixtures, 'aes-256-r6.pdf'));
    const ready = await page.evaluate(() => window.engineCheck.ready());
    const inspected = await page.evaluate(() => window.engineCheck.inspect());
    check(
      'engine-unavailable when the module cannot be fetched',
      ready.error === 'engine-unavailable' && inspected.error === 'engine-unavailable',
      JSON.stringify(ready),
    );
    problems.length = 0;
  });
  server.close();
}

// --- 4. Vite dev server ---------------------------------------------------------------------------
if (mode === 'all' || mode === 'dev') {
  console.log('\n[vite dev server]');
  const dev = await createServer(viteConfig);
  await dev.listen();
  try {
    await withPage(browser, 'http://127.0.0.1:5199/', null, async (page) => {
      const ready = await page.evaluate(() => window.engineCheck.ready());
      check(
        'ready() in worker mode',
        ready.mode === 'worker' && ready.qpdfVersion === '12.4.2',
        JSON.stringify(ready),
      );
      await page.setInputFiles('#file', path.join(fixtures, 'aes-256-r6.pdf'));
      const decrypted = await page.evaluate(() => window.engineCheck.decrypt('user'));
      check(
        'decrypt',
        decrypted.verified === true && decrypted.pageCount === 4,
        JSON.stringify(decrypted.error ?? 'ok'),
      );
    });
  } finally {
    await dev.close();
  }
}

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);

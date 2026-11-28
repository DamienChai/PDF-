// A static server that behaves like a GitHub Pages project site: the files live under a
// sub-path, unknown paths are 404, and anything but GET/HEAD is 405 (so a share-target POST can
// only be answered by the service worker).
//
//   node tests/e2e/support/static-server.mjs <dir> <port> [prefix]
//
// `/__ready` answers 204 as soon as the server listens; files are read on request.
//
// A browser that sends the cookie `e2e-sw-version=<n>` gets sw.js with a trailing comment naming
// that version: byte-different from the built script, so to that browser (and to no other test)
// a new version of the app has been published.
//
// A browser that sends the cookie `e2e-build=<tag>` gets the site as a release that changed
// every file would leave it: each file of assets/ has another name (`name.<tag>.ext`), every
// reference to it says so, the built names are gone (404), and the service worker's precache
// list gives every other file a new revision.
import { createServer } from 'node:http';
import { readFile, readdir, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const [dir = 'dist', port = '5173', prefix = '/PDF-/'] = process.argv.slice(2);
const root = resolve(dir);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

const TEXT = new Set(['.html', '.js', '.mjs', '.css', '.webmanifest', '.json']);

function cookie(request, name) {
  return new RegExp(`(?:^|;\\s*)${name}=(\\w+)`).exec(request.headers.cookie ?? '')?.[1];
}

const renamed = (name, tag) => name.replace(/(\.[^.]+)$/, `.${tag}$1`);

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (url.pathname === '/__ready') {
    response.writeHead(204).end();
    return;
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' }).end('Method Not Allowed');
    return;
  }
  if (!url.pathname.startsWith(prefix)) {
    response.writeHead(404).end('Not Found');
    return;
  }
  let relative = normalize(decodeURIComponent(url.pathname.slice(prefix.length)));
  if (relative.startsWith('..')) {
    response.writeHead(403).end();
    return;
  }
  if (relative === '' || relative === '.' || relative.endsWith('/')) {
    relative = join(relative, 'index.html');
  }
  try {
    const build = cookie(request, 'e2e-build');
    const assets = build ? await readdir(join(root, 'assets')) : [];
    if (build && relative.startsWith('assets/')) {
      const built = assets.find((name) => `assets/${renamed(name, build)}` === relative);
      if (!built) throw new Error('not part of this build');
      relative = `assets/${built}`;
    }
    const file = join(root, relative);
    if ((await stat(file)).isDirectory()) throw new Error('directory');
    let body = await readFile(file);
    if (build && TEXT.has(extname(file))) {
      let text = body.toString('utf8');
      for (const name of assets) text = text.split(name).join(renamed(name, build));
      // The precache list of the worker: the files without a hash in their name changed too.
      if (relative === 'sw.js')
        text = text.replace(/"revision":"(\w+)"/g, `"revision":"$1${build}"`);
      body = Buffer.from(text);
    }
    const version = cookie(request, 'e2e-sw-version');
    if (version && relative === 'sw.js') {
      body = Buffer.concat([body, Buffer.from(`\n// e2e: version ${version}\n`)]);
    }
    response.writeHead(200, {
      'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
      // What GitHub Pages sends for every file.
      'Cache-Control': 'max-age=600',
    });
    response.end(request.method === 'HEAD' ? undefined : body);
  } catch {
    response.writeHead(404).end('Not Found');
  }
});

server.listen(Number(port), '127.0.0.1');
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(0));

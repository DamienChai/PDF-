#!/usr/bin/env node
// Benchmark of the WebAssembly engine on large files, with a lazily read file as input.
//
//   node engine/bench.mjs                      # 100 MB and 500 MB, AES-256
//   node engine/bench.mjs --sizes 100 --runs 5 --algorithm aes-128
//   node engine/bench.mjs --dist engine/build/dist-lto     # compare another build
//   node engine/bench.mjs --block 262144 --max-read 262144 # I/O tuning experiments
//
// For every size it creates (once, in tests/fixtures/large/, which is git-ignored) a plain PDF
// made of 1 MiB image streams and an encrypted copy written by the engine itself, then measures
// decryption: wall time, throughput, calls to the JavaScript read function, bytes read, and the
// size of the WebAssembly memory afterwards (memory never shrinks, so that is the peak).
//
// This file talks to dist/pdfx.mjs directly instead of going through src/engine/*.ts so that it
// runs with plain Node. The input is read with fs.readSync, one call per engine read request,
// which is the Node equivalent of the worker's FileReaderSync on Blob slices.

import { randomFillSync } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.dirname(here);

function parseArgs(argv) {
  const options = {
    sizes: [100, 500],
    runs: 3,
    algorithm: 'aes-256',
    dist: path.join(repo, 'src/engine/dist'),
    dir: path.join(repo, 'tests/fixtures/large'),
    tuning: {},
    output: 'discard',
  };
  for (let i = 0; i < argv.length; i++) {
    const value = () => argv[++i];
    switch (argv[i]) {
      case '--sizes':
        options.sizes = value().split(',').map(Number);
        break;
      case '--runs':
        options.runs = Number(value());
        break;
      case '--algorithm':
        options.algorithm = value();
        break;
      case '--dist':
        options.dist = path.resolve(value());
        break;
      case '--dir':
        options.dir = path.resolve(value());
        break;
      case '--block':
        options.tuning.blockBytes = Number(value());
        break;
      case '--cache':
        options.tuning.cacheBytes = Number(value());
        break;
      case '--max-read':
        options.tuning.maxReadBytes = Number(value());
        break;
      case '--output':
        options.output = value(); // discard | file
        break;
      default:
        throw new Error(`unknown argument ${argv[i]}`);
    }
  }
  return options;
}

// --- minimal host for dist/pdfx.mjs ---------------------------------------------------------

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const hex = (text) => Buffer.from(text, 'utf8').toString('hex');

async function loadEngine(dist) {
  const { default: createPdfx } = await import(pathToFileURL(path.join(dist, 'pdfx.mjs')).href);
  const wasm = await WebAssembly.compile(fs.readFileSync(path.join(dist, 'pdfx.wasm')));
  return async function instantiate() {
    const jobs = new Map();
    let module;
    const host = {
      read(handle, offset, dest, length) {
        const job = jobs.get(handle);
        job.readCalls++;
        try {
          // Straight into the WebAssembly memory.
          const got = fs.readSync(job.fd, module.HEAPU8, dest >>> 0, length, offset);
          return got === length ? length : -1;
        } catch (error) {
          job.error = error;
          return -1;
        }
      },
      write(handle, data, length) {
        const job = jobs.get(handle);
        try {
          const start = data >>> 0;
          if (job.out !== undefined) {
            fs.writeSync(job.out, module.HEAPU8, start, length);
          } else {
            // What the app does: copy the chunk out of the heap.
            job.sinkBytes += module.HEAPU8.slice(start, start + length).length;
          }
          return 0;
        } catch (error) {
          job.error = error;
          return -1;
        }
      },
      progress() {},
    };
    module = await new Promise((resolve, reject) => {
      createPdfx({
        pdfxHost: host,
        instantiateWasm(imports, receive) {
          WebAssembly.instantiate(wasm, imports).then(
            (instance) => receive(instance, wasm),
            reject,
          );
          return {};
        },
      }).then(resolve, reject);
    });
    let nextHandle = 1;
    function call(entry, request, job) {
      const handle = nextHandle++;
      jobs.set(handle, job);
      const json = encoder.encode(JSON.stringify({ ...request, handle }));
      const pointer = module._malloc(json.length + 1) >>> 0;
      module.HEAPU8.set(json, pointer);
      module.HEAPU8[pointer + json.length] = 0;
      const responsePointer = module[entry](pointer) >>> 0;
      module._free(pointer);
      let end = responsePointer;
      while (module.HEAPU8[end] !== 0) end++;
      const response = JSON.parse(decoder.decode(module.HEAPU8.subarray(responsePointer, end)));
      module._pdfx_free(responsePointer);
      jobs.delete(handle);
      if (!response.ok) {
        throw new Error(`${response.error.code}: ${response.error.detail} ${job.error ?? ''}`);
      }
      return response.result;
    }
    return {
      heapBytes: () => module.HEAPU8.length,
      /** Runs one operation with `inputPath` as lazy input; output goes to `outputPath` or nowhere. */
      run(entry, inputPath, request, outputPath) {
        const job = {
          fd: fs.openSync(inputPath, 'r'),
          readCalls: 0,
          sinkBytes: 0,
          out: undefined,
          error: undefined,
        };
        if (outputPath) {
          job.out = fs.openSync(outputPath, 'w');
        }
        try {
          const size = fs.fstatSync(job.fd).size;
          const started = performance.now();
          const result = call(entry, { size, ...request }, job);
          return { result, ms: performance.now() - started, readCalls: job.readCalls, size };
        } finally {
          fs.closeSync(job.fd);
          if (job.out !== undefined) {
            fs.closeSync(job.out);
          }
        }
      },
    };
  };
}

// --- test data --------------------------------------------------------------------------------

/** Writes a PDF of roughly `megabytes` MB: one page per 1 MiB grayscale image of random bytes. */
function writePlainPdf(file, megabytes) {
  const imageBytes = 1024 * 1024;
  const pages = megabytes;
  const fd = fs.openSync(file, 'w');
  const offsets = [];
  let position = 0;
  const write = (data) => {
    const bytes = typeof data === 'string' ? Buffer.from(data, 'latin1') : data;
    fs.writeSync(fd, bytes);
    position += bytes.length;
  };
  const begin = () => {
    offsets.push(position);
    return offsets.length;
  };
  write('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n');
  // Objects: 1 catalog, 2 pages, then per page: page, content, image.
  const kids = Array.from({ length: pages }, (_, i) => `${3 + 3 * i} 0 R`).join(' ');
  write(`${begin()} 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`);
  write(`${begin()} 0 obj\n<< /Type /Pages /Count ${pages} /Kids [ ${kids} ] >>\nendobj\n`);
  const image = Buffer.alloc(imageBytes);
  for (let i = 0; i < pages; i++) {
    const page = begin();
    write(
      `${page} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 612] /Contents ${page + 1} 0 R ` +
        `/Resources << /XObject << /Im0 ${page + 2} 0 R >> >> >>\nendobj\n`,
    );
    const content = `q 612 0 0 612 0 0 cm /Im0 Do Q\n% page ${i + 1}\n`;
    write(
      `${begin()} 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`,
    );
    randomFillSync(image);
    write(
      `${begin()} 0 obj\n<< /Type /XObject /Subtype /Image /Width 1024 /Height 1024 /ColorSpace /DeviceGray ` +
        `/BitsPerComponent 8 /Length ${imageBytes} >>\nstream\n`,
    );
    write(image);
    write('\nendstream\nendobj\n');
  }
  const xref = position;
  write(`xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n`);
  write(offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join(''));
  write(`trailer\n<< /Size ${offsets.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  fs.closeSync(fd);
}

const MB = 1024 * 1024;
const fmt = (n, digits = 1) => n.toFixed(digits);
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

async function main() {
  const options = parseArgs(process.argv.slice(2));
  fs.mkdirSync(options.dir, { recursive: true });
  const instantiate = await loadEngine(options.dist);
  const info = JSON.parse(fs.readFileSync(path.join(options.dist, 'BUILDINFO.json'), 'utf8'));
  console.log(`engine: ${options.dist}`);
  console.log(
    `  qpdf ${info.qpdf}, emscripten ${info.emscripten}, wasm ${info.wasmBytes} bytes, flags ${info.compileFlags.join(' ')}`,
  );
  console.log(
    `  node ${process.version}, tuning ${JSON.stringify(options.tuning)}, algorithm ${options.algorithm}\n`,
  );

  const password = 'bench-user';
  const rows = [];
  for (const megabytes of options.sizes) {
    const plain = path.join(options.dir, `plain-${megabytes}.pdf`);
    const encrypted = path.join(options.dir, `${options.algorithm}-${megabytes}.pdf`);
    if (!fs.existsSync(plain)) {
      console.log(`creating ${plain}`);
      writePlainPdf(plain, megabytes);
    }
    if (!fs.existsSync(encrypted)) {
      const engine = await instantiate();
      const run = engine.run(
        '_pdfx_process',
        plain,
        {
          passwords: [],
          operation: 'encrypt',
          streams: 'preserve',
          linearize: false,
          encrypt: {
            algorithm: options.algorithm,
            user: hex(password),
            owner: hex('bench-owner'),
            print: 'full',
          },
        },
        encrypted,
      );
      console.log(
        `created ${encrypted}: ${fmt(run.size / MB)} MB encrypted in ${fmt(run.ms / 1000, 2)} s ` +
          `(${fmt(run.size / MB / (run.ms / 1000))} MB/s, heap ${fmt(engine.heapBytes() / MB)} MB)`,
      );
    }

    // Inspect: how little of the file is needed to describe it.
    {
      const engine = await instantiate();
      const run = engine.run('_pdfx_inspect', encrypted, {
        passwords: [hex(password)],
        ...options.tuning,
      });
      console.log(
        `${path.basename(encrypted)}: inspect ${fmt(run.ms, 0)} ms, ${run.readCalls} reads, ` +
          `${fmt(run.result.stats.bytesRead / MB, 2)} MB read, ${run.result.pageCount} pages`,
      );
    }

    const times = [];
    let last;
    for (let i = 0; i < options.runs; i++) {
      const engine = await instantiate(); // fresh memory, so the heap size is this run's peak
      const output =
        options.output === 'file'
          ? path.join(options.dir, `decrypted-${megabytes}.pdf`)
          : undefined;
      const run = engine.run(
        '_pdfx_process',
        encrypted,
        {
          passwords: [hex(password)],
          operation: 'decrypt',
          streams: 'preserve',
          linearize: false,
          ...options.tuning,
        },
        output,
      );
      times.push(run.ms);
      last = { ...run, heap: engine.heapBytes() };
    }
    const ms = median(times);
    rows.push({
      file: path.basename(encrypted),
      'size MB': fmt(last.size / MB),
      'decrypt s': fmt(ms / 1000, 2),
      'MB/s': fmt(last.size / MB / (ms / 1000)),
      'read calls': last.readCalls,
      'MB read': fmt(last.result.stats.bytesRead / MB),
      evictions: last.result.stats.evictions,
      'wasm heap MB': fmt(last.heap / MB),
      'heap / file': `${fmt((100 * last.heap) / last.size)} %`,
    });
  }
  console.log('');
  console.table(rows);
  console.log(`process RSS ${fmt(process.memoryUsage().rss / MB)} MB`);
}

await main();

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BLOB_URL_LIFETIME_MS,
  downloadFile,
  getSaveCapabilities,
  openInNewTab,
  saveAsZip,
  saveFile,
  saveToDirectory,
  shareFiles,
  type OutputFile,
} from './save';

// --- Fakes for the browser APIs involved --------------------------------------------------------

interface FakeAnchor {
  href: string;
  download: string;
  target: string;
  rel: string;
  style: Record<string, string>;
  click: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
}

function domError(name: string): Error {
  return new DOMException(`${name} (simulated)`, name);
}

function installDocument(): { anchors: FakeAnchor[]; blobs: Map<string, Blob> } {
  const anchors: FakeAnchor[] = [];
  const blobs = new Map<string, Blob>();
  vi.stubGlobal('document', {
    createElement: (tag: string) => {
      expect(tag).toBe('a');
      const anchor: FakeAnchor = {
        href: '',
        download: '',
        target: '',
        rel: '',
        style: {},
        click: vi.fn(),
        remove: vi.fn(),
      };
      anchors.push(anchor);
      return anchor;
    },
    body: { appendChild: vi.fn() },
  });
  let counter = 0;
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
    const url = `blob:test/${counter++}`;
    blobs.set(url, blob as Blob);
    return url;
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => {
    blobs.delete(url);
  });
  return { anchors, blobs };
}

class FakeWritable {
  written: Blob[] = [];
  closed = false;
  aborted = false;
  constructor(private readonly failWith?: Error) {}
  async write(data: Blob): Promise<void> {
    if (this.failWith) throw this.failWith;
    this.written.push(data);
  }
  async close(): Promise<void> {
    this.closed = true;
  }
  async abort(): Promise<void> {
    this.aborted = true;
  }
}

class FakeFileHandle {
  writable: FakeWritable | undefined;
  constructor(
    readonly name: string,
    private readonly failWith?: Error,
  ) {}
  async createWritable(): Promise<FakeWritable> {
    this.writable = new FakeWritable(this.failWith);
    return this.writable;
  }
  content(): Blob | undefined {
    return this.writable?.closed ? this.writable.written[0] : undefined;
  }
}

/** A case-insensitive folder, like the ones on Windows, macOS and Android shared storage. */
class FakeDirectory {
  files = new Map<string, FakeFileHandle>();
  folders = new Set<string>();
  failWritesWith: Error | undefined;
  removed: string[] = [];

  seed(...names: string[]): void {
    for (const name of names) this.files.set(name.toLowerCase(), new FakeFileHandle(name));
  }

  async getFileHandle(name: string, options?: { create?: boolean }): Promise<FakeFileHandle> {
    const key = name.toLowerCase();
    if (this.folders.has(key)) throw domError('TypeMismatchError');
    const existing = this.files.get(key);
    if (existing) return existing;
    if (!options?.create) throw domError('NotFoundError');
    const handle = new FakeFileHandle(name, this.failWritesWith);
    this.files.set(key, handle);
    return handle;
  }

  async removeEntry(name: string): Promise<void> {
    this.removed.push(name);
    this.files.delete(name.toLowerCase());
  }

  names(): string[] {
    return [...this.files.values()].map((handle) => handle.name);
  }
}

const pdf = (name: string, text = name): OutputFile => ({
  name,
  blob: new Blob([`%PDF-1.7 ${text}`], { type: 'application/pdf' }),
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// --- Tests --------------------------------------------------------------------------------------

describe('getSaveCapabilities', () => {
  it('reports nothing where the APIs are missing', () => {
    vi.stubGlobal('navigator', {});
    expect(getSaveCapabilities()).toEqual({
      canShareFiles: false,
      canPickSaveLocation: false,
      canPickDirectory: false,
    });
  });

  it('detects the pickers', () => {
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('showSaveFilePicker', vi.fn());
    expect(getSaveCapabilities()).toMatchObject({
      canPickSaveLocation: true,
      canPickDirectory: false,
    });
    vi.stubGlobal('showDirectoryPicker', vi.fn());
    expect(getSaveCapabilities()).toMatchObject({
      canPickSaveLocation: true,
      canPickDirectory: true,
    });
  });

  it('asks the browser whether a PDF file can be shared', () => {
    const canShare = vi.fn((data: ShareData) => data.files?.[0]?.type === 'application/pdf');
    vi.stubGlobal('navigator', { share: vi.fn(), canShare });
    expect(getSaveCapabilities().canShareFiles).toBe(true);
    expect(canShare.mock.calls[0]![0].files![0]).toBeInstanceOf(File);

    vi.stubGlobal('navigator', { share: vi.fn(), canShare: () => false });
    expect(getSaveCapabilities().canShareFiles).toBe(false);
    // Text-only sharing (older desktop browsers) is not enough.
    vi.stubGlobal('navigator', { share: vi.fn() });
    expect(getSaveCapabilities().canShareFiles).toBe(false);
    vi.stubGlobal('navigator', {
      share: vi.fn(),
      canShare: () => {
        throw new TypeError('boom');
      },
    });
    expect(getSaveCapabilities().canShareFiles).toBe(false);
  });
});

describe('saveFile', () => {
  it('writes through the save dialog where available', async () => {
    const { anchors } = installDocument();
    const handle = new FakeFileHandle('picked.pdf');
    const picker = vi.fn(async () => handle);
    vi.stubGlobal('showSaveFilePicker', picker);

    const file = pdf('report_unlocked.pdf');
    await expect(saveFile(file)).resolves.toBe('saved');

    expect(picker).toHaveBeenCalledWith({
      suggestedName: 'report_unlocked.pdf',
      types: [{ description: 'PDF', accept: { 'application/pdf': ['.pdf'] } }],
      id: 'pdfkey-save',
      startIn: 'downloads',
    });
    expect(handle.content()).toBe(file.blob);
    expect(anchors).toHaveLength(0);
  });

  it('suggests a sanitised name', async () => {
    installDocument();
    const picker = vi.fn(async (_options: unknown) => new FakeFileHandle('x'));
    vi.stubGlobal('showSaveFilePicker', picker);
    await saveFile(pdf('a/b:c?.pdf'));
    expect(picker.mock.calls[0]![0]).toMatchObject({ suggestedName: 'a_b_c_.pdf' });
  });

  it('reports a dismissed dialog as cancelled and downloads nothing', async () => {
    const { anchors } = installDocument();
    vi.stubGlobal(
      'showSaveFilePicker',
      vi.fn(async () => {
        throw domError('AbortError');
      }),
    );
    await expect(saveFile(pdf('a.pdf'))).resolves.toBe('cancelled');
    expect(anchors).toHaveLength(0);
  });

  it.each(['SecurityError', 'NotAllowedError', 'TypeError'])(
    'falls back to a download when the dialog cannot be shown (%s)',
    async (name) => {
      const { anchors } = installDocument();
      vi.stubGlobal(
        'showSaveFilePicker',
        vi.fn(async () => {
          throw domError(name);
        }),
      );
      await expect(saveFile(pdf('a.pdf'))).resolves.toBe('downloaded');
      expect(anchors).toHaveLength(1);
    },
  );

  it('downloads through a temporary link where there is no save dialog', async () => {
    const { anchors, blobs } = installDocument();
    const file = pdf('报告_unlocked.pdf');
    await expect(saveFile(file)).resolves.toBe('downloaded');

    expect(anchors).toHaveLength(1);
    const anchor = anchors[0]!;
    expect(anchor.download).toBe('报告_unlocked.pdf');
    expect(anchor.click).toHaveBeenCalledOnce();
    expect(anchor.remove).toHaveBeenCalledOnce();
    expect(blobs.get(anchor.href)).toBe(file.blob);

    // The URL must outlive the click: the download starts asynchronously.
    vi.advanceTimersByTime(BLOB_URL_LIFETIME_MS - 1);
    expect(blobs.has(anchor.href)).toBe(true);
    vi.advanceTimersByTime(1);
    expect(blobs.has(anchor.href)).toBe(false);
  });

  it('labels untyped blobs as PDF so that the download gets the right MIME type', async () => {
    const { anchors, blobs } = installDocument();
    await saveFile({ name: 'a.pdf', blob: new Blob(['%PDF-']) });
    const downloaded = blobs.get(anchors[0]!.href)!;
    expect(downloaded.type).toBe('application/pdf');
    expect(await downloaded.text()).toBe('%PDF-');
  });

  it('aborts the write and rethrows when writing fails', async () => {
    installDocument();
    const failure = domError('QuotaExceededError');
    const handle = new FakeFileHandle('x.pdf', failure);
    vi.stubGlobal(
      'showSaveFilePicker',
      vi.fn(async () => handle),
    );
    await expect(saveFile(pdf('x.pdf'))).rejects.toBe(failure);
    expect(handle.writable!.aborted).toBe(true);
    expect(handle.writable!.closed).toBe(false);
  });
});

describe('downloadFile', () => {
  it('downloads without asking, even where a save dialog exists', () => {
    const { anchors, blobs } = installDocument();
    const picker = vi.fn();
    vi.stubGlobal('showSaveFilePicker', picker);
    expect(downloadFile({ name: 'a:b.pdf', blob: new Blob(['%PDF-']) })).toBe('downloaded');
    expect(picker).not.toHaveBeenCalled();
    expect(anchors[0]!.download).toBe('a_b.pdf');
    expect(anchors[0]!.click).toHaveBeenCalledOnce();
    expect(blobs.get(anchors[0]!.href)!.type).toBe('application/pdf');
  });
});

describe('saveAsZip', () => {
  const files = [pdf('a.pdf'), pdf('b.pdf'), pdf('a.pdf', 'second a')];

  it('asks for the destination before building the archive', async () => {
    installDocument();
    const order: string[] = [];
    const handle = new FakeFileHandle('out.zip');
    vi.stubGlobal(
      'showSaveFilePicker',
      vi.fn(async () => {
        order.push('picker');
        return handle;
      }),
    );
    const spied = files.map((file) => {
      const blob = file.blob.slice(0, file.blob.size, file.blob.type);
      const slice = blob.slice.bind(blob);
      blob.slice = (...args) => {
        order.push('read');
        return slice(...args);
      };
      return { name: file.name, blob };
    });

    await expect(saveAsZip(spied, 'PDF Key.zip')).resolves.toBe('saved');
    expect(order[0]).toBe('picker');
    expect(order.filter((step) => step === 'read').length).toBeGreaterThanOrEqual(3);

    const zip = handle.content()!;
    expect(zip.type).toBe('application/zip');
    const bytes = new Uint8Array(await zip.arrayBuffer());
    expect([...bytes.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    const text = new TextDecoder('latin1').decode(bytes);
    for (const name of ['a.pdf', 'b.pdf', 'a (2).pdf']) expect(text).toContain(name);
    expect(text).toContain('second a');
  });

  it('describes the archive type to the save dialog', async () => {
    installDocument();
    const picker = vi.fn(async (_options: unknown) => new FakeFileHandle('out.zip'));
    vi.stubGlobal('showSaveFilePicker', picker);
    await saveAsZip(files, 'unlocked.zip');
    expect(picker.mock.calls[0]![0]).toMatchObject({
      suggestedName: 'unlocked.zip',
      types: [{ description: 'ZIP', accept: { 'application/zip': ['.zip'] } }],
    });
  });

  it('builds nothing when the dialog is dismissed', async () => {
    installDocument();
    vi.stubGlobal(
      'showSaveFilePicker',
      vi.fn(async () => {
        throw domError('AbortError');
      }),
    );
    const blob = new Blob(['x']);
    blob.slice = () => {
      throw new Error('must not be read');
    };
    await expect(saveAsZip([{ name: 'a.pdf', blob }], 'out.zip')).resolves.toBe('cancelled');
  });

  it('downloads the archive where there is no save dialog and enforces the extension', async () => {
    const { anchors, blobs } = installDocument();
    await expect(saveAsZip(files, 'my:files')).resolves.toBe('downloaded');
    const anchor = anchors[0]!;
    expect(anchor.download).toBe('my_files.zip');
    expect(blobs.get(anchor.href)!.type).toBe('application/zip');
  });
});

describe('saveToDirectory', () => {
  it('rejects where folders cannot be picked', async () => {
    await expect(saveToDirectory([pdf('a.pdf')])).rejects.toMatchObject({
      name: 'NotSupportedError',
    });
  });

  it('asks for a writable folder and writes every file', async () => {
    const directory = new FakeDirectory();
    const picker = vi.fn(async () => directory);
    vi.stubGlobal('showDirectoryPicker', picker);
    const files = [pdf('a.pdf'), pdf('b.pdf')];

    await expect(saveToDirectory(files)).resolves.toBe('saved');
    expect(picker).toHaveBeenCalledWith({
      mode: 'readwrite',
      id: 'pdfkey-folder',
      startIn: 'downloads',
    });
    expect(directory.names()).toEqual(['a.pdf', 'b.pdf']);
    expect(directory.files.get('a.pdf')!.content()).toBe(files[0]!.blob);
    expect(directory.files.get('b.pdf')!.content()).toBe(files[1]!.blob);
  });

  it('reports a dismissed folder dialog as cancelled', async () => {
    vi.stubGlobal(
      'showDirectoryPicker',
      vi.fn(async () => {
        throw domError('AbortError');
      }),
    );
    await expect(saveToDirectory([pdf('a.pdf')])).resolves.toBe('cancelled');
  });

  it('passes other picker failures on', async () => {
    const failure = domError('SecurityError');
    vi.stubGlobal(
      'showDirectoryPicker',
      vi.fn(async () => {
        throw failure;
      }),
    );
    await expect(saveToDirectory([pdf('a.pdf')])).rejects.toBe(failure);
  });

  it('never overwrites: existing files, folders and other files of the batch keep their names', async () => {
    const directory = new FakeDirectory();
    directory.seed('report.pdf', 'Report (2).PDF', 'b.pdf');
    directory.folders.add('c.pdf');
    const untouched = new Map(directory.files);
    vi.stubGlobal(
      'showDirectoryPicker',
      vi.fn(async () => directory),
    );

    await saveToDirectory([
      pdf('report.pdf', 'new report'),
      pdf('report (3).pdf', 'already numbered'),
      pdf('b.pdf', 'first b'),
      pdf('B.pdf', 'second b'),
      pdf('c.pdf', 'c'),
    ]);

    for (const [key, handle] of untouched) {
      expect(directory.files.get(key)).toBe(handle);
      expect(handle.writable).toBeUndefined();
    }
    const written = new Map<string, string>();
    for (const handle of directory.files.values()) {
      const content = handle.content();
      if (content) written.set(handle.name, (await content.text()).slice(9));
    }
    expect(Object.fromEntries(written)).toEqual({
      // "report (2).pdf" exists on disk and "report (3).pdf" belongs to another file of the batch.
      'report (4).pdf': 'new report',
      'report (3).pdf': 'already numbered',
      // "B.pdf" became "B (2).pdf" when the batch was made unique, so the first one moves on.
      'b (3).pdf': 'first b',
      'B (2).pdf': 'second b',
      'c (2).pdf': 'c',
    });
  });

  it('removes the placeholder and rethrows when a write fails', async () => {
    const directory = new FakeDirectory();
    const failure = domError('QuotaExceededError');
    directory.failWritesWith = failure;
    vi.stubGlobal(
      'showDirectoryPicker',
      vi.fn(async () => directory),
    );
    await expect(saveToDirectory([pdf('a.pdf'), pdf('b.pdf')])).rejects.toBe(failure);
    expect(directory.removed).toEqual(['a.pdf']);
    expect(directory.names()).toEqual([]);
  });
});

describe('shareFiles', () => {
  it('is unsupported without the Web Share API or without files', async () => {
    vi.stubGlobal('navigator', {});
    await expect(shareFiles([pdf('a.pdf')])).resolves.toBe('unsupported');
    vi.stubGlobal('navigator', { share: vi.fn() });
    await expect(shareFiles([pdf('a.pdf')])).resolves.toBe('unsupported');
    vi.stubGlobal('navigator', { share: vi.fn(), canShare: () => true });
    await expect(shareFiles([])).resolves.toBe('unsupported');
  });

  it('is unsupported when the browser cannot share these files', async () => {
    const share = vi.fn();
    vi.stubGlobal('navigator', { share, canShare: () => false });
    await expect(shareFiles([pdf('a.pdf')])).resolves.toBe('unsupported');
    expect(share).not.toHaveBeenCalled();
  });

  it('shares real PDF File objects', async () => {
    const share = vi.fn(async (_data: ShareData) => undefined);
    const canShare = vi.fn((_data: ShareData) => true);
    vi.stubGlobal('navigator', { share, canShare });

    const files = [
      pdf('a.pdf'),
      { name: 'b:2.pdf', blob: new Blob(['%PDF-b']) },
      pdf('a.pdf', 'dup'),
    ];
    await expect(shareFiles(files, 'Unlocked PDFs')).resolves.toBe('shared');

    expect(canShare).toHaveBeenCalledWith(share.mock.calls[0]![0]);
    const data = share.mock.calls[0]![0];
    expect(data.title).toBe('Unlocked PDFs');
    expect(data.text).toBeUndefined();
    expect(data.files!.map((file) => file.name)).toEqual(['a.pdf', 'b_2.pdf', 'a (2).pdf']);
    for (const file of data.files!) {
      expect(file).toBeInstanceOf(File);
      expect(file.type).toBe('application/pdf');
    }
    expect(await data.files![1]!.text()).toBe('%PDF-b');
  });

  it('omits the title when none is given', async () => {
    const share = vi.fn(async (_data: ShareData) => undefined);
    vi.stubGlobal('navigator', { share, canShare: () => true });
    await shareFiles([pdf('a.pdf')]);
    expect('title' in share.mock.calls[0]![0]).toBe(false);
  });

  it.each([
    ['AbortError', 'cancelled'],
    ['NotAllowedError', 'unsupported'],
    ['TypeError', 'unsupported'],
  ])('maps %s to "%s"', async (name, outcome) => {
    vi.stubGlobal('navigator', {
      canShare: () => true,
      share: async () => {
        throw domError(name);
      },
    });
    await expect(shareFiles([pdf('a.pdf')])).resolves.toBe(outcome);
  });

  it('passes unexpected failures on', async () => {
    const failure = domError('DataError');
    vi.stubGlobal('navigator', {
      canShare: () => true,
      share: async () => {
        throw failure;
      },
    });
    await expect(shareFiles([pdf('a.pdf')])).rejects.toBe(failure);
  });
});

describe('openInNewTab', () => {
  it('opens a blob URL of type application/pdf in a new tab and revokes it later', async () => {
    const { anchors, blobs } = installDocument();
    openInNewTab({ name: 'a.pdf', blob: new Blob(['%PDF-view']) });

    const anchor = anchors[0]!;
    expect(anchor.target).toBe('_blank');
    expect(anchor.rel).toBe('noopener');
    expect(anchor.download).toBe('');
    expect(anchor.click).toHaveBeenCalledOnce();
    const shown = blobs.get(anchor.href)!;
    expect(shown.type).toBe('application/pdf');
    expect(await shown.text()).toBe('%PDF-view');

    vi.advanceTimersByTime(BLOB_URL_LIFETIME_MS);
    expect(blobs.has(anchor.href)).toBe(false);
  });
});

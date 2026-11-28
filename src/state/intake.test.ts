import { describe, expect, it, vi } from 'vitest';
import { tick } from '../../tests/support/jobs-harness';
import { DRAG_IDLE_MS, createIntake, filesFromTransfer, type IntakeEnvironment } from './intake';

interface FakeItem {
  kind: string;
  getAsFile(): File | null;
  webkitGetAsEntry?: () => unknown;
}

interface FakeTransfer {
  types: string[];
  files: File[];
  items?: FakeItem[];
  dropEffect?: string;
}

type Dropped = File | FakeFolder;

/** A folder as the browser presents it: an entry that can be listed, and a `File` that cannot be read. */
interface FakeFolder {
  isFile: false;
  isDirectory: true;
  name: string;
  createReader(): {
    readEntries(done: (batch: unknown[]) => void, fail: (e: unknown) => void): void;
  };
}

function pdf(name: string): File {
  return new File(['%PDF-'], name);
}

function entryOf(item: Dropped): unknown {
  if (!(item instanceof File)) return item;
  return {
    isFile: true,
    isDirectory: false,
    name: item.name,
    file: (done: (file: File) => void) => queueMicrotask(() => done(item)),
  };
}

function folder(name: string, children: Dropped[], broken = false): FakeFolder {
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader() {
      const rest = children.map(entryOf);
      return {
        // Two at a time, then an empty batch, the way browsers page through a directory.
        readEntries(done, fail) {
          queueMicrotask(() => (broken ? fail(new Error('denied')) : done(rest.splice(0, 2))));
        },
      };
    },
  };
}

/** The `File` a browser lists for a dropped folder: reading it fails. */
function folderFile(name: string): File {
  const file = new File([], name);
  file.slice = () =>
    ({ arrayBuffer: () => Promise.reject(new DOMException('gone', 'NotFoundError')) }) as Blob;
  return file;
}

/** A transfer as current browsers build it: every file is also an item that knows its entry. */
function transferOf(dropped: Dropped[] = [pdf('a.pdf')]): FakeTransfer {
  return {
    types: ['Files'],
    files: dropped.map((item) => (item instanceof File ? item : folderFile(item.name))),
    items: dropped.map((item) => ({
      kind: 'file',
      getAsFile: () => (item instanceof File ? item : folderFile(item.name)),
      webkitGetAsEntry: () => entryOf(item),
    })),
  };
}

const textTransfer: FakeTransfer = {
  types: ['text/plain'],
  files: [],
  items: [{ kind: 'string', getAsFile: () => null }],
};

function setup(overrides: Partial<IntakeEnvironment> = {}) {
  const target = new EventTarget();
  const added: Array<{ names: string[]; source: string }> = [];
  const notices: string[] = [];
  let timer: (() => void) | undefined;
  const intake = createIntake({
    addFiles: (files, source) => added.push({ names: files.map((file) => file.name), source }),
    notify: (message, tone) => notices.push(`${message.key} (${tone})`),
    target,
    setTimeout: (callback) => {
      timer = callback;
      return callback;
    },
    clearTimeout: (handle) => {
      if (timer === handle) timer = undefined;
    },
    ...overrides,
  });
  const detach = intake.attach();
  const fire = (type: string, transfer: FakeTransfer | null, key = 'dataTransfer'): Event => {
    const event = new Event(type, { cancelable: true });
    Object.assign(event, { [key]: transfer });
    target.dispatchEvent(event);
    return event;
  };
  return {
    intake,
    target,
    added,
    notices,
    detach,
    fire,
    /** Lets the idle watchdog fire, as if no drag event had arrived for a while. */
    idle: () => timer?.(),
    hasTimer: () => timer !== undefined,
  };
}

describe('drag and drop', () => {
  it('shows the overlay while files are dragged over the window', () => {
    const { intake, fire } = setup();
    expect(intake.dragActive.value).toBe(false);
    const enter = fire('dragenter', transferOf());
    expect(intake.dragActive.value).toBe(true);
    expect(enter.defaultPrevented).toBe(true);
    fire('dragleave', transferOf());
    expect(intake.dragActive.value).toBe(false);
  });

  it('survives the pointer moving between elements of the page', () => {
    const { intake, fire } = setup();
    fire('dragenter', transferOf()); // enters the page
    fire('dragenter', transferOf()); // enters a child
    fire('dragleave', transferOf()); // leaves the parent
    expect(intake.dragActive.value).toBe(true);
    fire('dragenter', transferOf());
    fire('dragleave', transferOf());
    expect(intake.dragActive.value).toBe(true);
    fire('dragleave', transferOf());
    expect(intake.dragActive.value).toBe(false);
  });

  it('accepts the drop: marks it as a copy and keeps the browser from opening the file', () => {
    const { fire } = setup();
    const transfer = transferOf();
    const over = fire('dragover', transfer);
    expect(over.defaultPrevented).toBe(true);
    expect(transfer.dropEffect).toBe('copy');
  });

  it('adds dropped files and hides the overlay', () => {
    const { intake, added, fire, hasTimer } = setup();
    fire('dragenter', transferOf());
    const files = [new File(['%PDF-'], 'a.pdf'), new File(['%PDF-'], 'b.pdf')];
    const drop = fire('drop', transferOf(files));
    expect(drop.defaultPrevented).toBe(true);
    expect(added).toEqual([{ names: ['a.pdf', 'b.pdf'], source: 'drop' }]);
    expect(intake.dragActive.value).toBe(false);
    expect(hasTimer()).toBe(false);
    // The next drag starts from a clean count.
    fire('dragenter', transferOf());
    fire('dragleave', transferOf());
    expect(intake.dragActive.value).toBe(false);
  });

  it('ignores drags that carry no files', () => {
    const { intake, added, fire } = setup();
    for (const type of ['dragenter', 'dragover', 'dragleave', 'drop']) {
      const event = fire(type, textTransfer);
      expect(event.defaultPrevented, type).toBe(false);
    }
    expect(fire('dragenter', null).defaultPrevented).toBe(false);
    expect(intake.dragActive.value).toBe(false);
    expect(added).toEqual([]);
  });

  it('does not add anything for an empty drop', () => {
    const { added, fire } = setup();
    fire('drop', transferOf([]));
    expect(added).toEqual([]);
  });

  it('hides the overlay when the drag ends without an event', () => {
    const { intake, fire, idle } = setup();
    fire('dragenter', transferOf());
    fire('dragenter', transferOf());
    idle();
    expect(intake.dragActive.value).toBe(false);
    // And it comes back when the drag turns out to be still going on.
    fire('dragover', transferOf());
    expect(intake.dragActive.value).toBe(true);
  });

  it('re-arms the watchdog with every sign of life', () => {
    const setTimer = vi.fn(() => 1);
    const clearTimer = vi.fn();
    const { fire } = setup({ setTimeout: setTimer, clearTimeout: clearTimer });
    fire('dragenter', transferOf());
    fire('dragover', transferOf());
    fire('dragover', transferOf());
    expect(setTimer).toHaveBeenCalledTimes(3);
    expect(setTimer).toHaveBeenLastCalledWith(expect.any(Function), DRAG_IDLE_MS);
    expect(clearTimer.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('copes with a read-only dropEffect and old-style type lists', () => {
    const { intake, fire } = setup();
    const transfer = {
      types: { 0: 'Files', length: 1 },
      files: [],
      set dropEffect(_value: string) {
        throw new Error('read-only');
      },
    } as unknown as FakeTransfer;
    expect(() => fire('dragover', transfer)).not.toThrow();
    expect(intake.dragActive.value).toBe(true);
  });

  it('stops listening when detached', () => {
    const { intake, added, detach, fire } = setup();
    fire('dragenter', transferOf());
    detach();
    expect(intake.dragActive.value).toBe(false);
    fire('dragenter', transferOf());
    fire('drop', transferOf());
    expect(intake.dragActive.value).toBe(false);
    expect(added).toEqual([]);
  });
});

describe('dropped folders', () => {
  const tree = (): FakeFolder =>
    folder('scans', [
      pdf('b.pdf'),
      new File(['notes'], 'notes.txt'),
      folder('2024', [
        pdf('march.PDF'),
        folder('raw', [pdf('deep.pdf')]),
        pdf('10.pdf'),
        pdf('9.pdf'),
      ]),
      pdf('a.pdf'),
      new File(['x'], '.hidden.pdf'),
      folder('.git', [pdf('object.pdf')]),
      new File(['jpeg'], 'photo.jpg'),
    ]);

  it('adds the PDFs inside, at any depth, and never the folder itself', async () => {
    const { added, notices, fire } = setup();
    const drop = fire('drop', transferOf([tree()]));
    expect(drop.defaultPrevented).toBe(true);
    await tick();
    expect(added).toEqual([
      // Folder by folder, a folder's own PDFs before its subfolders', each in the order of the
      // names; other files and hidden things are left out.
      { names: ['a.pdf', 'b.pdf', '9.pdf', '10.pdf', 'march.PDF', 'deep.pdf'], source: 'drop' },
    ]);
    expect(notices).toEqual([]);
  });

  it('adds loose files at once and the content of folders when it has been read', async () => {
    const { added, fire } = setup();
    fire('drop', transferOf([pdf('loose.pdf'), folder('more', [pdf('inside.pdf')]), pdf('z.pdf')]));
    expect(added).toEqual([{ names: ['loose.pdf', 'z.pdf'], source: 'drop' }]);
    await tick();
    expect(added).toEqual([
      { names: ['loose.pdf', 'z.pdf'], source: 'drop' },
      { names: ['inside.pdf'], source: 'drop' },
    ]);
  });

  it('says so when a folder holds no PDF', async () => {
    const { added, notices, fire } = setup();
    fire('drop', transferOf([folder('photos', [new File(['x'], 'a.jpg'), folder('empty', [])])]));
    await tick();
    expect(added).toEqual([]);
    expect(notices).toEqual(['toast.folderEmpty (error)']);
  });

  it('stops at the limit of files and says that not everything was added', async () => {
    const many = Array.from({ length: 7 }, (_, index) => pdf(`${index}.pdf`));
    const { added, notices, fire } = setup({
      folderLimits: { maxFiles: 5, maxEntries: 100, maxDepth: 3 },
    });
    fire('drop', transferOf([folder('many', many), folder('later', [pdf('never.pdf')])]));
    await tick();
    expect(added).toEqual([
      { names: ['0.pdf', '1.pdf', '2.pdf', '3.pdf', '4.pdf'], source: 'drop' },
    ]);
    expect(notices).toEqual(['toast.folderLimit (neutral)']);
  });

  it('is quiet about a folder that holds exactly as much as the limit', async () => {
    const { added, notices, fire } = setup({
      folderLimits: { maxFiles: 2, maxEntries: 3, maxDepth: 1 },
    });
    fire(
      'drop',
      transferOf([folder('two', [pdf('a.pdf'), pdf('b.pdf'), new File([''], 'c.txt')])]),
    );
    await tick();
    expect(added).toEqual([{ names: ['a.pdf', 'b.pdf'], source: 'drop' }]);
    expect(notices).toEqual([]);
  });

  it('stops at the limit of entries, whatever they are', async () => {
    const junk = Array.from({ length: 6 }, (_, index) => new File(['x'], `${index}.txt`));
    const { added, notices, fire } = setup({
      folderLimits: { maxFiles: 5, maxEntries: 4, maxDepth: 3 },
    });
    fire('drop', transferOf([folder('junk', [...junk, pdf('last.pdf')])]));
    await tick();
    expect(added).toEqual([]);
    // Nothing was added, so the message does not claim that some PDFs were.
    expect(notices).toEqual(['toast.folderTooLarge (error)']);
  });

  it('finds the PDFs of a folder whatever its subfolders hold', async () => {
    // Subfolders full of other things, sorting before the PDFs that lie next to them.
    const photos = Array.from({ length: 4 }, (_, index) =>
      folder(
        `photos-${index}`,
        Array.from({ length: 5 }, (_, shot) => new File(['x'], `${shot}.jpg`)),
      ),
    );
    const { added, notices, fire } = setup({
      folderLimits: { maxFiles: 5, maxEntries: 20, maxDepth: 3 },
    });
    fire(
      'drop',
      transferOf([
        folder('documents', [...photos, folder('zz-docs', [pdf('deep.pdf')]), pdf('zz-last.pdf')]),
      ]),
    );
    await tick();
    // The subfolders use up the entries that may be looked at; the folder's own PDF is in.
    expect(added).toEqual([{ names: ['zz-last.pdf'], source: 'drop' }]);
    expect(notices).toEqual(['toast.folderLimit (neutral)']);
  });

  it('does not claim to have added PDFs when the levels ran out before any was found', async () => {
    const { added, notices, fire } = setup({
      folderLimits: { maxFiles: 5, maxEntries: 100, maxDepth: 2 },
    });
    fire('drop', transferOf([folder('1', [folder('2', [folder('3', [])])])]));
    await tick();
    expect(added).toEqual([]);
    expect(notices).toEqual(['toast.folderTooLarge (error)']);
  });

  it('does not go deeper than the limit of levels', async () => {
    const { added, notices, fire } = setup({
      folderLimits: { maxFiles: 5, maxEntries: 100, maxDepth: 2 },
    });
    const nested = folder('1', [
      pdf('one.pdf'),
      folder('2', [pdf('two.pdf'), folder('3', [pdf('three.pdf')])]),
    ]);
    fire('drop', transferOf([nested]));
    await tick();
    expect(added).toEqual([{ names: ['one.pdf', 'two.pdf'], source: 'drop' }]);
    expect(notices).toEqual(['toast.folderLimit (neutral)']);
  });

  it('asks for the files themselves when a folder cannot be read', async () => {
    const { added, notices, fire } = setup();
    fire('drop', transferOf([folder('locked', [pdf('a.pdf')], true)]));
    await tick();
    expect(added).toEqual([]);
    expect(notices).toEqual(['toast.folderUnreadable (error)']);
  });

  it('keeps what it could read of a tree with an unreadable corner', async () => {
    const { added, notices, fire } = setup();
    fire(
      'drop',
      transferOf([folder('mixed', [folder('locked', [pdf('x.pdf')], true), pdf('ok.pdf')])]),
    );
    await tick();
    expect(added).toEqual([{ names: ['ok.pdf'], source: 'drop' }]);
    expect(notices).toEqual([]);
  });

  it('where the browser cannot tell folders from files, skips what cannot be read', async () => {
    const { added, notices, fire } = setup();
    // No items: only the list of files, in which a folder looks like any other file.
    fire('drop', { types: ['Files'], files: [pdf('a.pdf'), folderFile('scans'), pdf('b.pdf')] });
    expect(added).toEqual([]);
    await tick();
    expect(added).toEqual([{ names: ['a.pdf', 'b.pdf'], source: 'drop' }]);
    expect(notices).toEqual(['toast.folderUnreadable (error)']);
  });

  it('takes files without an entry as they are', () => {
    const { added, fire } = setup();
    const file = pdf('synthetic.pdf');
    fire('drop', {
      types: ['Files'],
      files: [file],
      items: [{ kind: 'file', getAsFile: () => file, webkitGetAsEntry: () => null }],
    });
    expect(added).toEqual([{ names: ['synthetic.pdf'], source: 'drop' }]);
  });

  it('reads a pasted folder the same way', async () => {
    const { added, fire } = setup();
    const event = fire('paste', transferOf([folder('copied', [pdf('in.pdf')])]), 'clipboardData');
    expect(event.defaultPrevented).toBe(true);
    await tick();
    expect(added).toEqual([{ names: ['in.pdf'], source: 'paste' }]);
  });
});

describe('paste', () => {
  it('adds pasted files', () => {
    const { added, fire } = setup();
    const event = fire('paste', transferOf([new File(['%PDF-'], 'pasted.pdf')]), 'clipboardData');
    expect(event.defaultPrevented).toBe(true);
    expect(added).toEqual([{ names: ['pasted.pdf'], source: 'paste' }]);
  });

  it('leaves pasted text alone', () => {
    const { added, fire } = setup();
    const event = fire('paste', textTransfer, 'clipboardData');
    expect(event.defaultPrevented).toBe(false);
    expect(fire('paste', null, 'clipboardData').defaultPrevented).toBe(false);
    expect(added).toEqual([]);
  });
});

describe('file picker', () => {
  it('adds the chosen files', () => {
    const openPicker = vi.fn((onFiles: (files: File[]) => void) =>
      onFiles([new File(['%PDF-'], 'picked.pdf')]),
    );
    const { intake, added } = setup({ openPicker });
    intake.pickFiles();
    expect(openPicker).toHaveBeenCalledTimes(1);
    expect(added).toEqual([{ names: ['picked.pdf'], source: 'picker' }]);
  });

  it('adds nothing when the picker is dismissed', () => {
    const { intake, added } = setup({ openPicker: (onFiles) => onFiles([]) });
    intake.pickFiles();
    expect(added).toEqual([]);
  });

  it('does nothing where there is no picker', () => {
    const { intake } = setup();
    expect(() => intake.pickFiles()).not.toThrow();
  });
});

describe('outside a browser', () => {
  it('attaches to nothing', () => {
    const intake = createIntake({ addFiles: () => undefined });
    expect(() => intake.attach()()).not.toThrow();
    expect(intake.dragActive.value).toBe(false);
  });

  it('reads no files from a missing transfer', () => {
    expect(filesFromTransfer(null)).toEqual([]);
    expect(filesFromTransfer(undefined)).toEqual([]);
    expect(filesFromTransfer({} as DataTransfer)).toEqual([]);
  });
});

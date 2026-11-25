import { describe, expect, it, vi } from 'vitest';
import { DRAG_IDLE_MS, createIntake, filesFromTransfer, type IntakeEnvironment } from './intake';

interface FakeTransfer {
  types: string[];
  files: File[];
  dropEffect?: string;
}

function transferOf(files: File[] = [new File(['%PDF-'], 'a.pdf')]): FakeTransfer {
  return { types: ['Files'], files };
}

const textTransfer: FakeTransfer = { types: ['text/plain'], files: [] };

function setup(overrides: Partial<IntakeEnvironment> = {}) {
  const target = new EventTarget();
  const added: Array<{ names: string[]; source: string }> = [];
  let timer: (() => void) | undefined;
  const intake = createIntake({
    addFiles: (files, source) => added.push({ names: files.map((file) => file.name), source }),
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

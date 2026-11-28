/**
 * Random interleavings of everything a person can do with the list, checked against what must
 * hold whatever the order: nothing gets stuck, every Lock result that is handed out opens with
 * the password on screen, and no password outlives its use.
 */
import { describe, expect, it } from 'vitest';
import {
  DEMO_OWNER_PASSWORD,
  DEMO_PASSWORD,
  createDemoFile,
} from '../../tests/support/fake-engine';
import { createHarness, tick } from '../../tests/support/jobs-harness';
import type { Mode } from './mode';

/** mulberry32: the runs are the same every time, and a failure names its seed. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NAMES = [
  'plain.pdf',
  'needs-password.pdf',
  'same-password.pdf',
  'owner-only.pdf',
  'aes128.pdf',
  'rc4.pdf',
  'damaged.pdf',
  'read-failed.pdf',
  'crash.pdf',
];
const NEW_PASSWORDS = ['first-Passw0rd', 'second-Passw0rd', 'third-Passw0rd'];
const TYPED = [DEMO_PASSWORD, DEMO_OWNER_PASSWORD, 'nope'];
const MODES: readonly Mode[] = ['unlock', 'lock'];

async function play(seed: number): Promise<string[]> {
  const random = generator(seed);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)]!;
  const h = createHarness({
    mode: pick(MODES),
    engine: { hold: random() < 0.5 ? 0.5 : null, concurrency: 2 },
    settings: { autoSave: random() < 0.3 },
  });
  const runs: Promise<unknown>[] = [];
  const log: string[] = [];
  let copies = 0;

  for (let step = 0; step < 40; step++) {
    const roll = random();
    const entries = h.jobs.entries.value;
    const some = entries.length > 0 ? pick(entries) : undefined;
    if (roll < 0.16) {
      const name = pick(NAMES);
      const fileName = random() < 0.3 ? name.replace('.pdf', `-${++copies}.pdf`) : name;
      log.push(`add ${fileName}`);
      void h.jobs.addFiles([createDemoFile(fileName)], 'picker');
    } else if (roll < 0.36) {
      // The fields exist where the app shows them: the lock form with files in the list, the
      // shared unlock field while a file needs or may need a password.
      if (h.mode.value === 'lock' && entries.length > 0 && random() < 0.8) {
        const password = pick(NEW_PASSWORDS);
        log.push(`form ${password}`);
        h.fillLockForm(password);
        if (random() < 0.2) h.lockForm.setAlgorithm(pick(['aes-256', 'aes-128'] as const));
      } else if (h.mode.value === 'unlock' && h.jobs.summary.value.passwordField) {
        h.jobs.setUnlockPassword(pick(TYPED));
      }
      log.push('run');
      runs.push(h.jobs.runPrimary());
    } else if (roll < 0.44 && some) {
      log.push(`retryUnlock ${some.name}`);
      runs.push(h.jobs.retryUnlock(some.id, pick(TYPED)));
    } else if (roll < 0.52 && some) {
      log.push(`current ${some.name}`);
      h.jobs.setCurrentPassword(some.id, pick([...TYPED, '']));
    } else if (roll < 0.58 && some) {
      log.push(`cancel ${some.name}`);
      h.jobs.cancel(some.id);
    } else if (roll < 0.61) {
      log.push('cancelAll');
      h.jobs.cancelAll();
    } else if (roll < 0.68 && some) {
      log.push(`remove ${some.name}`);
      h.jobs.remove(some.id);
    } else if (roll < 0.7) {
      log.push('clear');
      h.jobs.clear();
    } else if (roll < 0.77) {
      h.mode.value = h.mode.value === 'unlock' ? 'lock' : 'unlock';
      log.push(h.mode.value);
    } else if (roll < 0.82 && some) {
      log.push(`redo ${some.name}`);
      h.jobs.redo(some.id);
    } else if (roll < 0.86 && some) {
      log.push(`retry ${some.name}`);
      h.jobs.retry(some.id);
    } else if (roll < 0.92) {
      log.push('release');
      h.engine.release();
      if (random() < 0.5) h.engine.setHold(0.5);
    } else {
      await tick();
    }
    if (random() < 0.5) await Promise.resolve();
  }

  h.engine.release();
  await Promise.allSettled(runs);
  await h.jobs.settled();
  await tick();
  await h.jobs.settled();

  const problems: string[] = [];
  for (const mode of MODES) {
    h.mode.value = mode;
    const states = h.states();
    if (states.includes('processing') || states.includes('analysing')) {
      problems.push(`stuck in ${mode} mode: ${states.join(', ')}`);
    }
  }

  // One set of lock settings: whatever the list hands out opens with the password on screen,
  // which is the result panel's once everything is finished and the form's until then. A result
  // made with anything else waits to be locked again and cannot be saved meanwhile.
  h.mode.value = 'lock';
  const applied = h.jobs.lockApplied.value;
  const finished = h.jobs.summary.value.phase === 'finished';
  const locked = h.jobs.entries.value.filter((entry) => entry.view.value.state === 'done');
  if (locked.length === 0 && applied !== null) {
    problems.push('applied settings are kept although the list has no lock result');
  }
  if (finished && applied === null) problems.push('lock results, but no settings to show for them');
  const shown = finished ? (applied?.password ?? '') : h.lockForm.options.value.userPassword;
  for (const entry of locked) {
    const offered = entry.view.value.result?.withheld === false;
    const before = h.save.calls.length;
    await h.jobs.save(entry.id);
    if (!offered) {
      if (finished) problems.push(`the result of ${entry.name} is withheld with nothing to do`);
      if (h.save.calls.length > before) problems.push(`${entry.name}: a withheld result was saved`);
      continue;
    }
    const output = h.save.calls.at(-1)!.files[0]!.blob;
    const opened = await h.engine.inspect(output, shown);
    if (!opened.encrypted || opened.access === 'locked') {
      problems.push(`the result of ${entry.name} does not open with the password shown`);
    }
    for (const other of NEW_PASSWORDS) {
      if (other === shown) continue;
      if ((await h.engine.inspect(output, other)).access !== 'locked') {
        problems.push(`the result of ${entry.name} opens with ${other}, which is not shown`);
      }
    }
  }
  // Results that differ among themselves never rest: the next run makes them alike.
  if (!finished && locked.some((entry) => entry.view.value.result?.withheld)) {
    const { primary } = h.jobs.summary.value;
    if (!primary || primary.count === 0) {
      problems.push('a result waits to be locked again, but nothing offers to do that');
    }
  }

  // Passwords go when nothing is left to use them on.
  h.mode.value = 'unlock';
  if (h.jobs.summary.value.needPassword === 0 && h.jobs.unlockPassword.value !== '') {
    problems.push('the unlock password is kept although no file needs one');
  }
  if (h.jobs.entries.value.length === 0) {
    if (h.lockForm.password.value !== '' || h.lockForm.revealed.value) {
      problems.push('the lock form keeps its password with an empty list');
    }
  }
  for (const entry of h.jobs.entries.value) {
    const view = entry.view.value;
    if (view.password && view.state !== 'wrong-password') {
      problems.push(`${entry.name} shows a retry field in state ${view.state}`);
    }
  }
  return problems.map((problem) => `seed ${seed}: ${problem} (${log.slice(-12).join(' > ')})`);
}

describe('random interleavings', () => {
  it('keep the list consistent', async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => void rejections.push(reason);
    process.on('unhandledRejection', onRejection);
    const problems: string[] = [];
    try {
      for (let seed = 1; seed <= 300; seed++) problems.push(...(await play(seed)));
      await tick();
    } finally {
      process.off('unhandledRejection', onRejection);
    }
    expect(problems).toEqual([]);
    expect(rejections).toEqual([]);
  }, 60_000);
});

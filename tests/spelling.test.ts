import { describe, expect, it } from 'bun:test';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventRouter } from '../src/adapters/gchat/events.js';
import { acceptedWords, skipReason, Spelling, typoNotice, type RawLint, type SpellEngine } from '../src/core/spelling.js';
import { HarperEngine } from '../src/integrations/harper.js';
import { makeStack, seedStandup, TENANT } from './helpers.js';

const lintOf = (text: string, word: string, index = 0): RawLint => {
  const start = text.indexOf(word);
  return { index, start, end: start + word.length, word, suggestion: null };
};

describe('what is checked (criteria 7, 8)', () => {
  it('leaves code, links, mentions, IDs, jargon and names alone', () => {
    const cases: [string, string, string | null][] = [
      ['Fixed the `useQueryClent` hook.', 'useQueryClent', 'code, link or mention'],
      ['See https://github.com/acme/api/pul/7 today.', 'pul', 'code, link or mention'],
      ['Paired with @Ashaa on it.', 'Ashaa', 'code, link or mention'],
      ['Bumped k8s and OAuth2.', 'k8s', 'digits'],
      ['Reply was n/a here.', 'n/a', 'joined'],
      ['Merged PROJ-1423 today.', 'PROJ', 'all capitals'],
      ['Fixed authService today.', 'authService', 'inner capital'],
      ['Moved to eu-west soon.', 'eu', 'joined'],
      ['Deployed via Terragrunt today.', 'Terragrunt', 'capitalised mid-sentence'],
      ['Done. Reveiwed the PR.', 'Reveiwed', null],
      ['Reveiwed the PR.', 'Reveiwed', null],
      ['Should be done tommorow.', 'tommorow', null],
      ['Hi: Wroking on it.', 'Wroking', null],
    ];
    for (const [text, word, reason] of cases) expect([word, skipReason(text, lintOf(text, word))]).toEqual([word, reason]);
  });

  it('reads the word list a line at a time, phrases word by word', () => {
    expect(acceptedWords('wfh\n  cron \r\nPager Duty\n\n')).toEqual(['wfh', 'cron', 'Pager', 'Duty']);
    expect(typoNotice([{ word: 'Reveiwed', suggestion: 'Reviewed' }, { word: 'teh', suggestion: 'the' }, { word: 'zzqx', suggestion: null }])).toBe(
      'Possible typos. Fix them, or submit again to send as is: Reveiwed → Reviewed · teh → the · zzqx',
    );
  });
});

/** An engine that finds the given words wherever they appear. */
function fakeEngine(words: Record<string, string | null>): SpellEngine & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async lint(texts, dialect) {
      calls.push(dialect);
      return texts.flatMap((text, index) => Object.entries(words).filter(([w]) => text.includes(w)).map(([w, s]) => ({ ...lintOf(text, w, index), suggestion: s })));
    },
  };
}

async function spellingStack(on = true) {
  const stack = await makeStack();
  const standup = await seedStandup(stack.repo); // Alice, Bob, Carol
  if (on) await stack.settings.update({ spellingEnabled: true, spellingWords: 'wfh\ncron' });
  const engine = fakeEngine({ Reveiwed: 'Reviewed', teh: 'the', wfh: null, Carol: null, Shrot: 'Short' });
  const logs: string[] = [];
  const spelling = new Spelling(stack.settings, stack.repo, engine, (m) => logs.push(m));
  return { ...stack, standup, engine, spelling, logs };
}

describe('Spelling', () => {
  it('is off by default, and British unless set (criteria 1, 5)', async () => {
    const { spelling, engine, settings } = await spellingStack(false);
    expect(await settings.get()).toMatchObject({ spellingEnabled: false, spellingDialect: 'en-GB', spellingWords: '' });
    expect(await spelling.typos(['Reveiwed it'])).toEqual([]);
    expect(engine.calls).toEqual([]);
  });

  it('accepts listed words and roster names, and lists each typo once (criteria 2, 9)', async () => {
    const { spelling, engine, settings } = await spellingStack();
    expect(await spelling.typos(['Reveiwed teh PR with Carol, wfh', 'Reveiwed again', ''])).toEqual([
      { word: 'Reveiwed', suggestion: 'Reviewed' },
      { word: 'teh', suggestion: 'the' },
    ]);
    await settings.update({ spellingDialect: 'en-US' });
    await spelling.typos(['x']);
    expect(engine.calls).toEqual(['en-GB', 'en-US']);
    expect(await spelling.typos(['', '  '])).toEqual([]);
  });

  it('never blocks: a failing checker means no suggestions (criterion 11)', async () => {
    const { settings, repo } = await spellingStack();
    const logs: string[] = [];
    const broken = new Spelling(settings, repo, { lint: async () => { throw new Error('no answer within 2000 ms'); } }, (m) => logs.push(m));
    expect(await broken.typos(['Reveiwed'])).toEqual([]);
    expect(logs).toEqual(['spelling check skipped: no answer within 2000 ms']);
    expect(await new Spelling(settings, repo, { lint: async () => { throw 'odd'; } }).typos(['x'])).toEqual([]);
    expect(await new Spelling(settings, repo, null).typos(['Reveiwed'])).toEqual([]);
  });
});

describe('the Chat answer form', () => {
  const form = (runId: number, inputs: Record<string, string>, shown = false) => ({
    type: 'CARD_CLICKED',
    isDialogEvent: true,
    common: { invokedFunction: 'submitStandup', parameters: { runId: String(runId), ...(shown ? { spellingShown: '1' } : {}) }, formInputs: Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, { stringInputs: { value: [v] } }])) },
    user: { name: 'users/alice', displayName: 'Alice', type: 'HUMAN' },
    space: { name: 'spaces/dm-alice', spaceType: 'DIRECT_MESSAGE' },
  });

  it('points out typos once with the answers kept, then saves them as typed (criteria 3, 4, 6)', async () => {
    const { commands, service, blockers, repo, spelling, standup, clock, scheduler } = await spellingStack();
    await repo.updateStandup(standup.id, { moodEnabled: true });
    const router = new EventRouter(commands, service, blockers, repo, TENANT, null, undefined, null, undefined, spelling);
    clock.set('2026-06-10T09:31');
    await scheduler.tick();
    const run = (await repo.getRun(standup.id, '2026-06-10'))!;
    const typed = { q0: 'Reveiwed teh PR', q1: 'Ship it', q2: 'none', mood: 'meh', moodComment: 'Shrot night' };

    const back: any = await router.handle(form(run.id, typed));
    const dialog = back.actionResponse.dialogAction.dialog.body.sections[0].widgets;
    expect(dialog[0].textParagraph.text).toBe('<b>Possible typos. Fix them, or submit again to send as is: Reveiwed → Reviewed · teh → the · Shrot → Short</b>');
    expect(dialog.find((w: any) => w.textInput?.name === 'q0').textInput.value).toBe('Reveiwed teh PR');
    expect(dialog.find((w: any) => w.textInput?.name === 'moodComment').textInput.value).toBe('Shrot night');
    const submit = dialog.at(-1).buttonList.buttons[0].onClick.action.parameters;
    expect(submit).toContainEqual({ key: 'spellingShown', value: '1' });
    expect(await repo.getSubmission(run.id, 'users/alice')).toBeNull();

    await router.handle(form(run.id, typed, true));
    expect((await repo.getSubmission(run.id, 'users/alice'))!.answers[0]!.answer).toBe('Reveiwed teh PR');

    // An edit is checked the same way; a clean one goes straight through.
    expect(((await router.handle(form(run.id, { ...typed, q1: 'teh rollout' }))) as any).actionResponse.dialogAction.dialog).toBeDefined();
    await router.handle(form(run.id, { ...typed, q0: 'Reviewed the PR', moodComment: 'Short night' }));
    expect((await repo.getSubmission(run.id, 'users/alice'))!.answers[0]!.answer).toBe('Reviewed the PR');
  });
});

describe('HarperEngine (criteria 9, 10, 11)', () => {
  it('finds British typos in a child process, switches dialect, and stops when idle', async () => {
    const engine = new HarperEngine(15_000, 60_000);
    try {
      const gb = await engine.lint(['Reveiwed the colour change', 'Optimised teh color picker'], 'en-GB');
      expect(gb.map((l) => [l.index, l.word, l.suggestion])).toEqual([
        [0, 'Reveiwed', 'Reviewed'],
        [1, 'teh', 'the'],
        [1, 'color', 'colour'],
      ]);
      const us = await engine.lint(['Reviewed the colour change'], 'en-US');
      expect(us.map((l) => l.word)).toEqual(['colour']);
    } finally {
      engine.stop();
    }
  }, 30_000);

  it('gives up after the timeout, and restarts after the child goes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'asyncup-spell-'));
    const silent = join(dir, 'silent.ts');
    writeFileSync(silent, "process.stdout.write('ready\\n\\n'); for await (const _ of console) {}");
    const quick = join(dir, 'quick.ts');
    writeFileSync(quick, "process.stdout.write('ready\\n'); for await (const line of console) { if (line) { process.stdout.write(JSON.stringify({ id: JSON.parse(line).id, lints: [] }) + '\\n'); process.exit(0); } }");
    const slow = new HarperEngine(300, 60_000, silent);
    await expect(slow.lint(['x'], 'en-GB')).rejects.toThrow('no answer within 300 ms');
    const never = join(dir, 'never.ts');
    writeFileSync(never, 'for await (const _ of console) {}');
    const stuck = new HarperEngine(300, 60_000, never, 300);
    await expect(stuck.lint(['x'], 'en-GB')).rejects.toThrow('not started within 300 ms');
    expect((slow as any).child).toBeNull(); // the next request gets a fresh one
    slow.stop();
    slow.stop();

    const engine = new HarperEngine(5_000, 50, quick);
    expect(await engine.lint(['x'], 'en-GB')).toEqual([]);
    await Bun.sleep(300); // the child exited after answering, and the idle timer fired
    expect(await engine.lint(['y'], 'en-GB')).toEqual([]);
    engine.stop();
  }, 20_000);
});

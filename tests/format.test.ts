import { describe, expect, it } from 'bun:test';
import { blockerCard, standupDialog, submissionMessage, tagBlockerDialog } from '../src/adapters/gchat/cards.js';
import { blankMarkers, parseFormatted, toCardHtml, toChatText } from '../src/core/format.js';
import { Spelling, type SpellEngine } from '../src/core/spelling.js';
import { DEFAULT_QUESTIONS, type Blocker } from '../src/core/types.js';
import { ANSWERS, makeStack, seedStandup } from './helpers.js';

describe('the shorthand', () => {
  it('formats bold, italic, strike, underline and code (criterion 1)', () => {
    expect(toCardHtml('*done* _soon_ ~maybe~ __must__ `orders-db`')).toBe('<b>done</b> <i>soon</i> <s>maybe</s> <u>must</u> <code>orders-db</code>');
    expect(toCardHtml('*bold with _italic_ inside*')).toBe('<b>bold with <i>italic</i> inside</b>');
    expect(toCardHtml('(*yes*), "_quoted_".')).toBe('(<b>yes</b>), "<i>quoted</i>".');
  });

  it('turns lines starting with - into one list, and keeps other lines apart (criterion 1)', () => {
    expect(toCardHtml('Today:\n- Finish the *cutover*\n- Tidy the runbook\nThen lunch')).toBe('Today:<ul><li>Finish the <b>cutover</b></li><li>Tidy the runbook</li></ul>Then lunch');
    expect(toCardHtml('one\ntwo')).toBe('one<br>two');
    expect(toCardHtml('  - indented item')).toBe('<ul><li>indented item</li></ul>');
    expect(parseFormatted('a\n\nb')).toEqual([{ type: 'lines', lines: [[{ type: 'text', text: 'a' }], [], [{ type: 'text', text: 'b' }]] }]);
  });

  it('only counts markers against the text, at word edges, on one line (criterion 2)', () => {
    for (const plain of ['snake_case_name', '2*3*4', 'file_name.ts', '* not bold *', 'an unmatched * star', 'a ~ b', '_open only', 'trailing_', '-not a list', '*one\nline*', '__ spaced __', '**', '``']) {
      expect(toCardHtml(plain)).toBe(plain.replace(/\n/g, '<br>'));
    }
    expect(toCardHtml('x*y* and *z*')).toBe('x*y* and <b>z</b>');
    expect(toCardHtml('*a*b*')).toBe('<b>a*b</b>');
  });

  it('leaves text inside backticks alone (criterion 3)', () => {
    expect(toCardHtml('`*not bold* and __init__`')).toBe('<code>*not bold* and __init__</code>');
    expect(toCardHtml('*see `a*b` here*')).toBe('<b>see <code>a*b</code> here</b>');
  });

  it('shows any other HTML as typed (criterion 4)', () => {
    expect(toCardHtml('<b>hi</b> & <a href="x">link</a>')).toBe('&lt;b&gt;hi&lt;/b&gt; &amp; &lt;a href="x"&gt;link&lt;/a&gt;');
    expect(toCardHtml('`<script>`')).toBe('<code>&lt;script&gt;</code>');
  });

  it('keeps Chat’s own syntax in text messages and drops underline markers (criterion 7)', () => {
    expect(toChatText('*done* _soon_ ~maybe~ __must__ `x`\n- one\n  - two')).toBe('*done* _soon_ ~maybe~ must `x`\n- one\n- two');
    expect(toChatText('plain 2*3*4')).toBe('plain 2*3*4');
  });

  it('blanks the markers but keeps positions and code, for spelling (criterion 11)', () => {
    const text = '*Reveiwed* __teh__ `x_y` 2*3';
    const blank = blankMarkers(text);
    expect(blank).toBe(' Reveiwed    teh   `x_y` 2*3');
    expect(blank.length).toBe(text.length);
    expect(blankMarkers('a\n- *b*')).toBe('a\n-  b ');
  });
});

describe('where it shows', () => {
  const blocker = { id: 3, text: 'Waiting on __DBA approval__ for `orders-db` <now>', displayName: 'Bob', openedDate: '2026-06-08', standupId: 1 } as unknown as Blocker;

  it('renders the posted answer card (criterion 5)', () => {
    const sub = { id: 1, displayName: 'Alice', late: false, editedAt: null, editApprovedBy: null, answers: [
      { question: DEFAULT_QUESTIONS[0], answer: '*Migrated* ~three~ two services' },
      { question: DEFAULT_QUESTIONS[1], answer: '- Cutover\n- Runbook' },
      { question: DEFAULT_QUESTIONS[2], answer: 'Waiting on __DBA__ <b>' },
    ] } as any;
    const widgets = submissionMessage(sub).cardsV2[0]!.card.sections[0]!.widgets.map((w: any) => w.decoratedText.text);
    expect(widgets).toEqual(['<b>Migrated</b> <s>three</s> two services', '<ul><li>Cutover</li><li>Runbook</li></ul>', '⚠️ Waiting on <u>DBA</u> &lt;b&gt;']);
  });

  it('renders blocker cards and the tag dialog (criterion 6)', () => {
    expect(JSON.stringify(blockerCard({ name: 'Daily' } as any, blocker, 'note'))).toContain('Waiting on <u>DBA approval</u> for <code>orders-db</code> &lt;now&gt;');
    expect(JSON.stringify(tagBlockerDialog(blocker))).toContain('Waiting on <u>DBA approval</u> for <code>orders-db</code> &lt;now&gt;');
  });

  it('keeps Chat syntax in plain messages that quote a blocker (criterion 7)', async () => {
    const { repo, blockers, adapter } = await makeStack();
    const standup = await seedStandup(repo);
    const run = await repo.createRun(standup.id, '2026-06-10', 'k');
    await repo.openBlocker({ standupId: standup.id, userName: 'users/alice', displayName: 'Alice', text: 'Waiting on __DBA__ *now*', runId: run.id, date: run.date });
    const b = (await repo.listOpenBlockers(standup.id))[0]!;
    await blockers.resolve(b.id, { userName: 'users/alice', displayName: 'Alice' });
    expect(adapter.dms.concat(adapter.posts as any).some((m: any) => m.text?.includes('"Waiting on DBA *now*"'))).toBe(true);
  });

  it('lists the shorthand in every answer field’s hint (criterion 10)', () => {
    const dialog = standupDialog(1, [...DEFAULT_QUESTIONS], false, ['', '', '']);
    const hints = (dialog.actionResponse.dialogAction.dialog.body.sections[0]!.widgets as any[]).filter((w) => w.textInput).map((w) => w.textInput.hintText);
    const fmt = 'Formatting: *bold* _italic_ ~strike~ __underline__ `code`, and - for a list.';
    expect(hints).toEqual([fmt, fmt, `Write "none" if you have no blockers. ${fmt}`]);
  });

  it('stores, exports and sends the text exactly as typed (criterion 9)', async () => {
    const bodies: any[] = [];
    const webhookFetch = (async (_u: string, init: RequestInit) => (bodies.push(JSON.parse(String(init.body))), new Response('ok'))) as unknown as typeof fetch;
    const { repo, service, scheduler, clock } = await makeStack({ webhookFetch });
    const standup = await seedStandup(repo);
    await repo.updateStandup(standup.id, { webhookUrl: 'https://hooks.example.com/x' });
    clock.set('2026-06-10T09:30');
    await scheduler.tick();
    const run = (await repo.getRun(standup.id, '2026-06-10'))!;
    const typed = { ...ANSWERS, answers: ANSWERS.answers.map((a, i) => (i === 0 ? { ...a, answer: '*Shipped* `x` __now__' } : a)) };
    expect((await service.submit(run.id, 'users/alice', 'Alice', typed)).ok).toBe(true);
    expect((await repo.getSubmission(run.id, 'users/alice'))!.answers[0]!.answer).toBe('*Shipped* `x` __now__');
    expect(bodies.filter((x) => x.event === 'submission')).toHaveLength(1);
    for (const b of bodies.filter((x) => x.event === 'submission')) expect(b.answers[0].answer).toBe('*Shipped* `x` __now__');
  });
});

describe('spelling and the shorthand', () => {
  it('checks the words inside markers and never flags a marker (criterion 11)', async () => {
    const { repo, settings } = await makeStack();
    await settings.update({ spellingEnabled: true });
    const seen: string[] = [];
    const engine: SpellEngine = {
      async lint(texts) {
        seen.push(...texts);
        const text = texts[0]!;
        const at = text.indexOf('teh');
        return [{ index: 0, start: at, end: at + 3, word: 'teh', suggestion: 'the' }];
      },
    };
    const spelling = new Spelling(settings, repo, engine);
    expect(await spelling.typos(['done __teh__ thing'])).toEqual([{ word: 'teh', suggestion: 'the' }]);
    expect(seen).toEqual(['done   teh   thing']);
  });
});

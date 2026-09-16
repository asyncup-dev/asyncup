import { describe, expect, it } from 'bun:test';
import {
  blockerCard,
  blockerUpdateDialog,
  pollMessage,
  reminderMessage,
  submissionMessage,
  summaryText,
  threadParentText,
} from '../src/adapters/gchat/cards.js';
import type { Blocker, Poll, Run, RunSummary, Standup, Submission } from '../src/core/types.js';

const standup: Standup = {
  id: 1,
  tenantId: 'default',
  spaceName: 'spaces/team',
  name: 'Daily Standup',
  promptTime: '09:30',
  deadlineTime: '11:30',
  reminderMinutesBefore: 60,
  timezone: 'Asia/Kolkata',
  days: 'mon,tue,wed,thu,fri',
  questions: null,
  moodEnabled: true,
  moodAnonymous: false,
  digestEnabled: false,
  escalateUserName: null,
  escalateDisplayName: null,
  escalateAfterDays: 0,
  webhookUrl: null,
  active: true,
};

const run: Run = { id: 7, standupId: 1, date: '2026-06-10', threadKey: 'standup-1-2026-06-10', status: 'open' };

const blocker: Blocker = {
  id: 3,
  standupId: 1,
  userName: 'users/alice',
  displayName: 'Alice',
  text: 'Waiting on API keys',
  openedRunId: 7,
  openedDate: '2026-06-10',
  resolvedRunId: null,
  resolvedDate: null,
  resolvedBy: null,
  escalatedAt: null,
};

const poll: Poll = {
  id: 4,
  standupId: 1,
  question: 'Retro on Friday?',
  options: ['Yes', 'No', 'Maybe'],
  createdBy: 'users/admin',
  createdDisplay: 'Admin',
  messageName: null,
  closedAt: null,
};

const summary: RunSummary = {
  standupName: 'Daily Standup',
  date: '2026-06-10',
  teamMood: null,
  mandatoryTotal: 2,
  mandatorySubmitted: 2,
  missingMandatory: [],
  away: [],
  optionalSubmitted: 0,
  lateCount: 0,
  openBlockers: 0,
};

function actionsOf(buttons: any[]) {
  return buttons.map((b) => b.onClick.action);
}

describe('cards (reminder, blocker, poll, thread and summary variants)', () => {
  it('reminder card names the deadline and offers the same fill/skip actions as the prompt', () => {
    const card: any = reminderMessage(standup, run).cardsV2[0];
    expect(card.cardId).toBe('standup-reminder-7');
    const widgets = card.card.sections[0].widgets;
    expect(widgets[0].textParagraph.text).toContain('Daily Standup');
    expect(widgets[0].textParagraph.text).toContain('Wed, 10 Jun 2026');
    expect(widgets[0].textParagraph.text).toContain('11:30 Asia/Kolkata');
    const buttons = widgets[1].buttonList.buttons;
    expect(buttons.map((b: any) => b.text)).toEqual(['Fill standup now', '🏖️ Skip today']);
    expect(actionsOf(buttons).map((a) => a.function)).toEqual(['openStandupDialog', 'skipToday']);
    expect(actionsOf(buttons)[0].interaction).toBe('OPEN_DIALOG');
    for (const action of actionsOf(buttons)) {
      expect(action.parameters).toEqual([{ key: 'runId', value: '7' }]);
    }
  });

  it('blocker card shows the report and carries the blockerId on ack/update/resolve', () => {
    const card: any = blockerCard(standup, blocker, 'Alice tagged you').cardsV2[0];
    expect(card.cardId).toBe('blocker-3');
    expect(card.card.header.title).toBe('⚠️ Blocker #3 — Daily Standup');
    expect(card.card.header.subtitle).toBe('Alice tagged you');
    const [report, buttons] = card.card.sections[0].widgets;
    expect(report.decoratedText.topLabel).toBe('Reported by Alice on 2026-06-10');
    expect(report.decoratedText.text).toBe('Waiting on API keys');
    const actions = actionsOf(buttons.buttonList.buttons);
    expect(actions.map((a) => a.function)).toEqual(['ackBlocker', 'openBlockerUpdate', 'resolveBlocker']);
    expect(actions[1].interaction).toBe('OPEN_DIALOG');
    for (const action of actions) {
      expect(action.parameters).toEqual([{ key: 'blockerId', value: '3' }]);
    }
  });

  it('blocker update dialog has one multi-line input and submits with the blockerId', () => {
    const dialog: any = blockerUpdateDialog(3);
    expect(dialog.actionResponse.type).toBe('DIALOG');
    const [input, buttons] = dialog.actionResponse.dialogAction.dialog.body.sections[0].widgets;
    expect(input.textInput.name).toBe('update');
    expect(input.textInput.type).toBe('MULTIPLE_LINE');
    const action = buttons.buttonList.buttons[0].onClick.action;
    expect(action.function).toBe('submitBlockerUpdate');
    expect(action.parameters).toEqual([{ key: 'blockerId', value: '3' }]);
  });

  it('open poll card has a vote button per option, tallies and a close hint', () => {
    const card: any = pollMessage(poll, [1, 0]).cardsV2[0];
    expect(card.cardId).toBe('poll-4');
    expect(card.card.header.title).toBe('📊 Retro on Friday?');
    expect(card.card.header.subtitle).toBe('Poll #4 by Admin');
    const widgets = card.card.sections[0].widgets;
    const options = widgets.slice(0, 3).map((w: any) => w.decoratedText);
    expect(options.map((o: any) => o.text)).toEqual(['Yes', 'No', 'Maybe']);
    expect(options.map((o: any) => o.bottomLabel)).toEqual(['1 vote', '0 votes', '0 votes']);
    expect(options.map((o: any) => o.button.onClick.action.parameters)).toEqual([
      [{ key: 'pollId', value: '4' }, { key: 'optionIndex', value: '0' }],
      [{ key: 'pollId', value: '4' }, { key: 'optionIndex', value: '1' }],
      [{ key: 'pollId', value: '4' }, { key: 'optionIndex', value: '2' }],
    ]);
    expect(options[0].button.onClick.action.function).toBe('votePoll');
    expect(widgets[3].textParagraph.text).toContain('1 vote so far');
    expect(widgets[3].textParagraph.text).toContain('<b>poll 4 close</b>');
  });

  it('closed poll card drops the vote buttons and marks the tally final', () => {
    const card: any = pollMessage(poll, [2, 1, 0], true).cardsV2[0];
    expect(card.card.header.subtitle).toBe('Poll #4 by Admin — closed');
    const widgets = card.card.sections[0].widgets;
    for (const w of widgets.slice(0, 3)) expect(w.decoratedText.button).toBeUndefined();
    expect(widgets[3].textParagraph.text).toBe('<i>3 votes — final.</i>');
  });

  it('thread parent names the standup and the human date', () => {
    expect(threadParentText(standup, run)).toBe('📅 *Daily Standup* — Wed, 10 Jun 2026');
  });

  it('submission card hides the mood when the standup is anonymous', () => {
    const submission: Submission = {
      id: 1,
      runId: 7,
      userName: 'users/alice',
      displayName: 'Alice',
      answers: [{ question: 'What shipped?', answer: 'Auth' }],
      mood: 'great',
      late: false,
      submittedAt: '2026-06-10T04:30:00Z',
      editedAt: null,
      messageName: null,
    };
    const header: any = submissionMessage(submission, true).cardsV2[0]!.card.header;
    expect(header.title).toBe('📝 Alice');
    expect(header.subtitle).toBeUndefined();
  });

  it('summary text handles no mandatory participants, team mood, optional, late and a single blocker', () => {
    expect(summaryText({ ...summary, mandatoryTotal: 0, mandatorySubmitted: 0 })).toBe(
      '📊 *Daily Standup* — Wed, 10 Jun 2026 wrap-up\nNo mandatory participants expected today.',
    );

    const rich = summaryText({
      ...summary,
      teamMood: 4.2,
      optionalSubmitted: 1,
      lateCount: 1,
      openBlockers: 1,
    });
    expect(rich.split('\n')).toEqual([
      '📊 *Daily Standup* — Wed, 10 Jun 2026 wrap-up',
      '✅ *2/2* mandatory submitted',
      '🎉 Everyone submitted!',
      '💭 Team mood today: 🙂 4.2/5',
      '➕ 1 optional submitted',
      '⏰ 1 late',
      '⚠️ 1 open blocker',
    ]);
  });
});

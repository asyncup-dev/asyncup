import { describe, expect, it } from 'bun:test';
import {
  promptMessage,
  standupDialog,
  submissionMessage,
  summaryText,
} from '../src/adapters/gchat/cards.js';
import type { Run, RunSummary, Standup, Submission } from '../src/core/types.js';

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
  timeOffPolicy: 'self',
  rosterGroup: null,
  rosterSyncedAt: null,
  rosterSyncError: null,
  escalateUserName: null,
  escalateDisplayName: null,
  escalateAfterDays: 0,
  webhookUrl: null,
  active: true,
};

const run: Run = { id: 7, standupId: 1, date: '2026-06-10', threadKey: 'standup-1-2026-06-10', status: 'open' };

const QUESTIONS = ['What did you do yesterday?', 'What will you do today?', 'Any blockers?'];

describe('cards', () => {
  it('prompt card offers fill (dialog) and skip buttons with the runId', () => {
    const json = JSON.stringify(promptMessage(standup, run));
    expect(json).toContain('"openStandupDialog"');
    expect(json).toContain('"OPEN_DIALOG"');
    expect(json).toContain('"openSkipDialog"');
    expect(json).toContain('{"key":"runId","value":"7"}');
  });

  it('addresses clicks to the events URL and carries the action name as a parameter for add-on builds', () => {
    const url = 'https://standup.example.com/chat/events';
    const buttons = (promptMessage(standup, run, url) as any).cardsV2[0].card.sections.at(-1).widgets.at(-1).buttonList.buttons;
    expect(buttons[0].onClick.action).toEqual({
      function: url,
      interaction: 'OPEN_DIALOG',
      parameters: [
        { key: 'fn', value: 'openStandupDialog' },
        { key: 'runId', value: '7' },
      ],
    });
    expect(buttons[1].onClick.action).toEqual({ function: url, interaction: 'OPEN_DIALOG', parameters: [{ key: 'fn', value: 'openSkipDialog' }, { key: 'runId', value: '7' }] });
    const submit = (standupDialog(7, QUESTIONS, false, [], url) as any).actionResponse.dialogAction.dialog.body.sections[0].widgets.at(-1).buttonList.buttons[0];
    // no requiredWidgets: the server checks every answer on submit
    expect(submit.onClick.action).toEqual({ function: url, parameters: [{ key: 'fn', value: 'submitStandup' }, { key: 'runId', value: '7' }] });
  });

  it('dialog is built from the question list with prefill values', () => {
    const dialog: any = standupDialog(7, QUESTIONS, true, ['From last time', '', '']);
    const widgets = dialog.actionResponse.dialogAction.dialog.body.sections[0].widgets;
    const inputs = widgets.filter((w: any) => w.textInput).map((w: any) => w.textInput);
    expect(inputs.map((i: any) => i.name)).toEqual(['q0', 'q1', 'q2', 'moodComment']);
    expect(inputs.slice(0, 3).map((i: any) => i.label)).toEqual(QUESTIONS.map((q) => `${q} (required)`));
    expect(inputs[0].value).toBe('From last time');
    expect(inputs[1].value).toBeUndefined();
    const mood = widgets.find((w: any) => w.selectionInput)?.selectionInput;
    expect(mood.items).toHaveLength(5);
    expect(mood.label).toBe('How is your mood today? (required)');
    // The optional comment comes straight after the mood, with its privacy promise.
    expect(widgets.indexOf(widgets.find((w: any) => w.textInput?.name === 'moodComment'))).toBe(widgets.indexOf(widgets.find((w: any) => w.selectionInput)) + 1);
    expect(inputs[3]).toEqual({ name: 'moodComment', label: 'Want to say why? (optional)', type: 'SINGLE_LINE', value: undefined, hintText: 'Only people allowed to read mood comments see this. It is never posted in the space.' });
    expect(JSON.stringify(widgets)).toContain('"submitStandup"');
  });

  it('dialog can come back with an error line, the answers kept and the mood still picked', () => {
    const dialog: any = standupDialog(7, QUESTIONS, true, ['Did X', 'Will <b>Y</b>', ''], null, { error: 'Still empty: "Any blockers?"', mood: 'good', moodComment: 'Busy week' });
    const widgets = dialog.actionResponse.dialogAction.dialog.body.sections[0].widgets;
    expect(widgets[0].textParagraph.text).toBe('<font color="#d93025"><b>⚠️ Still empty: "Any blockers?"</b></font>');
    expect(widgets[2].textInput.value).toBe('Will <b>Y</b>');
    expect(widgets.find((w: any) => w.selectionInput).selectionInput.items.filter((i: any) => i.selected).map((i: any) => i.value)).toEqual(['good']);
    expect(widgets.find((w: any) => w.textInput?.name === 'moodComment').textInput.value).toBe('Busy week');
  });

  it('dialog omits the mood dropdown when disabled and supports custom questions', () => {
    const dialog: any = standupDialog(7, ['What shipped?'], false, ['']);
    const widgets = dialog.actionResponse.dialogAction.dialog.body.sections[0].widgets;
    expect(widgets.filter((w: any) => w.selectionInput)).toHaveLength(0);
    expect(widgets.some((w: any) => w.textInput?.name === 'moodComment')).toBe(false);
    expect(widgets[0].textInput.label).toBe('What shipped? (required)');
  });

  it('submission card renders answers, highlights blockers, flags late/edited', () => {
    const base: Submission = {
      id: 1,
      runId: 7,
      userName: 'users/alice',
      displayName: 'Alice',
      answers: [
        { question: 'What did you do yesterday?', answer: 'Auth refactor' },
        { question: 'What will you do today?', answer: 'Billing webhooks' },
        { question: 'Any blockers?', answer: 'none' },
      ],
      mood: 'great',
      late: false,
      submittedAt: '2026-06-10T04:30:00Z',
      editedAt: null,
      messageName: null, moodComment: null,
    };
    const clean = JSON.stringify(submissionMessage(base));
    expect(clean).toContain('📝 Alice');
    expect(clean).not.toContain('😄');
    expect(clean).toContain('✅ None');

    const flagged = JSON.stringify(
      submissionMessage({
        ...base,
        answers: [...base.answers.slice(0, 2), { question: 'Any blockers?', answer: 'Waiting on API keys' }],
        late: true,
        editedAt: '2026-06-10T05:00:00Z',
        mood: null,
      }),
    );
    expect(flagged).toContain('⚠️ Waiting on API keys');
    expect(flagged).toContain('Submitted late · edited');
    expect(flagged).toContain('📝 Alice');
  });

  it('summary text reports count, missing, away and blockers', () => {
    const summary: RunSummary = {
      standupName: 'Daily Standup',
      date: '2026-06-10',
      mandatoryTotal: 7,
      mandatorySubmitted: 5,
      missingMandatory: ['Asha', 'Rohit'],
      away: ['Dave'],
      optionalSubmitted: 1,
      lateCount: 2,
      openBlockers: 3,
      teamMood: null,
    };
    const text = summaryText(summary);
    expect(text).toContain('*5/7* mandatory submitted');
    expect(text).toContain('❌ Missing: Asha, Rohit');
    expect(text).toContain('🏖️ Away: Dave');
    expect(text).toContain('⚠️ 3 open blockers');

    const allDone = summaryText({ ...summary, mandatorySubmitted: 7, missingMandatory: [] });
    expect(allDone).toContain('🎉 Everyone submitted!');
  });
});

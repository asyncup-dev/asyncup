import { describe, expect, it } from 'vitest';
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
  digestEnabled: false,
  aiEnabled: false,
  active: true,
};

const run: Run = { id: 7, standupId: 1, date: '2026-06-10', threadKey: 'standup-1-2026-06-10', status: 'open' };

const QUESTIONS = ['What did you do yesterday?', 'What will you do today?', 'Any blockers?'];

describe('cards', () => {
  it('prompt card offers fill (dialog) and skip buttons with the runId', () => {
    const json = JSON.stringify(promptMessage(standup, run));
    expect(json).toContain('"openStandupDialog"');
    expect(json).toContain('"OPEN_DIALOG"');
    expect(json).toContain('"skipToday"');
    expect(json).toContain('{"key":"runId","value":"7"}');
  });

  it('dialog is built from the question list with prefill values', () => {
    const dialog: any = standupDialog(7, QUESTIONS, true, ['From last time', '', '']);
    const widgets = dialog.actionResponse.dialogAction.dialog.body.sections[0].widgets;
    const inputs = widgets.filter((w: any) => w.textInput).map((w: any) => w.textInput);
    expect(inputs.map((i: any) => i.name)).toEqual(['q0', 'q1', 'q2']);
    expect(inputs.map((i: any) => i.label)).toEqual(QUESTIONS);
    expect(inputs[0].value).toBe('From last time');
    expect(inputs[1].value).toBeUndefined();
    const mood = widgets.find((w: any) => w.selectionInput)?.selectionInput;
    expect(mood.items).toHaveLength(5);
    expect(JSON.stringify(widgets)).toContain('"submitStandup"');
  });

  it('dialog omits the mood dropdown when disabled and supports custom questions', () => {
    const dialog: any = standupDialog(7, ['What shipped?'], false, ['']);
    const widgets = dialog.actionResponse.dialogAction.dialog.body.sections[0].widgets;
    expect(widgets.filter((w: any) => w.selectionInput)).toHaveLength(0);
    expect(widgets[0].textInput.label).toBe('What shipped?');
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
      messageName: null,
    };
    const clean = JSON.stringify(submissionMessage(base));
    expect(clean).toContain('😄 Alice');
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

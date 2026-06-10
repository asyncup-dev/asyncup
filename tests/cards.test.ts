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
  active: true,
};

const run: Run = { id: 7, standupId: 1, date: '2026-06-10', threadKey: 'standup-1-2026-06-10', status: 'open' };

describe('cards', () => {
  it('prompt card carries the runId and opens the dialog', () => {
    const json = JSON.stringify(promptMessage(standup, run));
    expect(json).toContain('"openStandupDialog"');
    expect(json).toContain('"OPEN_DIALOG"');
    expect(json).toContain('{"key":"runId","value":"7"}');
  });

  it('dialog has the four questions and submit action', () => {
    const dialog: any = standupDialog(7);
    expect(dialog.actionResponse.type).toBe('DIALOG');
    const widgets = dialog.actionResponse.dialogAction.dialog.body.sections[0].widgets;
    const names = widgets.filter((w: any) => w.textInput).map((w: any) => w.textInput.name);
    expect(names).toEqual(['yesterday', 'today', 'blockers']);
    const mood = widgets.find((w: any) => w.selectionInput)?.selectionInput;
    expect(mood.name).toBe('mood');
    expect(mood.items).toHaveLength(5);
    expect(JSON.stringify(widgets)).toContain('"submitStandup"');
  });

  it('submission card shows answers and highlights blockers', () => {
    const base: Submission = {
      id: 1,
      runId: 7,
      userName: 'users/alice',
      displayName: 'Alice',
      yesterday: 'Auth refactor',
      today: 'Billing webhooks',
      blockers: 'none',
      mood: 'great',
      late: false,
      submittedAt: '2026-06-10T04:30:00Z',
    };
    const clean = JSON.stringify(submissionMessage(base));
    expect(clean).toContain('😄 Alice');
    expect(clean).toContain('✅ None');

    const blocked = JSON.stringify(
      submissionMessage({ ...base, blockers: 'Waiting on API keys', late: true }),
    );
    expect(blocked).toContain('⚠️ Waiting on API keys');
    expect(blocked).toContain('Submitted late');
  });

  it('summary text reports count, missing names and extras', () => {
    const summary: RunSummary = {
      standupName: 'Daily Standup',
      date: '2026-06-10',
      mandatoryTotal: 9,
      mandatorySubmitted: 7,
      missingMandatory: ['Asha', 'Rohit'],
      optionalSubmitted: 1,
      lateCount: 2,
    };
    const text = summaryText(summary);
    expect(text).toContain('*7/9* mandatory submitted');
    expect(text).toContain('❌ Missing: Asha, Rohit');
    expect(text).toContain('➕ 1 optional submitted');
    expect(text).toContain('⏰ 2 late');

    const allDone = summaryText({ ...summary, mandatorySubmitted: 9, missingMandatory: [] });
    expect(allDone).toContain('🎉 Everyone submitted!');
  });
});

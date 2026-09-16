import { describe, expect, it } from 'bun:test';
import { AiSummarizer } from '../src/ai/summarizer.js';
import type { Run, Standup, Submission, WeeklyDigest } from '../src/core/types.js';

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
  aiEnabled: true,
  escalateUserName: null,
  escalateDisplayName: null,
  escalateAfterDays: 0,
  webhookUrl: null,
  active: true,
};

const run: Run = { id: 7, standupId: 1, date: '2026-06-10', threadKey: 'k', status: 'open' };

const alice: Submission = {
  id: 1,
  runId: 7,
  userName: 'users/alice',
  displayName: 'Alice',
  answers: [
    { question: 'What did you do yesterday?', answer: 'Auth refactor' },
    { question: 'Any blockers?', answer: 'none' },
  ],
  mood: 'great',
  late: false,
  submittedAt: '2026-06-10T04:30:00Z',
  editedAt: null,
  messageName: null,
};

const bob: Submission = {
  ...alice,
  id: 2,
  userName: 'users/bob',
  displayName: 'Bob',
  answers: [{ question: 'What did you do yesterday?', answer: 'Billing webhooks' }],
  mood: null,
};

function fakeLlm(reply = 'summary') {
  const calls: { system: string; prompt: string }[] = [];
  const complete = async (system: string, prompt: string) => {
    calls.push({ system, prompt });
    return reply;
  };
  return { complete, calls };
}

describe('AiSummarizer', () => {
  it('daily summary sends every submission with its answers and mood, and returns the completion', async () => {
    const { complete, calls } = fakeLlm('Three bullets');
    const result = await new AiSummarizer(complete).dailySummary(standup, run, [alice, bob]);

    expect(result).toBe('Three bullets');
    expect(calls).toHaveLength(1);
    const { system, prompt } = calls[0]!;
    expect(system).toContain('daily standup');
    expect(system).toContain('3-5 short bullet points');
    expect(prompt).toStartWith('Standup "Daily Standup" for 2026-06-10. Submissions:\n\n');
    expect(prompt).toContain('Alice (mood: 😄 Great):\n  What did you do yesterday? Auth refactor\n  Any blockers? none');
    expect(prompt).toContain('\n\nBob:\n  What did you do yesterday? Billing webhooks');
    expect(prompt).not.toContain('Bob (mood');
  });

  it('weekly summary groups submissions by run date with the digest window and participation', async () => {
    const { complete, calls } = fakeLlm('Week in review');
    const digest: WeeklyDigest = {
      standupName: 'Daily Standup',
      weekStart: '2026-06-08',
      weekEnd: '2026-06-12',
      runCount: 5,
      participationPct: 80,
      prevParticipationPct: null,
      avgMood: 4,
      prevAvgMood: null,
      blockersOpened: 1,
      blockersResolved: 0,
      openBlockers: [],
    };
    const result = await new AiSummarizer(complete).weeklySummary(standup, digest, [
      { runDate: '2026-06-08', submission: alice },
      { runDate: '2026-06-09', submission: bob },
    ]);

    expect(result).toBe('Week in review');
    const { system, prompt } = calls[0]!;
    expect(system).toContain('week in review');
    expect(system).toContain('max 6 bullet points');
    expect(prompt).toStartWith(
      'Standup "Daily Standup", week 2026-06-08 to 2026-06-12. Participation 80%. Submissions by day:\n\n',
    );
    expect(prompt).toContain('[2026-06-08] Alice (mood: 😄 Great):\n  What did you do yesterday? Auth refactor');
    expect(prompt).toContain('\n\n[2026-06-09] Bob:\n  What did you do yesterday? Billing webhooks');
  });
});

import { describe, expect, it } from 'bun:test';
import { buildWeeklyDigest, digestText, moodEmoji, trendsText } from '../src/core/insights.js';
import type { WeeklyDigest } from '../src/core/types.js';
import { ANSWERS, makeStack, seedStandup, withBlocker } from './helpers.js';

// Week of 2026-06-08 (Mon) → 2026-06-14; the week before is 2026-06-01 → 2026-06-07.
async function seedTwoWeeks() {
  const stack = await makeStack();
  const standup = await seedStandup(stack.repo);

  stack.clock.set('2026-06-03T10:00');
  const previous = await stack.repo.createRun(standup.id, '2026-06-03', 'k-prev');
  await stack.service.submit(previous.id, 'users/alice', 'Alice', ANSWERS);
  await stack.service.submit(previous.id, 'users/bob', 'Bob', ANSWERS);
  await stack.repo.closeRun(previous.id);

  stack.clock.set('2026-06-10T10:00');
  const current = await stack.repo.createRun(standup.id, '2026-06-10', 'k-cur');
  await stack.service.submit(current.id, 'users/alice', 'Alice', withBlocker('Waiting on API keys'));
  await stack.repo.closeRun(current.id);

  return { ...stack, standup };
}

const baseDigest: WeeklyDigest = {
  standupName: 'Daily Standup',
  weekStart: '2026-06-08',
  weekEnd: '2026-06-14',
  runCount: 3,
  participationPct: 80,
  prevParticipationPct: null,
  avgMood: null,
  prevAvgMood: null,
  blockersOpened: 0,
  blockersResolved: 0,
  openBlockers: [],
};

describe('moodEmoji', () => {
  it('maps the 1–5 scale to the five mood faces', () => {
    expect(moodEmoji(5)).toBe('😄');
    expect(moodEmoji(4.5)).toBe('😄');
    expect(moodEmoji(4)).toBe('🙂');
    expect(moodEmoji(3)).toBe('😐');
    expect(moodEmoji(2)).toBe('😕');
    expect(moodEmoji(1.4)).toBe('😫');
  });
});

describe('Weekly digest', () => {
  it('compares the week with the previous one and lists blockers still open', async () => {
    const { repo, standup } = await seedTwoWeeks();
    const digest = await buildWeeklyDigest(repo, standup, '2026-06-12');

    expect(digest).toMatchObject({
      weekStart: '2026-06-08',
      weekEnd: '2026-06-14',
      runCount: 1,
      participationPct: 50,
      prevParticipationPct: 100,
      avgMood: 2,
      prevAvgMood: 4,
      blockersOpened: 1,
      blockersResolved: 0,
    });
    expect(digest.openBlockers).toEqual([{ displayName: 'Alice', text: 'Waiting on API keys', ageDays: 2 }]);

    const text = digestText(digest);
    expect(text).toContain('Participation: *50%* (-50 vs last week)');
    expect(text).toContain('Mood: 😕 *2/5* (-2 vs last week)');
    expect(text).toContain('Blockers: 1 opened · 0 resolved');
    expect(text).toContain('*Still open:*');
    expect(text).toContain('⚠️ Alice: Waiting on API keys (2d)');
  });

  it('shows flat and improving deltas, and skips mood when nothing was recorded', () => {
    const flat = digestText({ ...baseDigest, prevParticipationPct: 80, avgMood: 3.5, prevAvgMood: 3.5 });
    expect(flat).toContain('Participation: *80%* (=)');
    expect(flat).toContain('Mood: 🙂 *3.5/5* (=)');

    const up = digestText({ ...baseDigest, prevParticipationPct: 60, avgMood: 4.2, prevAvgMood: 3.9 });
    expect(up).toContain('(+20 vs last week)');
    expect(up).toContain('Mood: 🙂 *4.2/5* (+0.3 vs last week)');

    const first = digestText(baseDigest);
    expect(first).toContain('Participation: *80%*\n');
    expect(first).not.toContain('Mood:');
    expect(first).not.toContain('Still open');
  });

  it('caps the still-open list at ten blockers', () => {
    const openBlockers = Array.from({ length: 12 }, (_, i) => ({
      displayName: 'Alice',
      text: `Blocker ${i + 1}`,
      ageDays: i,
    }));
    const text = digestText({ ...baseDigest, openBlockers });
    expect(text).toContain('Blocker 10 (9d)');
    expect(text).not.toContain('Blocker 11');
  });
});

describe('Trends', () => {
  it('lists participation and mood per week, marking weeks without runs', async () => {
    const { repo, standup, clock } = await seedTwoWeeks();
    clock.set('2026-06-10T12:00');

    const text = await trendsText(repo, standup, clock.now(), 3);
    expect(text).toContain('*Daily Standup* — last 3 weeks');
    expect(text).toContain('25 May ▸ no runs');
    expect(text).toContain('01 Jun ▸ participation 100% · mood 🙂 4/5');
    expect(text).toContain('08 Jun ▸ participation 50% · mood 😕 2/5');
    expect(text).toContain('⚠️ 1 open blocker — try `blockers`');
  });

  it('pluralises open blockers and omits the mood when none was recorded', async () => {
    const { repo, service, standup, clock } = await makeStack().then(async (stack) => ({
      ...stack,
      standup: await seedStandup(stack.repo),
    }));
    clock.set('2026-06-10T10:00');
    const run = await repo.createRun(standup.id, '2026-06-10', 'k');
    await service.submit(run.id, 'users/alice', 'Alice', { ...withBlocker('Waiting on infra'), mood: null });
    await service.submit(run.id, 'users/bob', 'Bob', { ...withBlocker('Waiting on design'), mood: null });
    await repo.closeRun(run.id);

    const text = await trendsText(repo, standup, clock.now(), 1);
    expect(text).toContain('08 Jun ▸ participation 100%\n');
    expect(text).not.toContain('mood');
    expect(text).toContain('⚠️ 2 open blockers — try `blockers`');
  });
});

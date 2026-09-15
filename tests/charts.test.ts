import { describe, expect, it } from 'vitest';
import { blockersChart, moodChart, participationChart, weeklySeries, type WeekPoint } from '../src/dashboard/charts.js';
import { ANSWERS, makeStack, seedStandup } from './helpers.js';

const week = (over: Partial<WeekPoint>): WeekPoint => ({
  label: '01 Jun',
  participationPct: 80,
  mood: 4,
  blockersOpened: 1,
  blockersResolved: 1,
  ...over,
});

describe('Dashboard charts', () => {
  it('renders bars, line and grouped bars as SVG with tooltips', () => {
    const points = [week({ label: '01 Jun' }), week({ label: '08 Jun', participationPct: 50, mood: 3 })];
    expect(participationChart(points)).toContain('50% participation');
    expect(moodChart(points)).toContain('mood 3/5');
    const blockers = blockersChart(points);
    expect(blockers).toContain('1 opened');
    expect(blockers).toContain('1 resolved');
    for (const svg of [participationChart(points), moodChart(points), blockers]) {
      expect(svg).toContain('<svg');
      expect(svg).toContain('role="img"');
    }
  });

  it('breaks the mood line across weeks without data instead of bridging them', () => {
    const points = [
      week({ mood: 3 }),
      week({ mood: null, participationPct: null }),
      week({ mood: 4 }),
    ];
    const path = moodChart(points).match(/<path d="([^"]+)" fill="none"/)![1]!;
    expect(path.match(/M/g)).toHaveLength(2); // two segments, no line across the gap
    expect(path).not.toContain('L');
  });

  it('shows an empty state until there is history', () => {
    const none = [week({ participationPct: null, mood: null, blockersOpened: 0, blockersResolved: 0 })];
    expect(participationChart(none)).toContain('not enough history');
    expect(moodChart(none)).toContain('not enough history');
    expect(blockersChart(none)).toContain('not enough history');
  });

  it('weeklySeries aggregates runs per week from the repo', async () => {
    const { repo, service, clock } = await makeStack();
    const standup = await seedStandup(repo);
    const run = await repo.createRun(standup.id, '2026-06-10', 'k');
    await service.submit(run.id, 'users/alice', 'Alice', ANSWERS);
    await repo.closeRun(run.id);
    clock.set('2026-06-10T12:00');

    const points = await weeklySeries(repo, standup, clock.now(), 2);
    expect(points).toHaveLength(2);
    expect(points[0]!.participationPct).toBeNull(); // previous week, no runs
    expect(points[1]!.participationPct).toBe(50); // alice of alice+bob mandatory
    expect(points[1]!.mood).toBe(4);
  });
});

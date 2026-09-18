import { describe, expect, it } from 'vitest';
import { dateSpan, groupRequests, isoToday, weekToDays, type OverrideView } from './schedule';

const o = (over: Partial<OverrideView>): OverrideView => ({
  id: 1, userName: 'users/a', displayName: 'Asha', date: '2026-09-22', working: false, reason: '', status: 'pending', label: 'Day off', setBy: 'Asha', channel: 'chat', decidedBy: null, decisionNote: null, createdAt: '2026-09-18T10:00:00Z',
  ...over,
});

describe('schedule helpers', () => {
  it('turns the stored week into chip days', () => {
    expect(weekToDays(null)).toEqual([]);
    expect(weekToDays('adhoc')).toEqual([]);
    expect(weekToDays('mon,tue,wed')).toEqual(['mon', 'tue', 'wed']);
  });

  it('groups one request per person, reason and submission', () => {
    const groups = groupRequests([
      o({ id: 1, date: '2026-09-22' }),
      o({ id: 2, date: '2026-09-23' }),
      o({ id: 3, userName: 'users/b', displayName: 'Bob', date: '2026-09-24', working: true, createdAt: '2026-09-18T11:00:00Z' }),
    ]);
    expect(groups.map((g) => [g.person, g.ids, g.dates, g.working])).toEqual([
      ['Asha', [1, 2], ['2026-09-22', '2026-09-23'], false],
      ['Bob', [3], ['2026-09-24'], true],
    ]);
  });

  it('formats single dates and ranges', () => {
    expect(dateSpan(['2026-09-19'])).toBe('Sat 19 Sep');
    expect(dateSpan(['2026-09-24', '2026-09-22', '2026-09-23'])).toBe('Tue 22 Sep – Thu 24 Sep');
  });

  it('gives today and tomorrow as ISO dates in the local zone', () => {
    const at = new Date(2026, 8, 18, 23, 30); // 18 Sep, late evening local time
    expect(isoToday(0, at)).toBe('2026-09-18');
    expect(isoToday(1, at)).toBe('2026-09-19');
  });
});

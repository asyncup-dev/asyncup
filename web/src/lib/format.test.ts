import { describe, expect, it } from 'vitest';
import { ago, clock, closesIn, daysLabel, longDate, minutesNowIn, monthOf, names, pct, shortDate, zoneAbbr } from './format';

describe('format', () => {
  it('labels day sets', () => {
    expect(daysLabel(['mon', 'tue', 'wed', 'thu', 'fri'])).toBe('Mon–Fri');
    expect(daysLabel(['mon', 'wed', 'fri'])).toBe('Mon, Wed, Fri');
    expect(daysLabel(['fri'])).toBe('Fri');
    expect(daysLabel([])).toBe('—');
    expect(daysLabel(['sat', 'sun', 'mon'])).toBe('Mon, Sat, Sun');
  });

  it('formats dates without shifting them', () => {
    expect(shortDate('2026-09-16')).toBe('Wed 16 Sept');
    expect(longDate('2026-09-15')).toBe('Tuesday 15 September');
    expect(monthOf('2026-09-01')).toBe('September');
  });

  it('shows clock times and zone abbreviations in the standup zone', () => {
    expect(clock('2026-09-16T04:11:00Z', 'Asia/Kolkata')).toBe('09:41');
    expect(clock('bad', 'Asia/Kolkata')).toBe('');
    expect(clock('2026-09-16T04:11:00Z', 'Not/AZone')).toBe('04:11');
    expect(zoneAbbr('Asia/Kolkata')).toMatch(/IST|GMT\+5:30/);
    expect(zoneAbbr('Not/AZone')).toBe('Not/AZone');
  });

  it('computes time to the deadline in the zone', () => {
    const now = new Date('2026-09-16T04:18:00Z'); // 09:48 IST
    expect(minutesNowIn('Asia/Kolkata', now)).toBe(9 * 60 + 48);
    expect(closesIn('11:30', 'Asia/Kolkata', now)).toBe('Closes in 1h 42m');
    expect(closesIn('09:55', 'Asia/Kolkata', now)).toBe('Closes in 7m');
    expect(closesIn('09:00', 'Asia/Kolkata', now)).toBe('Past deadline');
    expect(minutesNowIn('Not/AZone', now)).toBe(4 * 60 + 18);
  });

  it('formats relative times, percentages and name lists', () => {
    expect(ago(12_000)).toBe('12s ago');
    expect(ago(180_000)).toBe('3m ago');
    expect(ago(7_200_000)).toBe('2h ago');
    expect(pct(7, 9)).toBe(78);
    expect(pct(1, 0)).toBe(0);
    expect(names([{ displayName: 'Asha Verma' }, { displayName: 'Rohit' }])).toBe('Asha, Rohit');
    expect(names([{ displayName: 'A' }, { displayName: 'B' }, { displayName: 'C' }], 2)).toBe('A, B +1');
  });
});

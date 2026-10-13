import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PeopleMatrix } from '../components/people-matrix';
import { tickedDays, weekAfter, type Weekday } from './roster';

const WEEKDAYS: Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri'];

describe('people grid weeks', () => {
  it('ticks the standup’s days a person works', () => {
    expect(tickedDays(null, WEEKDAYS)).toEqual(WEEKDAYS);
    expect(tickedDays('adhoc', WEEKDAYS)).toEqual([]);
    expect(tickedDays('tue,thu,sat', WEEKDAYS)).toEqual(['tue', 'thu']);
  });

  it('saves the smallest week that means what was ticked', () => {
    // every standup day ticked, nothing else: follow the standup
    expect(weekAfter(null, WEEKDAYS, WEEKDAYS)).toBe('reset');
    expect(weekAfter('mon,tue,wed,thu,fri', WEEKDAYS, WEEKDAYS)).toBe('reset');
    expect(weekAfter(null, WEEKDAYS, ['mon', 'wed'])).toBe('mon,wed');
    // nothing ticked: ad hoc, so only dated working days count
    expect(weekAfter(null, WEEKDAYS, [])).toBe('adhoc');
    // days outside this standup belong to the person's other standups and are kept
    expect(weekAfter('tue,sat', WEEKDAYS, ['mon', 'tue'])).toBe('mon,tue,sat');
    expect(weekAfter('sat', WEEKDAYS, WEEKDAYS)).toBe('mon,tue,wed,thu,fri,sat');
    expect(weekAfter('sat', ['sat'], [])).toBe('adhoc');
  });

  it('says so when the space has nobody in it', () => {
    render(<PeopleMatrix rows={[]} standupDays={WEEKDAYS} onChange={() => {}} />);
    expect(screen.getByText('Nobody in this space yet.')).toBeInTheDocument();
  });
});

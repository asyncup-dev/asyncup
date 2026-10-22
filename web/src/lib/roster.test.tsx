import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PeopleMatrix, type MatrixRow } from '../components/people-matrix';
import { tickedDays, weekAfter, type Weekday } from './roster';

const WEEKDAYS: Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri'];

describe('people grid weeks', () => {
  it('ticks a person’s own days, or the standup’s when they have none (criterion 3)', () => {
    expect(tickedDays(null, WEEKDAYS)).toEqual(WEEKDAYS);
    expect(tickedDays('adhoc', WEEKDAYS)).toEqual([]);
    expect(tickedDays('tue,thu,sat', WEEKDAYS)).toEqual(['tue', 'thu', 'sat']);
  });

  it('saves exactly the standup’s days as the default (criterion 12)', () => {
    expect(weekAfter(WEEKDAYS, ['fri', 'mon', 'tue', 'wed', 'thu'])).toBe('reset');
    expect(weekAfter(WEEKDAYS, ['mon', 'wed'])).toBe('mon,wed');
    expect(weekAfter(WEEKDAYS, ['sat', 'mon', 'tue'])).toBe('mon,tue,sat');
    expect(weekAfter(WEEKDAYS, [...WEEKDAYS, 'sat'])).toBe('mon,tue,wed,thu,fri,sat');
    // nothing ticked: ad hoc, so only dated working days count
    expect(weekAfter(WEEKDAYS, [])).toBe('adhoc');
  });

  it('says so when the space has nobody in it', () => {
    render(<PeopleMatrix rows={[]} standupDays={WEEKDAYS} onChange={() => {}} />);
    expect(screen.getByText('Nobody in this space yet.')).toBeInTheDocument();
  });
});

describe('people grid', () => {
  const rows: MatrixRow[] = [
    { userName: 'users/asha', displayName: 'Asha', onStandup: true, mandatory: true, workingDays: null },
    { userName: 'users/bob', displayName: 'Bob', onStandup: true, mandatory: true, workingDays: 'mon,tue,wed,sat,sun' },
  ];

  it('marks the default days, says Default or Custom, and lets any day be ticked (criteria 10, 11, 14)', async () => {
    const onChange = vi.fn();
    render(<PeopleMatrix rows={rows} standupDays={WEEKDAYS} onChange={onChange} />);
    const user = userEvent.setup();
    const head = screen.getAllByRole('columnheader');
    expect(head.filter((h) => h.textContent?.endsWith('default')).map((h) => h.textContent)).toEqual(['Mondefault', 'Tuedefault', 'Weddefault', 'Thudefault', 'Fridefault']);
    const [, asha, bob] = screen.getAllByRole('row');
    expect(within(asha!).getByText('Default')).toBeInTheDocument();
    expect(within(bob!).getByText(/Custom/)).toBeInTheDocument();
    expect(screen.getByLabelText('Bob works Sat')).toBeChecked();
    expect(screen.getByLabelText('Asha works Sat')).toBeEnabled();
    await user.click(screen.getByLabelText('Asha works Sat'));
    expect(onChange).toHaveBeenLastCalledWith(rows[0], { week: 'mon,tue,wed,thu,fri,sat' });
    await user.click(within(bob!).getByRole('button', { name: 'Reset to default' }));
    expect(onChange).toHaveBeenLastCalledWith(rows[1], { week: 'reset' });
    expect(screen.getByText(/A person’s days apply to this standup only/)).toBeInTheDocument();
  });

  it('shows Saved, or the error, beside the row that changed (criterion 13)', () => {
    const { rerender } = render(<PeopleMatrix rows={rows} standupDays={WEEKDAYS} status={{ userName: 'users/bob', error: null }} onChange={() => {}} />);
    expect(within(screen.getAllByRole('row')[2]!).getByRole('status')).toHaveTextContent('✓ Saved');
    rerender(<PeopleMatrix rows={rows} standupDays={WEEKDAYS} status={{ userName: 'users/asha', error: 'Only managers can do that.' }} onChange={() => {}} />);
    expect(within(screen.getAllByRole('row')[1]!).getByText(/Only managers can do that/)).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});

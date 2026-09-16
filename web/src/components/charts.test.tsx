import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { WeekPoint } from '../lib/api';
import { averageSeries, BlockersChart, MoodChart, ParticipationChart, roundedBarPath } from './charts';

const pt = (label: string, participationPct: number | null, mood: number | null, o = 0, r = 0): WeekPoint => ({ label, participationPct, mood, blockersOpened: o, blockersResolved: r });
const WEEKS = [pt('28 Jul', 80, 3.5, 2, 1), pt('4 Aug', null, null, 0, 0), pt('11 Aug', 100, 4.2, 3, 3), pt('18 Aug', 90, 3.9, 1, 2)];

describe('charts', () => {
  it('renders the three charts with the original geometry', () => {
    render(<><ParticipationChart points={WEEKS} /><MoodChart points={WEEKS} /><BlockersChart points={WEEKS} /></>);
    expect(screen.getByRole('img', { name: 'Weekly participation percentage' })).toHaveAttribute('viewBox', '0 0 480 168');
    expect(screen.getByText('90%')).toBeInTheDocument();
    const titles = [...document.querySelectorAll('title')].map((t) => t.textContent);
    expect(titles).toContain('Week of 28 Jul: 80% participation');
    expect(screen.getByRole('img', { name: 'Weekly average mood on a 1 to 5 scale' })).toBeInTheDocument();
    expect(titles).toContain('Week of 11 Aug: mood 4.2/5');
    expect(screen.getByText('3.9')).toBeInTheDocument();
    expect(titles).toContain('Week of 11 Aug: 3 opened');
    expect(screen.getByText('resolved')).toBeInTheDocument();
    // The mood line breaks across the empty week instead of bridging it.
    const path = document.querySelector('path[stroke]')!.getAttribute('d')!;
    expect(path.split('M')).toHaveLength(3);
  });

  it('shows the empty message until there is history', () => {
    render(<><ParticipationChart points={[pt('a', null, null)]} /><MoodChart points={[]} /><BlockersChart points={[pt('a', 1, 1)]} /></>);
    expect(screen.getByText(/Participation: not enough history/)).toBeInTheDocument();
    expect(screen.getByText(/Mood: not enough history/)).toBeInTheDocument();
    expect(screen.getByText(/Blockers: not enough history/)).toBeInTheDocument();
  });

  it('averages aligned series and draws flat bars as empty paths', () => {
    expect(averageSeries([])).toEqual([]);
    const avg = averageSeries([[pt('w', 80, 4, 1, 0)], [pt('w', 60, null, 2, 1)]]);
    expect(avg).toEqual([{ label: 'w', participationPct: 70, mood: 4, blockersOpened: 3, blockersResolved: 1 }]);
    expect(roundedBarPath(10, 8, 20, 20)).toBe('');
    expect(roundedBarPath(10, 8, 0, 20)).toContain('M6,20');
  });
});

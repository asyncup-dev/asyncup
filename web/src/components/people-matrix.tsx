import { DAY_LABEL, tickedDays, WEEK, weekAfter, type Weekday } from '../lib/roster';

export interface MatrixRow {
  userName: string;
  displayName: string;
  onStandup: boolean;
  mandatory: boolean;
  workingDays: string | null;
  /** Other standups the person is on; their week changes there too. */
  otherStandups: number;
  badges?: string[];
}

export type MatrixChange = { onStandup: boolean } | { mandatory: boolean } | { week: string };

/**
 * Who is on a standup, whether they count when they miss it, and which of
 * its days they work — one row per person in the space.
 */
export function PeopleMatrix({ rows, standupDays, busy = false, weeks = true, onChange }: { rows: MatrixRow[]; standupDays: readonly Weekday[]; busy?: boolean; weeks?: boolean; onChange: (row: MatrixRow, change: MatrixChange) => void }) {
  if (rows.length === 0) return <p className="t-small muted" style={{ padding: 'var(--space-3) var(--space-4)' }}>Nobody in this space yet.</p>;
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="table people-matrix" aria-label="People and their days">
        <thead>
          <tr>
            <th>Person</th>
            <th>On standup</th>
            <th title="Required people are listed as missing when they don’t answer; the rest still get the prompt but never count as missing.">Required</th>
            {WEEK.map((d) => (
              <th key={d} className={standupDays.includes(d) ? 'center' : 'center muted'}>{DAY_LABEL[d]}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const ticked = tickedDays(row.workingDays, standupDays);
            const toggleDay = (d: Weekday) => {
              const picked = ticked.includes(d) ? ticked.filter((x) => x !== d) : [...ticked, d];
              onChange(row, { week: weekAfter(row.workingDays, standupDays, picked) });
            };
            return (
              <tr key={row.userName} className={row.onStandup ? undefined : 'muted'}>
                <td data-label="Person">
                  <div className="t-medium">
                    {row.displayName}
                    {row.badges?.map((b) => <span key={b} className="badge" style={{ marginLeft: 6 }}>{b}</span>)}
                  </div>
                  {row.onStandup && row.otherStandups > 0 ? (
                    <div className="t-caption">Days also apply to their {row.otherStandups === 1 ? 'other standup' : `${row.otherStandups} other standups`}</div>
                  ) : null}
                </td>
                <td data-label="On standup">
                  <input type="checkbox" aria-label={`${row.displayName} on this standup`} checked={row.onStandup} disabled={busy} onChange={(e) => onChange(row, { onStandup: e.target.checked })} />
                </td>
                <td data-label="Required">
                  <input type="checkbox" aria-label={`${row.displayName} required`} checked={row.onStandup && row.mandatory} disabled={busy || !row.onStandup} onChange={(e) => onChange(row, { mandatory: e.target.checked })} />
                </td>
                {WEEK.map((d) => {
                  const runs = standupDays.includes(d);
                  return (
                    <td key={d} data-label={DAY_LABEL[d]} className="center">
                      <input
                        type="checkbox"
                        aria-label={`${row.displayName} works ${DAY_LABEL[d]}`}
                        title={!runs ? 'The standup does not run this day — add it under Schedule first' : weeks ? undefined : 'You can’t change people’s days'}
                        checked={runs && row.onStandup && ticked.includes(d)}
                        disabled={busy || !runs || !row.onStandup || !weeks}
                        onChange={() => toggleDay(d)}
                      />
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="t-caption" style={{ padding: 'var(--space-2) var(--space-4)' }}>
        Required people are listed as missing when they don’t answer; the others still get the prompt. Unticked days mean no prompt, and the person is never counted missing that day. Greyed days are not standup days. A person’s days are their own week, so they apply to every standup they are on.
      </p>
    </div>
  );
}

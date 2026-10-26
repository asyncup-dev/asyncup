import { DAY_LABEL, tickedDays, WEEK, weekAfter, type Weekday } from '../lib/roster';

export interface MatrixRow {
  userName: string;
  displayName: string;
  onStandup: boolean;
  mandatory: boolean;
  workingDays: string | null;
  reportingManager?: string | null;
  reportingManagerName?: string | null;
  badges?: string[];
}

export type MatrixChange = { onStandup: boolean } | { mandatory: boolean } | { week: string } | { reportingManager: string | null };

/** The outcome of the last change to a row: saved, or the error. */
export interface RowStatus {
  userName: string;
  error: string | null;
}

/**
 * Who is on a standup, whether they count when they miss it, and which days
 * they work on it — one row per person in the space. The standup's own days
 * are the default; anyone can be given any other days.
 */
export function PeopleMatrix({ rows, standupDays, busy = false, weeks = true, reportsTo = true, managers = [], status = null, onChange }: { rows: MatrixRow[]; standupDays: readonly Weekday[]; busy?: boolean; weeks?: boolean; reportsTo?: boolean; managers?: { userName: string; displayName: string }[]; status?: RowStatus | null; onChange: (row: MatrixRow, change: MatrixChange) => void }) {
  if (rows.length === 0) return <p className="t-small muted" style={{ padding: 'var(--space-3) var(--space-4)' }}>Nobody in this space yet.</p>;
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="table people-matrix" aria-label="People and their days">
        <thead>
          <tr>
            <th>Person</th>
            <th>On standup</th>
            <th title="Required people are listed as missing when they don’t answer; the rest still get the prompt but never count as missing.">Required</th>
            {reportsTo ? <th title="A manager who can approve this person’s days off, besides the standup’s own managers.">Reports to</th> : null}
            {WEEK.map((d) => (
              <th key={d} className="center">
                {DAY_LABEL[d]}
                {standupDays.includes(d) ? <span className="day-default">default</span> : null}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const ticked = tickedDays(row.workingDays, standupDays);
            const toggleDay = (d: Weekday) => {
              const picked = ticked.includes(d) ? ticked.filter((x) => x !== d) : [...ticked, d];
              onChange(row, { week: weekAfter(standupDays, picked) });
            };
            const mine = status?.userName === row.userName ? status : null;
            return (
              <tr key={row.userName} className={row.onStandup ? undefined : 'muted'}>
                <td data-label="Person">
                  <div className="t-medium">
                    {row.displayName}
                    {row.badges?.map((b) => <span key={b} className="badge" style={{ marginLeft: 6 }}>{b}</span>)}
                  </div>
                  {row.onStandup ? (
                    <div className="t-caption">
                      {row.workingDays === null ? 'Default' : (
                        <>
                          Custom ·{' '}
                          <button type="button" className="link-btn" disabled={busy || !weeks} onClick={() => onChange(row, { week: 'reset' })}>Reset to default</button>
                        </>
                      )}
                      {mine ? mine.error ? <span className="danger"> · {mine.error}</span> : <span className="success" role="status"> · ✓ Saved</span> : null}
                    </div>
                  ) : null}
                </td>
                <td data-label="On standup">
                  <input type="checkbox" aria-label={`${row.displayName} on this standup`} checked={row.onStandup} disabled={busy} onChange={(e) => onChange(row, { onStandup: e.target.checked })} />
                </td>
                <td data-label="Required">
                  <input type="checkbox" aria-label={`${row.displayName} required`} checked={row.onStandup && row.mandatory} disabled={busy || !row.onStandup} onChange={(e) => onChange(row, { mandatory: e.target.checked })} />
                </td>
                {reportsTo ? (
                <td data-label="Reports to">
                  <select
                    className="input"
                    aria-label={`${row.displayName} reports to`}
                    style={{ width: 'auto', maxWidth: 160 }}
                    value={row.reportingManager ?? ''}
                    disabled={busy || !row.onStandup}
                    onChange={(e) => onChange(row, { reportingManager: e.target.value || null })}
                  >
                    <option value="">— none —</option>
                    {row.reportingManager && !managers.some((m) => m.userName === row.reportingManager) ? (
                      <option value={row.reportingManager}>{row.reportingManagerName ?? row.reportingManager}</option>
                    ) : null}
                    {managers.filter((m) => m.userName !== row.userName).map((m) => (
                      <option key={m.userName} value={m.userName}>{m.displayName}</option>
                    ))}
                  </select>
                </td>
                ) : null}
                {WEEK.map((d) => (
                  <td key={d} data-label={standupDays.includes(d) ? `${DAY_LABEL[d]} · default` : DAY_LABEL[d]} className="center">
                    <input
                      type="checkbox"
                      aria-label={`${row.displayName} works ${DAY_LABEL[d]}`}
                      title={weeks ? undefined : 'You can’t change people’s days'}
                      checked={row.onStandup && ticked.includes(d)}
                      disabled={busy || !row.onStandup || !weeks}
                      onChange={() => toggleDay(d)}
                    />
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="t-caption" style={{ padding: 'var(--space-2) var(--space-4)' }}>
        Required people are listed as missing when they don’t answer; the others still get the prompt. A person’s days apply to this standup only. “Default” follows the standup’s days under Schedule. Tick any other day and the standup also runs that day, for that person only. Each tick saves straight away. Unticked days mean no prompt, and the person is never counted missing that day.
      </p>
    </div>
  );
}

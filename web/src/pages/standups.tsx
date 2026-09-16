import { useQuery } from '@tanstack/react-query';
import { EmptyState } from '../components/empty-state';
import { api, type StandupSummary } from '../lib/api';

function todayLabel(s: StandupSummary): { text: string; tone: string } {
  if (!s.today.status) return { text: 'Not started', tone: '' };
  if (s.today.status === 'closed') return { text: 'Wrapped up', tone: 'badge-success' };
  return { text: `${s.today.submitted} / ${s.today.expected} in`, tone: s.today.missing.length ? 'badge-warning' : 'badge-success' };
}

export function StandupsPage() {
  const standups = useQuery({ queryKey: ['standups'], queryFn: () => api<{ standups: StandupSummary[] }>('/standups') });
  if (standups.isPending) return <p className="muted">Loading…</p>;
  if (standups.isError) return <div className="alert">Could not load standups: {standups.error.message}</div>;
  const list = standups.data.standups;
  const open = list.filter((s) => s.today.status === 'open').length;
  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="t-h1" style={{ margin: 0 }}>Standups</h1>
          <div className="t-small muted">
            {list.length ? `${list.length} standup${list.length === 1 ? '' : 's'} · ${open} open today` : 'Nothing running yet'}
          </div>
        </div>
      </div>
      {list.length === 0 ? (
        <EmptyState title="No standups yet">
          Create one from a template and pick the Chat space it reports to. The guided setup arrives with the next release; until then, use <code>setup</code> in Google Chat.
        </EmptyState>
      ) : (
        <div className="card">
          <table className="table">
            <thead>
              <tr>
                <th className="t-label">Standup</th>
                <th className="t-label">Schedule</th>
                <th className="t-label">People</th>
                <th className="t-label">Today</th>
              </tr>
            </thead>
            <tbody>
              {list.map((s) => {
                const today = todayLabel(s);
                return (
                  <tr key={s.id}>
                    <td>
                      <div className="t-strong">{s.name}</div>
                      <div className="t-caption">{s.spaceName}</div>
                    </td>
                    <td className="t-small secondary">
                      {s.schedule.promptTime}–{s.schedule.deadlineTime} {s.schedule.timezone}
                      <div className="t-caption">{s.schedule.days.join(', ')}</div>
                    </td>
                    <td>{s.people.total}</td>
                    <td>
                      <span className={`badge ${today.tone}`}>{today.text}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

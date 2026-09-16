import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, MOOD_EMOJI } from '../lib/api';
import { useMe } from '../lib/auth';
import { closesIn, daysLabel, longDate, shortDate, zoneAbbr } from '../lib/format';
import { timezoneOptions } from '../lib/setup';

export interface MyStandup {
  id: number;
  name: string;
  schedule: { promptTime: string; deadlineTime: string; timezone: string; days: string[] };
  today: 'submitted' | 'waiting' | 'closed' | null;
  progress: { submitted: number; expected: number } | null;
  mandatory: boolean;
  onVacation: boolean;
}
export interface MyStandups {
  linked: boolean;
  timezone?: string | null;
  chat?: { dmUrl: string | null };
  standups: MyStandup[];
}
export interface MySubmission {
  date: string;
  standupName: string;
  submittedAt: string;
  editedAt: string | null;
  late: boolean;
  mood: string | null;
  answers: { question: string; answer: string }[];
}

export function greeting(hour: number): string {
  return hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
}

/** "mostly 🙂" from the last few moods, or nothing when none were picked. */
export function moodSummary(moods: (string | null)[]): string | null {
  const picked = moods.filter((m): m is string => !!m);
  if (picked.length === 0) return null;
  const counts = new Map<string, number>();
  for (const m of picked) counts.set(m, (counts.get(m) ?? 0) + 1);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
  return `mostly ${MOOD_EMOJI[top] ?? top}`;
}

const STATUS: Record<string, { text: string; tone: string }> = {
  submitted: { text: 'Submitted ✓', tone: 'badge-success' },
  waiting: { text: 'Waiting for you', tone: 'badge-warning' },
  closed: { text: 'Closed · missed', tone: '' },
};

export function MePage() {
  const me = useMe();
  const client = useQueryClient();
  const mine = useQuery({ queryKey: ['me-standups'], queryFn: () => api<MyStandups>('/me/standups'), refetchInterval: 30_000 });
  const [showAll, setShowAll] = useState(false);
  const submissions = useQuery({ queryKey: ['me-submissions', showAll ? 50 : 5], queryFn: () => api<{ submissions: MySubmission[] }>(`/me/submissions?limit=${showAll ? 50 : 5}`), select: (d) => d.submissions });
  const patch = useMutation({
    mutationFn: (body: { timezone?: string | null; onVacation?: boolean }) => api<{ timezone: string | null; onVacation: boolean }>('/me', { method: 'PATCH', body }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['me-standups'] }),
  });
  const skip = useMutation({
    mutationFn: (standupId: number) => api<{ result: string; date: string }>('/me/skip', { method: 'POST', body: { standupId } }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['me-standups'] }),
  });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const name = me.data?.user?.name?.split(' ')[0] ?? 'there';
  const d = mine.data;
  if (mine.isError) return <div className="alert">Could not load your standups: {mine.error.message}</div>;
  if (!d) return <p className="muted">Loading…</p>;
  const waiting = d.standups.filter((s) => s.today === 'waiting' && !s.onVacation);
  const now = new Date();
  const todayIso = now.toISOString().slice(0, 10);
  const save = async (body: { timezone?: string | null; onVacation?: boolean }) => {
    try {
      setError(null);
      await patch.mutateAsync(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not save.');
    }
  };
  const onVacation = d.standups.length > 0 && d.standups.every((s) => s.onVacation);
  const answerHref = d.chat?.dmUrl ?? 'https://chat.google.com/';
  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="t-h1" style={{ margin: 0 }}>{greeting(now.getHours())}, {name}</h1>
          <div className="t-small muted">
            {longDate(todayIso)} · {d.linked ? (waiting.length ? `${waiting.length} standup${waiting.length === 1 ? '' : 's'} waiting for you` : 'nothing waiting for you') : 'not linked to Chat yet'}
          </div>
        </div>
      </div>
      {error ? <div className="alert" role="alert">{error}</div> : null}
      {notice ? <div className="toast" role="status">{notice}</div> : null}
      {!d.linked ? (
        <div className="card section">
          <div className="t-h3">Your account is not linked to Google Chat yet</div>
          <p className="t-small secondary" style={{ margin: 0 }}>It links the first time you use the AsyncUp bot in Chat, or when an admin enables Directory lookups. Until then there is nothing to show here.</p>
          <div><a className="btn btn-primary" href="https://chat.google.com/" target="_blank" rel="noreferrer">Open Google Chat</a></div>
        </div>
      ) : null}
      {waiting.map((s) => {
        const left = closesIn(s.schedule.deadlineTime, s.schedule.timezone, now);
        return (
          <div key={s.id} className="card section today-card">
            <div className="row-wrap" style={{ alignItems: 'center' }}>
              <div className="grow" style={{ flex: 1, minWidth: 240 }}>
                <div className="t-h3">{s.name} · today’s standup is open</div>
                <div className="t-small secondary">
                  Closes at {s.schedule.deadlineTime} {zoneAbbr(s.schedule.timezone)} — {left === 'Past deadline' ? 'past the deadline' : `${left.replace('Closes in ', '')} left`}.
                  {s.progress ? ` ${s.progress.submitted} of ${s.progress.expected} teammates have already posted.` : ''}
                </div>
              </div>
              <a className="btn btn-primary btn-lg" href={answerHref} target="_blank" rel="noreferrer">Answer in Chat ↗</a>
              <button
                type="button"
                className="btn btn-lg"
                disabled={skip.isPending}
                onClick={() => void (async () => {
                  try {
                    setError(null);
                    await skip.mutateAsync(s.id);
                    setNotice(`Skipped today’s ${s.name} — you won’t be counted as missing.`);
                  } catch (err) {
                    setError(err instanceof Error ? err.message : 'That did not work.');
                  }
                })()}
              >
                Skip today
              </button>
            </div>
          </div>
        );
      })}
      <div className="overview">
        <div className="col">
          <section className="card">
            <div className="card-head"><span className="t-h3 grow">My standups</span></div>
            <div className="card-body">
              {d.linked && d.standups.length === 0 ? <span className="t-small muted">You are not on any standup yet. An admin adds you from a standup’s settings, or with `add @you` in Chat.</span> : null}
              {d.standups.map((s) => {
                const st = s.onVacation ? { text: 'On vacation', tone: 'badge-warning' } : s.today ? STATUS[s.today]! : { text: 'Not today', tone: '' };
                return (
                  <div key={s.id} className="person-row">
                    <span className="name">
                      <div className="t-medium">{s.name}{!s.mandatory ? <span className="badge" style={{ marginLeft: 8 }}>optional</span> : null}</div>
                      <div className="t-caption">{s.schedule.promptTime} → {s.schedule.deadlineTime} · {daysLabel(s.schedule.days)} · prompts at {s.schedule.promptTime} {zoneAbbr(d.timezone || s.schedule.timezone)}</div>
                    </span>
                    <span className={`badge ${st.tone}`}>{st.text}</span>
                  </div>
                );
              })}
            </div>
          </section>
          <section className="card">
            <div className="card-head">
              <span className="t-h3 grow">My recent answers</span>
              {!showAll && submissions.data && submissions.data.length >= 5 ? <button type="button" className="btn btn-ghost" style={{ height: 28 }} onClick={() => setShowAll(true)}>View all</button> : null}
            </div>
            <div className="card-body">
              {submissions.isError ? <div className="alert">Could not load answers: {submissions.error.message}</div> : null}
              {submissions.data?.length === 0 ? <span className="t-small muted">No answers yet — your first prompt arrives on the next scheduled day.</span> : null}
              {submissions.data?.map((sub) => (
                <div key={`${sub.date}-${sub.standupName}`} className="submission">
                  <div className="row">
                    <span className="t-medium grow">{shortDate(sub.date)}</span>
                    <span className="t-caption">{sub.standupName}{sub.late ? ' · late' : ''}{sub.editedAt ? ' · edited' : ''}{sub.mood ? ` · ${MOOD_EMOJI[sub.mood] ?? ''}` : ''}</span>
                  </div>
                  <dl className="qa">
                    {sub.answers.map((a, i) => (
                      <div key={i} style={{ display: 'contents' }}>
                        <dt title={a.question}>{['Yesterday', 'Today', 'Blockers'][i] ?? a.question}</dt>
                        <dd>{a.answer || <span className="muted">—</span>}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              ))}
            </div>
          </section>
        </div>
        <div className="col">
          <section className="card">
            <div className="card-head"><span className="t-h3 grow">My settings</span></div>
            <div className="card-body">
              <div className="field">
                <label htmlFor="my-tz">My timezone</label>
                <select id="my-tz" className="input" value={d.timezone ?? ''} disabled={!d.linked || patch.isPending} onChange={(e) => void save({ timezone: e.target.value || null })}>
                  <option value="">Follow each standup’s zone</option>
                  {timezoneOptions(d.timezone ?? 'UTC').filter((z) => z).map((z) => <option key={z} value={z}>{z}</option>)}
                </select>
                <div className="t-caption">Prompts arrive at each standup’s prompt time in this zone.</div>
              </div>
              <div className="switch">
                <input id="vacation" type="checkbox" checked={onVacation} disabled={!d.linked || d.standups.length === 0 || patch.isPending} onChange={(e) => void save({ onVacation: e.target.checked })} />
                <label htmlFor="vacation">
                  <div className="t-medium">Vacation mode</div>
                  <div className="t-caption">Pause all prompts. You won’t be counted as missing.</div>
                </label>
              </div>
            </div>
          </section>
          <section className="card">
            <div className="card-head"><span className="t-h3 grow">Mood</span></div>
            <div className="card-body">
              <p className="t-small secondary" style={{ margin: 0 }}>Where a standup keeps moods anonymous, only the team average is ever shown. Your individual moods stay yours.</p>
              <div className="row-wrap" aria-hidden="true">{Object.values(MOOD_EMOJI).reverse().map((e) => <span key={e} className="badge">{e}</span>)}</div>
              {submissions.data ? <div className="t-caption">{moodSummary(submissions.data.map((s) => s.mood)) ? `Your recent answers: ${moodSummary(submissions.data.map((s) => s.mood))}` : 'No mood picked recently.'}</div> : null}
            </div>
          </section>
        </div>
      </div>
    </>
  );
}

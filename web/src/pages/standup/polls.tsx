import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { ConfirmDialog } from '../../components/confirm-dialog';
import { useAccess } from '../../lib/access';
import { ApiError } from '../../lib/api';
import { isChoice, pollMeta, REMINDERS, RESULTS_LABEL, TYPE_LABEL, useClosePoll, useQuestionPoll, useQuestionPolls, useSendPoll, type PollDraft, type QuestionPollSummary, type QuestionType } from '../../lib/polls';
import { useStandup } from '../../lib/standups';
import { useStandupId } from './layout';

function Badges({ p }: { p: QuestionPollSummary }) {
  return (
    <>
      {p.open ? <span className="badge badge-success">Open</span> : null}
      <span className={`badge ${p.anonymous ? 'badge-warning' : ''}`}>{p.anonymous ? 'Anonymous' : 'Named'}</span>
      <span className="badge">{RESULTS_LABEL[p.results]}</span>
    </>
  );
}

function PollRow({ p, standupId }: { p: QuestionPollSummary; standupId: number }) {
  return (
    <div className="poll-row">
      <div className="grow">
        <div className="t-medium">{p.title}</div>
        <div className="t-small secondary">{pollMeta(p)}</div>
      </div>
      <Badges p={p} />
      <Link className="t-medium" to="/standups/$id/polls/$pollId" params={{ id: String(standupId), pollId: String(p.id) }}>{p.open ? 'View' : 'Results'}</Link>
    </div>
  );
}

/** The standup's Polls tab: open and closed polls, and New poll for its managers. */
export function PollsPage() {
  const id = useStandupId();
  const polls = useQuestionPolls(id);
  const access = useAccess();
  if (polls.isError) return <div className="alert">Could not load polls: {polls.error.message}</div>;
  if (!polls.data) return <p className="muted">Loading…</p>;
  const open = polls.data.filter((p) => p.open);
  const closed = polls.data.filter((p) => !p.open);
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <section className="card">
        <div className="card-head">
          <div className="grow" style={{ flex: '1 1 240px' }}>
            <h2 className="t-h3" style={{ margin: 0 }}>Polls</h2>
            <div className="t-caption">Ask the team a few questions, with a close time. Only the people on this standup are asked.</div>
          </div>
          {access.can('standups.configure', id) ? <Link className="btn btn-primary" style={{ height: 28 }} to="/standups/$id/polls/new" params={{ id: String(id) }}>New poll</Link> : null}
        </div>
        {open.length ? open.map((p) => <PollRow key={p.id} p={p} standupId={id} />) : <p className="t-small muted" style={{ padding: '0 var(--space-5) var(--space-4)' }}>No open polls.</p>}
      </section>
      {closed.length ? (
        <section className="card">
          <div className="card-head"><h2 className="t-h3 grow" style={{ margin: 0 }}>Closed</h2></div>
          {closed.map((p) => <PollRow key={p.id} p={p} standupId={id} />)}
        </section>
      ) : null}
      <p className="t-caption">Quick one-question polls from Chat (<code>poll Question? | A | B</code>) stay in the space and are listed with <code>polls</code>.</p>
    </div>
  );
}

type Draft = { text: string; type: QuestionType; required: boolean; options: string[] };
const blank = (): Draft => ({ text: '', type: 'short', required: false, options: [] });
const tomorrow = () => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

/** New poll: questions, the close time in the standup's timezone, and who sees what. */
export function NewPollPage() {
  const id = useStandupId();
  const standup = useStandup(id);
  const send = useSendPoll(id);
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const [intro, setIntro] = useState('');
  const [questions, setQuestions] = useState<Draft[]>([blank()]);
  const [date, setDate] = useState(tomorrow());
  const [time, setTime] = useState('17:00');
  const [remind, setRemind] = useState<number | null>(60);
  const [anonymous, setAnonymous] = useState(false);
  const [results, setResults] = useState<PollDraft['results'] & string>('everyone');
  const [error, setError] = useState<string | null>(null);
  const zone = standup.data?.schedule.timezone ?? '';
  const asked = standup.data?.people.total ?? 0;
  const edit = (i: number, patch: Partial<Draft>) => setQuestions(questions.map((q, j) => (j === i ? { ...q, ...patch } : q)));
  const setType = (i: number, type: QuestionType) => {
    const q = questions[i]!;
    edit(i, { type, options: isChoice(type) ? (q.options.length >= 2 ? q.options : ['', '']) : [] });
  };
  const move = (i: number, by: number) => {
    const qs = [...questions];
    [qs[i], qs[i + by]] = [qs[i + by]!, qs[i]!];
    setQuestions(qs);
  };
  const submit = async () => {
    setError(null);
    try {
      const poll = await send.mutateAsync({
        title,
        intro: intro.trim() || null,
        questions: questions.map((q) => ({ text: q.text, type: q.type, required: q.required, options: isChoice(q.type) ? q.options : [] })),
        closesAt: `${date}T${time}`,
        remindMinutes: remind as PollDraft["remindMinutes"],
        anonymous,
        results,
      });
      await navigate({ to: '/standups/$id/polls/$pollId', params: { id: String(id), pollId: String(poll.id) } });
    } catch (err) {
      setError(err instanceof ApiError || err instanceof Error ? err.message : 'That did not send.');
    }
  };
  return (
    <div className="overview">
      <div className="col" style={{ display: 'grid', gap: 16 }}>
        {error ? <div className="alert" role="alert">{error}</div> : null}
        <section className="card">
          <div className="card-head"><div className="grow"><h2 className="t-h3" style={{ margin: 0 }}>New poll</h2><div className="t-caption">Sent by DM to the {asked} people on {standup.data?.name ?? 'this standup'}. People on vacation are skipped.</div></div></div>
          <div className="card-body">
            <div className="field"><label htmlFor="poll-title">Title</label><input id="poll-title" className="input" maxLength={100} value={title} onChange={(e) => setTitle(e.target.value)} /><span className="t-caption">Up to 100 characters.</span></div>
            <div className="field"><label htmlFor="poll-intro">Intro (optional)</label><textarea id="poll-intro" className="input" rows={2} maxLength={500} value={intro} onChange={(e) => setIntro(e.target.value)} /><span className="t-caption">Shown above the questions. Up to 500 characters.</span></div>
          </div>
        </section>
        <section className="card">
          <div className="card-head"><div className="grow"><h2 className="t-h3" style={{ margin: 0 }}>Questions</h2><div className="t-caption">1 to 10 questions. Required questions must be answered to submit.</div></div></div>
          <div className="card-body">
            {questions.map((q, i) => (
              <div key={i} className="poll-question" aria-label={`Question ${i + 1}`} role="group">
                <div className="row-wrap" style={{ alignItems: 'center' }}>
                  <span className="t-medium secondary">{i + 1}.</span>
                  <input className="input" aria-label={`Question ${i + 1} text`} maxLength={200} style={{ flex: '1 1 220px' }} value={q.text} onChange={(e) => edit(i, { text: e.target.value })} />
                  <select className="input" aria-label={`Question ${i + 1} type`} style={{ width: 'auto' }} value={q.type} onChange={(e) => setType(i, e.target.value as QuestionType)}>
                    {(Object.keys(TYPE_LABEL) as QuestionType[]).map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
                  </select>
                  <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={q.required} onChange={(e) => edit(i, { required: e.target.checked })} />Required</label>
                  <button type="button" className="icon-btn" aria-label={`Move question ${i + 1} up`} disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
                  <button type="button" className="icon-btn" aria-label={`Remove question ${i + 1}`} disabled={questions.length === 1} onClick={() => setQuestions(questions.filter((_, j) => j !== i))}>×</button>
                </div>
                {isChoice(q.type) ? (
                  <div style={{ display: 'grid', gap: 6, paddingLeft: 22 }}>
                    {q.options.map((o, n) => (
                      <div key={n} className="row">
                        <input className="input" aria-label={`Question ${i + 1} option ${n + 1}`} maxLength={80} style={{ maxWidth: 320 }} value={o} onChange={(e) => edit(i, { options: q.options.map((x, k) => (k === n ? e.target.value : x)) })} />
                        <button type="button" className="icon-btn" aria-label={`Remove question ${i + 1} option ${n + 1}`} disabled={q.options.length <= 2} onClick={() => edit(i, { options: q.options.filter((_, k) => k !== n) })}>×</button>
                      </div>
                    ))}
                    <div><button type="button" className="btn btn-ghost" style={{ height: 26 }} disabled={q.options.length >= 20} onClick={() => edit(i, { options: [...q.options, ''] })}>+ Add option</button></div>
                  </div>
                ) : <span className="t-caption">{q.type === 'long' ? 'Several lines, up to 1,000 characters.' : 'One line, up to 200 characters.'}</span>}
              </div>
            ))}
            <div><button type="button" className="btn btn-ghost" style={{ height: 28 }} disabled={questions.length >= 10} onClick={() => setQuestions([...questions, blank()])}>+ Add question</button></div>
          </div>
        </section>
        <section className="card">
          <div className="card-head"><h2 className="t-h3 grow" style={{ margin: 0 }}>Timing and results</h2></div>
          <div className="card-body">
            <div className="field">
              <span className="t-medium">Closes</span>
              <div className="row-wrap" style={{ alignItems: 'center' }}>
                <input type="date" className="input" aria-label="Close date" style={{ width: 170 }} value={date} onChange={(e) => setDate(e.target.value)} />
                <input type="time" className="input" aria-label="Close time" style={{ width: 120 }} value={time} onChange={(e) => setTime(e.target.value)} />
                <span className="t-small secondary">{zone} (the standup’s timezone)</span>
              </div>
              <span className="t-caption">From 15 minutes to 14 days ahead. Answers can change until then; nothing is accepted after.</span>
            </div>
            <div className="field">
              <label htmlFor="poll-remind">Reminder</label>
              <select id="poll-remind" className="input" style={{ width: 'auto' }} value={remind ?? ''} onChange={(e) => setRemind(e.target.value ? Number(e.target.value) : null)}>
                {REMINDERS.map((r) => <option key={r.label} value={r.value ?? ''}>{r.label}</option>)}
              </select>
              <span className="t-caption">One DM, only to people who haven’t answered.</span>
            </div>
            <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
              <legend className="t-medium">Answers</legend>
              <div className="row-wrap">
                <label className="row" style={{ gap: 6 }}><input type="radio" name="poll-anon" checked={!anonymous} onChange={() => setAnonymous(false)} />Named</label>
                <label className="row" style={{ gap: 6 }}><input type="radio" name="poll-anon" checked={anonymous} onChange={() => setAnonymous(true)} />Anonymous — nobody sees who answered what</label>
              </div>
            </fieldset>
            <div className="field">
              <label htmlFor="poll-results">Who sees results</label>
              <select id="poll-results" className="input" style={{ width: 'auto' }} value={results} onChange={(e) => setResults(e.target.value as 'everyone' | 'managers')}>
                <option value="everyone">{RESULTS_LABEL.everyone}</option>
                <option value="managers">{RESULTS_LABEL.managers}</option>
              </select>
              <span className="t-caption">Neither this nor named or anonymous can change once the poll is sent.</span>
            </div>
            <div className="row">
              <button type="button" className="btn btn-primary" disabled={send.isPending} onClick={() => void submit()}>Send poll</button>
              <Link className="btn btn-ghost" to="/standups/$id/polls" params={{ id: String(id) }}>Cancel</Link>
            </div>
          </div>
        </section>
      </div>
      <div className="col">
        <section className="card" aria-label="Preview">
          <div className="card-head"><div className="grow"><h2 className="t-h3" style={{ margin: 0 }}>Preview</h2><div className="t-caption">What people see after Respond in Chat.</div></div></div>
          <div className="card-body">
            <div className="t-strong">{title || 'Untitled poll'}</div>
            {intro ? <div className="t-small secondary">{intro}</div> : null}
            {questions.map((q, i) => (
              <div key={i} style={{ display: 'grid', gap: 4 }}>
                <div className="t-small t-medium">{q.text || `Question ${i + 1}`}{q.required ? ' (required)' : ''}</div>
                {isChoice(q.type) ? q.options.map((o, n) => <div key={n} className="t-small secondary">{q.type === 'multiple' ? '☐' : q.type === 'single' ? '○' : '▾'} {o || `Option ${n + 1}`}</div>) : <div className="preview-input" style={{ height: q.type === 'long' ? 48 : 28 }} />}
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

/** One poll: who has answered and, for those allowed, the results. */
export function PollPage() {
  const id = useStandupId();
  const { pollId } = useParams({ strict: false }) as { pollId?: string };
  const poll = useQuestionPoll(Number(pollId));
  const close = useClosePoll(Number(pollId), id);
  const access = useAccess();
  const [confirm, setConfirm] = useState(false);
  if (poll.isError) return <div className="alert">Could not load this poll: {poll.error.message}</div>;
  if (!poll.data) return <p className="muted">Loading…</p>;
  const p = poll.data;
  const manage = access.can('standups.configure', id);
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <Link className="t-small t-medium" to="/standups/$id/polls" params={{ id: String(id) }}>← All polls</Link>
      <section className="card">
        <div className="card-head">
          <div className="grow" style={{ flex: '1 1 240px' }}>
            <h2 className="t-h3" style={{ margin: 0 }}>{p.title}</h2>
            <div className="t-small secondary">{pollMeta(p)} · {p.anonymous ? 'Anonymous' : 'Named'} · {RESULTS_LABEL[p.results]}</div>
          </div>
          {manage ? <a className="btn btn-ghost" style={{ height: 28 }} aria-label="Export this poll as CSV" href={`/api/v1/question-polls/${p.id}/export.csv`}>Export CSV</a> : null}
          {manage && p.open ? <button type="button" className="btn" style={{ height: 28 }} onClick={() => setConfirm(true)}>Close now</button> : null}
        </div>
        <div className="card-body">
          <div className="t-h3">{p.answered} of {p.asked} answered</div>
          {p.outcome?.notAnswered ? <div className="t-small secondary">{p.outcome.notAnswered.length ? `Not answered: ${p.outcome.notAnswered.join(', ')}` : 'Everyone answered.'}</div> : null}
          {!p.outcome ? <div className="t-small muted">{p.results === 'managers' ? 'Results are with the standup’s managers.' : 'Results show here once it closes.'}</div> : null}
        </div>
      </section>
      {p.outcome?.questions.map((q, i) => (
        <section key={i} className="card" aria-label={`Question ${i + 1} results`}>
          <div className="card-head"><div className="grow"><h3 className="t-h3" style={{ margin: 0 }}>{i + 1}. {q.text}</h3><div className="t-caption">{TYPE_LABEL[q.type]} · {q.answered} answer{q.answered === 1 ? '' : 's'}</div></div></div>
          <div className="card-body">
            {isChoice(q.type)
              ? q.options.map((o) => (
                  <div key={o.text} style={{ display: 'grid', gap: 4 }}>
                    <div className="row"><span className="t-medium grow" style={{ flex: 1 }}>{o.text}</span><span className="t-strong">{o.count}</span></div>
                    <div className="poll-bar" aria-hidden="true"><span style={{ width: `${p.answered ? (100 * o.count) / p.answered : 0}%` }} /></div>
                    {o.names?.length ? <div className="t-caption">{o.names.join(', ')}</div> : null}
                  </div>
                ))
              : q.answers.length
                ? q.answers.map((a, n) => (
                    <div key={n} className="poll-answer">
                      {a.name ? <div className="t-caption t-medium">{a.name}</div> : null}
                      <div>{a.text}</div>
                    </div>
                  ))
                : <span className="t-small muted">No answers.</span>}
          </div>
        </section>
      ))}
      {confirm ? (
        <ConfirmDialog
          title={`Close ${p.title} now?`}
          body="Nobody can answer or change their answers after this. Results post in the space as if it had closed on time."
          confirmLabel="Close now"
          onConfirm={async () => {
            await close.mutateAsync();
            setConfirm(false);
          }}
          onCancel={() => setConfirm(false)}
        />
      ) : null}
    </div>
  );
}

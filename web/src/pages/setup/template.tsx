import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { api, type StandupSummary, type Template } from '../../lib/api';
import { useSpaceNames, useStandups } from '../../lib/standups';
import { StepActions, StepPage } from './layout';

const DAY_LABEL: Record<string, string> = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };

export function cadence(t: Template): string {
  const days = t.days.length === 5 && !t.days.includes('sat') && !t.days.includes('sun') ? 'Every weekday' : t.days.length === 7 ? 'Every day' : t.days.map((d) => DAY_LABEL[d] ?? d).join(', ');
  const q = t.questions ? `${t.questions.length} question${t.questions.length === 1 ? '' : 's'}` : 'you decide';
  return `${days} · ${q}${t.moodEnabled && t.moodAnonymous ? ' · anonymous mood' : ''}`;
}

/** Standups that already exist — usually made with `setup` in a space — so nobody creates a duplicate by accident. */
export function ExistingStandups({ standups }: { standups: StandupSummary[] }) {
  const spaceNames = useSpaceNames();
  return (
    <section className="card section" aria-label="Your standups">
      <div>
        <h2 className="t-h3">{standups.length === 1 ? 'You already have a standup' : `You already have ${standups.length} standups`}</h2>
        <div className="t-small secondary">Set up who is on it and which days they work, rather than creating another in the same space.</div>
      </div>
      {standups.map((s) => (
        <div key={s.id} className="row">
          <span className="t-medium">{s.name}</span>
          <span className="t-small secondary">{spaceNames.data?.get(s.spaceName) ?? s.spaceName} · {s.people.total === 1 ? '1 person' : `${s.people.total} people`}</span>
          <div className="grow" />
          <Link to="/standups/$id/settings" params={{ id: String(s.id) }} className="btn btn-primary">Set up people</Link>
        </div>
      ))}
    </section>
  );
}

export function TemplatePage() {
  const templates = useQuery({ queryKey: ['templates'], queryFn: () => api<{ templates: Template[] }>('/templates') });
  const standups = useStandups();
  const [picked, setPicked] = useState('daily-standup');
  const chosen = templates.data?.templates.find((t) => t.id === picked);
  const existing = standups.data ?? [];
  return (
    <StepPage
      id="template"
      title={existing.length ? 'Your standups' : 'Start from a template'}
      lede={existing.length ? 'Finish one you already have, or start another from a template.' : 'Every template is fully editable afterwards — questions, schedule, mood, everything.'}
      wide
    >
      {existing.length ? <ExistingStandups standups={existing} /> : null}
      {existing.length ? <h2 className="t-h3">Or create another from a template</h2> : null}
      {templates.isError ? <div className="alert">Could not load templates: {templates.error.message}</div> : null}
      <div className="grid-3" role="radiogroup" aria-label="Templates">
        {templates.data?.templates.map((t) => (
          <button key={t.id} type="button" className="choice" role="radio" aria-checked={t.id === picked} aria-pressed={t.id === picked} onClick={() => setPicked(t.id)}>
            <div className="row">
              <span className="t-strong">{t.name}</span>
              {t.id === 'daily-standup' ? <span className="badge badge-info">Most popular</span> : null}
            </div>
            <span className="t-small secondary">{t.questions ? t.questions.map((q) => q.replace(/\?$/, '')).join(' · ') : t.description}</span>
            <span className="t-caption">{cadence(t)}</span>
          </button>
        ))}
      </div>
      <StepActions back="/setup/sign-in">
        <Link to="/setup/create" search={{ template: picked }} className={existing.length ? 'btn' : 'btn btn-primary'}>{existing.length ? 'Create another' : 'Continue'} with {chosen?.name ?? 'template'}</Link>
      </StepActions>
    </StepPage>
  );
}

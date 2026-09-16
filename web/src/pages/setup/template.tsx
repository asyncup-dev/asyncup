import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { api, type Template } from '../../lib/api';
import { StepActions, StepPage } from './layout';

const DAY_LABEL: Record<string, string> = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };

export function cadence(t: Template): string {
  const days = t.days.length === 5 && !t.days.includes('sat') && !t.days.includes('sun') ? 'Every weekday' : t.days.length === 7 ? 'Every day' : t.days.map((d) => DAY_LABEL[d] ?? d).join(', ');
  const q = t.questions ? `${t.questions.length} question${t.questions.length === 1 ? '' : 's'}` : 'you decide';
  return `${days} · ${q}${t.moodEnabled && t.moodAnonymous ? ' · anonymous mood' : ''}`;
}

export function TemplatePage() {
  const templates = useQuery({ queryKey: ['templates'], queryFn: () => api<{ templates: Template[] }>('/templates') });
  const [picked, setPicked] = useState('daily-standup');
  const chosen = templates.data?.templates.find((t) => t.id === picked);
  return (
    <StepPage id="template" title="Start from a template" lede="Every template is fully editable afterwards — questions, schedule, mood, everything." wide>
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
        <Link to="/setup/create" search={{ template: picked }} className="btn btn-primary">Continue with {chosen?.name ?? 'template'}</Link>
      </StepActions>
    </StepPage>
  );
}

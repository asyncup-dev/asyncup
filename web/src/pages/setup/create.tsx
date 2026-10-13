import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { api, ApiError, type Person, type Space, type StandupSummary, type Template } from '../../lib/api';
import { timezoneOptions, useSetupProgress } from '../../lib/setup';
import { LogoLockup } from '../../components/logo';
import { PeopleMatrix, type MatrixChange, type MatrixRow } from '../../components/people-matrix';
import type { Weekday } from '../../lib/roster';

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
const DAY_LABEL: Record<string, string> = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };
const DEFAULT_QUESTIONS = ['What did you do yesterday?', 'What will you do today?', 'Any blockers?'];

/** `week` is the personal week to save once the standup exists; null follows the standup. */
type Member = Person & { mandatory: boolean; week: string | null };

export interface CreateForm {
  name: string;
  spaceName: string;
  people: Member[];
  promptTime: string;
  deadlineTime: string;
  timezone: string;
  days: string[];
  questions: string[];
  moodEnabled: boolean;
  moodAnonymous: boolean;
}

export function formFromTemplate(t: Template | undefined, timezone: string): CreateForm {
  return {
    name: t && t.id !== 'blank' ? t.name : '',
    spaceName: '',
    people: [],
    promptTime: t?.promptTime ?? '09:30',
    deadlineTime: t?.deadlineTime ?? '11:30',
    timezone,
    days: t?.days ?? ['mon', 'tue', 'wed', 'thu', 'fri'],
    questions: t?.questions ?? DEFAULT_QUESTIONS,
    moodEnabled: t?.moodEnabled ?? true,
    moodAnonymous: t?.moodAnonymous ?? false,
  };
}

export function CreateStandupPage() {
  const search = useSearch({ strict: false }) as { template?: string };
  const templateId = search.template ?? 'blank';
  const progress = useSetupProgress();
  const templates = useQuery({ queryKey: ['templates'], queryFn: () => api<{ templates: Template[] }>('/templates') });
  const spaces = useQuery({ queryKey: ['spaces'], queryFn: () => api<{ spaces: Space[] }>('/spaces') });
  const template = templates.data?.templates.find((t) => t.id === templateId);
  const tz = progress.data?.settings.workspace.defaultTimezone ?? 'UTC';
  const [form, setForm] = useState<CreateForm | null>(null);
  const [seeded, setSeeded] = useState('');
  const [error, setError] = useState<string | null>(null);
  const client = useQueryClient();
  const navigate = useNavigate();
  useEffect(() => {
    if (!form && templates.data && progress.data) setForm(formFromTemplate(template, tz));
  }, [form, templates.data, progress.data, template, tz]);

  const members = useQuery({
    queryKey: ['members', form?.spaceName],
    queryFn: () => api<{ members: Person[] }>(`/spaces/${encodeURIComponent(form!.spaceName)}/members`),
    enabled: !!form?.spaceName,
  });

  // A space is usually the team, so everyone in it starts on the standup; untick to leave someone out.
  useEffect(() => {
    if (form && members.data && form.spaceName !== seeded) {
      setSeeded(form.spaceName);
      setForm({ ...form, people: members.data.members.map((m) => ({ ...m, mandatory: true, week: null })) });
    }
  }, [form, members.data, seeded]);

  const create = useMutation({
    mutationFn: async (runNow: boolean) => {
      const f = form!;
      const created = await api<StandupSummary & { runNow: string | null }>('/standups', {
        method: 'POST',
        body: {
          templateId: templateId === 'blank' ? null : templateId,
          name: f.name,
          spaceName: f.spaceName,
          participants: f.people.map((p) => ({ userName: p.userName, displayName: p.displayName, mandatory: p.mandatory })),
          promptTime: f.promptTime,
          deadlineTime: f.deadlineTime,
          timezone: f.timezone,
          days: f.days,
          questions: f.questions.map((q) => q.trim()).filter(Boolean),
          moodEnabled: f.moodEnabled,
          moodAnonymous: f.moodAnonymous,
          runNow,
        },
      });
      for (const p of f.people.filter((m) => m.week !== null)) {
        try {
          await api(`/people/${encodeURIComponent(p.userName)}/schedule`, { method: 'PATCH', body: { workingDays: p.week } });
        } catch (err) {
          throw new Error(`The standup was created, but ${p.displayName}’s days did not save (${err instanceof Error ? err.message : String(err)}). Set them under the standup’s People.`);
        }
      }
      return created;
    },
    onSuccess: async (created) => {
      await api('/settings', { method: 'PATCH', body: { setupComplete: true } });
      await client.invalidateQueries({ queryKey: ['setup-progress'] });
      await client.invalidateQueries({ queryKey: ['standups'] });
      await navigate({ to: '/setup/live', search: { standup: created.id } });
    },
    onError: (err) => setError(err instanceof ApiError && err.field ? `${err.message} (${err.field})` : err.message),
  });

  if (!form) {
    if (templates.isError || progress.isError) return <div className="alert" style={{ margin: 24 }}>Could not load the form: {(templates.error ?? progress.error)?.message}</div>;
    return <p className="muted" style={{ padding: 24 }}>Loading…</p>;
  }
  const set = (patch: Partial<CreateForm>) => setForm({ ...form, ...patch });
  const rows: MatrixRow[] = [
    ...form.people.map((p) => ({ ...p, onStandup: true, workingDays: p.week, otherStandups: 0 })),
    ...(members.data?.members ?? [])
      .filter((m) => !form.people.some((p) => p.userName === m.userName))
      .map((m) => ({ ...m, onStandup: false, mandatory: true, workingDays: null, otherStandups: 0 })),
  ];
  const change = (row: MatrixRow, c: MatrixChange) => {
    const update = (patch: Partial<Member>) => set({ people: form.people.map((m) => (m.userName === row.userName ? { ...m, ...patch } : m)) });
    if ('onStandup' in c) {
      set({ people: c.onStandup ? [...form.people, { userName: row.userName, displayName: row.displayName, mandatory: true, week: null }] : form.people.filter((m) => m.userName !== row.userName) });
    } else if ('mandatory' in c) update({ mandatory: c.mandatory });
    else update({ week: c.week === 'reset' ? null : c.week });
  };
  // A space that already has a standup was usually set up with `setup` in Chat; point at it before a duplicate is made.
  const taken = spaces.data?.spaces.find((s) => s.name === form.spaceName)?.standups ?? [];
  const ready = form.name.trim() && form.spaceName && form.days.length > 0 && form.questions.some((q) => q.trim());

  return (
    <div>
      <div className="setup-brandbar row">
        <LogoLockup />
        <div className="grow" />
        <span className="t-small secondary">Template: {template?.name ?? 'Blank'}</span>
        <Link to="/setup/template" className="btn btn-ghost">Change</Link>
      </div>
      <div className="setup-centered" style={{ maxWidth: 760, justifyItems: 'stretch', textAlign: 'left' }}>
        <div>
          <h1 className="t-h1" style={{ margin: 0 }}>{progress.data && progress.data.standups > 0 ? 'Create a standup' : 'Create your first standup'}</h1>
          <p className="lede">Four things and it runs. Everything can be changed later in the standup’s settings.</p>
        </div>

        <section className="card section">
          <h2 className="t-h3">Basics</h2>
          <div className="grid-2">
            <div className="field">
              <label htmlFor="name">Name</label>
              <input id="name" className="input" value={form.name} onChange={(e) => set({ name: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="space">Post in space</label>
              <select id="space" className="input" value={form.spaceName} onChange={(e) => set({ spaceName: e.target.value })}>
                <option value="">Choose a space…</option>
                {spaces.data?.spaces.map((s) => (
                  <option key={s.name} value={s.name}>{s.displayName}{s.standups.length ? ` (${s.standups.length} standup${s.standups.length === 1 ? '' : 's'} already)` : ''}</option>
                ))}
              </select>
              <div className="t-caption">{spaces.isError ? `Could not list spaces: ${spaces.error.message}` : 'Spaces the bot has been added to'}</div>
              {taken.map((s) => (
                <div key={s.id} className="notice t-small" role="status">
                  This space already has <strong>{s.name}</strong>. <Link to="/standups/$id/settings" params={{ id: String(s.id) }}>Set it up instead</Link>, or carry on to create a second one.
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="card section">
          <div>
            <h2 className="t-h3">People · {form.people.length} on this standup</h2>
            <div className="t-small secondary">Ticked people get a DM at prompt time on their days. Untick “counts if missing” for people who may skip.</div>
          </div>
          {!form.spaceName ? (
            <span className="t-small muted">Pick a space to see who is in it.</span>
          ) : members.isPending ? (
            <span className="t-small muted">Looking up members…</span>
          ) : members.isError ? (
            <span className="t-small secondary">Could not list members: {members.error.message}</span>
          ) : (
            <PeopleMatrix rows={rows} standupDays={form.days as Weekday[]} onChange={change} />
          )}
        </section>

        <section className="card section">
          <h2 className="t-h3">Schedule</h2>
          <div className="grid-3">
            <div className="field">
              <label htmlFor="prompt">Prompt at</label>
              <input id="prompt" className="input" value={form.promptTime} onChange={(e) => set({ promptTime: e.target.value })} placeholder="09:30" />
              <div className="t-caption">in each person’s timezone</div>
            </div>
            <div className="field">
              <label htmlFor="deadline">Deadline</label>
              <input id="deadline" className="input" value={form.deadlineTime} onChange={(e) => set({ deadlineTime: e.target.value })} placeholder="11:30" />
              <div className="t-caption">standup timezone</div>
            </div>
            <div className="field">
              <label htmlFor="tz">Timezone</label>
              <select id="tz" className="input" value={form.timezone} onChange={(e) => set({ timezone: e.target.value })}>
                {timezoneOptions(tz).map((z) => <option key={z} value={z}>{z}</option>)}
              </select>
            </div>
          </div>
          <div className="field">
            <span className="t-medium">Days</span>
            <div className="days">
              {DAYS.map((d) => (
                <button key={d} type="button" className="day" aria-pressed={form.days.includes(d)} onClick={() => set({ days: form.days.includes(d) ? form.days.filter((x) => x !== d) : DAYS.filter((x) => x === d || form.days.includes(x)) })}>
                  {DAY_LABEL[d]}
                </button>
              ))}
            </div>
          </div>
        </section>

        <section className="card section">
          <div>
            <h2 className="t-h3">Questions</h2>
            <div className="t-small secondary">Each person answers all of them in one form.</div>
          </div>
          <div style={{ display: 'grid', gap: 8 }}>
            {form.questions.map((q, i) => (
              <div key={i} className="qrow">
                <input className="input" aria-label={`Question ${i + 1}`} value={q} onChange={(e) => set({ questions: form.questions.map((x, j) => (j === i ? e.target.value : x)) })} />
                <button type="button" className="icon-btn" aria-label={`Move question ${i + 1} up`} disabled={i === 0} onClick={() => { const qs = [...form.questions]; [qs[i - 1], qs[i]] = [qs[i]!, qs[i - 1]!]; set({ questions: qs }); }}>↑</button>
                <button type="button" className="icon-btn" aria-label={`Remove question ${i + 1}`} disabled={form.questions.length === 1} onClick={() => set({ questions: form.questions.filter((_, j) => j !== i) })}>×</button>
              </div>
            ))}
          </div>
          <div>
            <button type="button" className="btn btn-ghost" disabled={form.questions.length >= 10} onClick={() => set({ questions: [...form.questions, ''] })}>+ Add question</button>
          </div>
          <div className="switch">
            <input id="mood" type="checkbox" checked={form.moodEnabled} onChange={(e) => set({ moodEnabled: e.target.checked })} />
            <label htmlFor="mood">
              <div className="t-medium">Ask how people feel today</div>
              <div className="t-caption">A five-point mood pick. Team average shows in reports; individual moods can be kept anonymous.</div>
            </label>
          </div>
          {form.moodEnabled ? (
            <div className="switch">
              <input id="anon" type="checkbox" checked={form.moodAnonymous} onChange={(e) => set({ moodAnonymous: e.target.checked })} />
              <label htmlFor="anon" className="t-small">Keep individual moods anonymous</label>
            </div>
          ) : null}
        </section>

        {error ? <div className="alert" role="alert">{error}</div> : null}
        <div className="setup-actions">
          <Link to="/setup/template" className="btn btn-ghost">Back</Link>
          <div className="grow" />
          <button type="button" className="btn" disabled={!ready || create.isPending} onClick={() => create.mutate(false)}>Create without running</button>
          <button type="button" className="btn btn-primary btn-lg" disabled={!ready || create.isPending} onClick={() => create.mutate(true)}>Create and run it now</button>
        </div>
      </div>
    </div>
  );
}

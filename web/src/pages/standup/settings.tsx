import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { ConfirmDialog } from '../../components/confirm-dialog';
import { SectionCard, SettingsRow } from '../../components/settings-row';
import { fromMutation, VerifyStatus } from '../../components/verify-status';
import { api, type Person } from '../../lib/api';
import { useArchive, useParticipantAdd, useParticipantPatch, useParticipantRemove, useStandupPatch } from '../../lib/people';
import { useVerifyMutation } from '../../lib/settings';
import { timezoneOptions } from '../../lib/setup';
import { useStandup } from '../../lib/standups';
import { useStandupId } from './layout';

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
const DAY_LABEL: Record<string, string> = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };

export function StandupSettingsPage() {
  const id = useStandupId();
  const standup = useStandup(id);
  const patch = useStandupPatch(id);
  const archive = useArchive(id);
  const pPatch = useParticipantPatch();
  const pRemove = useParticipantRemove();
  const pAdd = useParticipantAdd();
  const verifyWebhook = useVerifyMutation('webhook');
  const s = standup.data;
  const [schedule, setSchedule] = useState<{ promptTime: string; deadlineTime: string; timezone: string; days: string[]; reminderMinutesBefore: string } | null>(null);
  const [questions, setQuestions] = useState<string[] | null>(null);
  const [escalate, setEscalate] = useState<{ afterDays: string; userName: string } | null>(null);
  const [webhook, setWebhook] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<'archive' | Person | null>(null);
  const [adding, setAdding] = useState(false);
  const members = useQuery({ queryKey: ['members', s?.spaceName], queryFn: () => api<{ members: Person[] }>(`/spaces/${encodeURIComponent(s!.spaceName)}/members`), enabled: adding && !!s });
  useEffect(() => {
    if (s && !schedule) {
      setSchedule({ promptTime: s.schedule.promptTime, deadlineTime: s.schedule.deadlineTime, timezone: s.schedule.timezone, days: s.schedule.days, reminderMinutesBefore: String(s.schedule.reminderMinutesBefore) });
      setQuestions(s.questions);
      setEscalate({ afterDays: String(s.escalation.afterDays), userName: s.escalation.contact?.userName ?? '' });
    }
  }, [s, schedule]);
  if (standup.isError) return <div className="alert">Could not load this standup: {standup.error.message}</div>;
  if (!s || !schedule || !questions || !escalate) return <p className="muted">Loading…</p>;
  const save = async (body: Record<string, unknown>, what: string) => {
    try {
      setError(null);
      setSaved(null);
      await patch.mutateAsync(body);
      setSaved(`${what} saved. Changes apply from the next run.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not save.');
    }
  };
  const roster = async (fn: () => Promise<unknown>) => {
    try {
      setError(null);
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not work.');
    }
  };
  const suggestions = (members.data?.members ?? []).filter((m) => !s.participants.some((p) => p.userName === m.userName));
  return (
    <>
      {error ? <div className="alert" role="alert">{error}</div> : null}
      {saved ? <div className="toast" role="status">{saved}</div> : null}
      <div className="overview">
        <div className="col">
          <SectionCard title="Schedule" hint="Changes apply from the next run." action={<button type="button" className="btn btn-primary" style={{ height: 28 }} disabled={patch.isPending} onClick={() => void save({ ...schedule, reminderMinutesBefore: Number(schedule.reminderMinutesBefore) }, 'Schedule')}>Save</button>}>
            <SettingsRow label="Prompt and deadline" hint="Prompt goes out in each person’s own timezone">
              <input className="input" aria-label="Prompt time" style={{ width: 110 }} value={schedule.promptTime} onChange={(e) => setSchedule({ ...schedule, promptTime: e.target.value })} />
              <span>→</span>
              <input className="input" aria-label="Deadline time" style={{ width: 110 }} value={schedule.deadlineTime} onChange={(e) => setSchedule({ ...schedule, deadlineTime: e.target.value })} />
              <select className="input" aria-label="Timezone" style={{ width: 'auto' }} value={schedule.timezone} onChange={(e) => setSchedule({ ...schedule, timezone: e.target.value })}>
                {timezoneOptions(s.schedule.timezone).map((z) => <option key={z} value={z}>{z}</option>)}
              </select>
            </SettingsRow>
            <SettingsRow label="Days">
              <div className="days">
                {DAYS.map((d) => (
                  <button key={d} type="button" className="day" aria-pressed={schedule.days.includes(d)} onClick={() => setSchedule({ ...schedule, days: schedule.days.includes(d) ? schedule.days.filter((x) => x !== d) : DAYS.filter((x) => x === d || schedule.days.includes(x)) })}>{DAY_LABEL[d]}</button>
                ))}
              </div>
            </SettingsRow>
            <SettingsRow label="Reminder nudge">
              <input className="input" aria-label="Reminder minutes" style={{ width: 80 }} inputMode="numeric" value={schedule.reminderMinutesBefore} onChange={(e) => setSchedule({ ...schedule, reminderMinutesBefore: e.target.value })} />
              <span className="t-small secondary">minutes before the deadline</span>
            </SettingsRow>
          </SectionCard>
          <SectionCard title="Questions" hint="Everyone answers all of them in one form." action={<button type="button" className="btn btn-primary" style={{ height: 28 }} disabled={patch.isPending} onClick={() => void save({ questions: questions.map((q) => q.trim()).filter(Boolean) }, 'Questions')}>Save</button>}>
            <div className="settings-row" style={{ gridTemplateColumns: '1fr' }}>
              <div style={{ display: 'grid', gap: 8 }}>
                {questions.map((q, i) => (
                  <div key={i} className="qrow">
                    <input className="input" aria-label={`Question ${i + 1}`} value={q} onChange={(e) => setQuestions(questions.map((x, j) => (j === i ? e.target.value : x)))} />
                    <button type="button" className="icon-btn" aria-label={`Move question ${i + 1} up`} disabled={i === 0} onClick={() => { const qs = [...questions]; [qs[i - 1], qs[i]] = [qs[i]!, qs[i - 1]!]; setQuestions(qs); }}>↑</button>
                    <button type="button" className="icon-btn" aria-label={`Remove question ${i + 1}`} disabled={questions.length === 1} onClick={() => setQuestions(questions.filter((_, j) => j !== i))}>×</button>
                  </div>
                ))}
                <div><button type="button" className="btn btn-ghost" style={{ height: 28 }} disabled={questions.length >= 10} onClick={() => setQuestions([...questions, ''])}>+ Add question</button></div>
              </div>
            </div>
            <SettingsRow label="Mood" hint="A five-point pick after the questions.">
              <label className="row t-small"><input type="checkbox" checked={s.mood.enabled} onChange={(e) => void save({ moodEnabled: e.target.checked }, 'Mood')} /> Mood question {s.mood.enabled ? 'on' : 'off'}</label>
              {s.mood.enabled ? <label className="row t-small"><input type="checkbox" checked={s.mood.anonymous} onChange={(e) => void save({ moodAnonymous: e.target.checked }, 'Mood')} /> answers shown anonymously</label> : null}
            </SettingsRow>
          </SectionCard>
          <SectionCard title={`Participants · ${s.participants.length}`} hint="Optional people aren’t counted as missing." action={<button type="button" className="btn" style={{ height: 28 }} onClick={() => setAdding(!adding)}>{adding ? 'Done' : 'Add people'}</button>}>
            {adding ? (
              <div className="settings-row t-small" style={{ gridTemplateColumns: '1fr' }}>
                <div className="row-wrap">
                  {members.isPending ? <span className="muted">Looking up the space…</span> : null}
                  {members.isError ? <span className="alert">Could not list members: {members.error.message}</span> : null}
                  {members.data && suggestions.length === 0 ? <span className="muted">Everyone in the space is already here.</span> : null}
                  {suggestions.map((m) => <button key={m.userName} type="button" className="btn btn-ghost" style={{ height: 26 }} onClick={() => void roster(() => pAdd.mutateAsync({ standupId: id, person: m, mandatory: true }))}>+ {m.displayName}</button>)}
                </div>
              </div>
            ) : null}
            {s.participants.map((p) => (
              <div key={p.userName} className="settings-row" style={{ gridTemplateColumns: '24px 1fr auto auto auto auto auto' }}>
                <span className="avatar avatar-sm" aria-hidden="true">{p.displayName[0]}</span>
                <span className="t-medium">{p.displayName}{s.admins.some((a) => a.userName === p.userName) ? <span className="badge badge-info" style={{ marginLeft: 8 }}>Manager</span> : null}</span>
                <span className={`badge ${p.mandatory ? '' : 'badge-warning'}`}>{p.mandatory ? 'Mandatory' : 'Optional'}</span>
                <span className="t-caption">{p.timezone ?? s.schedule.timezone}</span>
                <span className={`badge ${p.onVacation ? 'badge-warning' : 'badge-success'}`}>{p.onVacation ? 'Away' : 'Active'}</span>
                <button type="button" className="btn btn-ghost" style={{ height: 26 }} onClick={() => void roster(() => pPatch.mutateAsync({ standupId: id, userName: p.userName, patch: { mandatory: !p.mandatory } }))}>{p.mandatory ? 'Make optional' : 'Make mandatory'}</button>
                <button type="button" className="btn btn-ghost btn-danger" style={{ height: 26 }} aria-label={`Remove ${p.displayName}`} onClick={() => setConfirm(p)}>Remove</button>
              </div>
            ))}
          </SectionCard>
        </div>
        <div className="col">
          <SectionCard title="Blockers & escalation" action={<button type="button" className="btn btn-primary" style={{ height: 28 }} disabled={patch.isPending} onClick={() => void save({ escalateAfterDays: Number(escalate.afterDays), escalateUserName: escalate.userName || null }, 'Escalation')}>Save</button>}>
            <SettingsRow label="Escalate after">
              <input className="input" aria-label="Escalate after days" style={{ width: 70 }} inputMode="numeric" value={escalate.afterDays} onChange={(e) => setEscalate({ ...escalate, afterDays: e.target.value })} />
              <span className="t-small secondary">days</span>
            </SettingsRow>
            <SettingsRow label="Escalate to">
              <select className="input" aria-label="Escalation contact" value={escalate.userName} onChange={(e) => setEscalate({ ...escalate, userName: e.target.value })}>
                <option value="">— off —</option>
                {s.participants.map((p) => <option key={p.userName} value={p.userName}>{p.displayName}</option>)}
              </select>
            </SettingsRow>
          </SectionCard>
          <SectionCard title="Integrations">
            <SettingsRow label="Outbound webhook" hint="JSON POST on each submission and wrap-up, signed with X-AsyncUp-Signature.">
              <input className="input" aria-label="Webhook URL" value={webhook ?? (s.webhook.configured ? '(configured — enter a new URL to replace)' : '')} onFocus={() => webhook === null && setWebhook('')} onChange={(e) => setWebhook(e.target.value)} placeholder="https://…" />
              <button type="button" className="btn" style={{ height: 28 }} disabled={webhook === null || patch.isPending} onClick={() => void save({ webhookUrl: webhook?.trim() || null }, 'Webhook').then(() => setWebhook(null))}>Save</button>
              {s.webhook.configured ? <button type="button" className="btn btn-ghost" style={{ height: 28 }} disabled={verifyWebhook.isPending} onClick={() => verifyWebhook.mutate({ standupId: id })}>Send test</button> : null}
              {verifyWebhook.data || verifyWebhook.isPending || verifyWebhook.isError ? <div style={{ flexBasis: '100%' }}><VerifyStatus state={fromMutation(verifyWebhook)} /></div> : null}
            </SettingsRow>
            <SettingsRow label="Weekly digest" hint="Posted to the space at the end of the week.">
              <label className="row t-small"><input type="checkbox" checked={s.digestEnabled} onChange={(e) => void save({ digestEnabled: e.target.checked }, 'Digest')} /> {s.digestEnabled ? 'On' : 'Off'}</label>
            </SettingsRow>
          </SectionCard>
          <SectionCard title="Danger zone">
            <SettingsRow label={s.active ? 'Archive standup' : 'Unarchive standup'} hint={s.active ? 'Stops prompts. History stays readable.' : 'Prompts resume on the next scheduled day.'}>
              <button type="button" className={`btn ${s.active ? 'btn-danger' : ''}`} style={{ height: 28 }} onClick={() => (s.active ? setConfirm('archive') : void roster(() => archive.mutateAsync('unarchive')))}>{s.active ? 'Archive' : 'Unarchive'}</button>
            </SettingsRow>
            <SettingsRow label="Delete standup" hint="Not available — archive instead; nothing is lost.">
              <span className="badge">Not available</span>
            </SettingsRow>
          </SectionCard>
        </div>
      </div>
      {confirm === 'archive' ? (
        <ConfirmDialog title={`Archive ${s.name}?`} body="No more prompts or reports. History stays in the database and exports." confirmLabel="Archive" typed="ARCHIVE" danger onConfirm={() => roster(() => archive.mutateAsync('archive')).then(() => setConfirm(null))} onCancel={() => setConfirm(null)} />
      ) : confirm ? (
        <ConfirmDialog title={`Remove ${confirm.displayName}?`} body="They stop being prompted from the next run. Their past answers stay in the history." confirmLabel="Remove" danger onConfirm={() => roster(() => pRemove.mutateAsync({ standupId: id, userName: confirm.userName })).then(() => setConfirm(null))} onCancel={() => setConfirm(null)} />
      ) : null}
    </>
  );
}

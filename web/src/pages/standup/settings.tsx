import { useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { ConfirmDialog } from '../../components/confirm-dialog';
import { PeopleMatrix, type MatrixChange, type MatrixRow } from '../../components/people-matrix';
import { SectionCard, SettingsRow } from '../../components/settings-row';
import { fromMutation, VerifyStatus } from '../../components/verify-status';
import type { Person } from '../../lib/api';
import { ago } from '../../lib/format';
import { useMe } from '../../lib/auth';
import { useArchive, useDeleteStandup, useParticipantAdd, useParticipantPatch, useParticipantRemove, useRosterSync, useStandupMembers, useStandupPatch, type RosterSynced } from '../../lib/people';
import type { Weekday } from '../../lib/roster';
import { useSetWeek } from '../../lib/schedule';
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
  const remove = useDeleteStandup(id);
  const me = useMe();
  const navigate = useNavigate();
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
  const [confirm, setConfirm] = useState<'archive' | 'delete' | Person | null>(null);
  const setWeek = useSetWeek(id);
  const sync = useRosterSync(id);
  const [groupDraft, setGroupDraft] = useState<string | null>(null);
  const [synced, setSynced] = useState<RosterSynced | null>(null);
  const followsGroup = !!standup.data?.roster.group;
  const members = useStandupMembers(id, !!standup.data && !followsGroup);
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
  // A group roster lists the group's people (and anyone kept off); otherwise the space's members are the candidates.
  const offRows = followsGroup
    ? s.keptOff.map((m) => ({ ...m, badges: ['from group'] }))
    : (members.data ?? []).filter((m) => !s.participants.some((p) => p.userName === m.userName));
  const rows: MatrixRow[] = [
    ...s.participants.map((p) => ({
      ...p,
      onStandup: true,
      badges: [
        ...(followsGroup ? [p.source === 'group' ? 'from group' : 'added by hand'] : []),
        ...(s.admins.some((a) => a.userName === p.userName) ? ['Manager'] : []),
        ...(p.onVacation ? ['Away'] : []),
      ],
    })),
    ...offRows.map((m) => ({ ...m, onStandup: false, mandatory: true, workingDays: null, otherStandups: 0 })),
  ];
  const runSync = () =>
    void roster(async () => {
      setSynced(null);
      setSynced(await sync.mutateAsync());
    });
  const draft = groupDraft ?? s.roster.group ?? '';
  const change = (row: MatrixRow, c: MatrixChange) => {
    const person = { userName: row.userName, displayName: row.displayName };
    if ('onStandup' in c) {
      if (c.onStandup) void roster(() => pAdd.mutateAsync({ standupId: id, person, mandatory: true }));
      else setConfirm(person);
    } else if ('mandatory' in c) void roster(() => pPatch.mutateAsync({ standupId: id, userName: row.userName, patch: { mandatory: c.mandatory } }));
    else void roster(() => setWeek.mutateAsync({ userName: row.userName, workingDays: c.week }));
  };
  return (
    <>
      {error ? <div className="alert" role="alert">{error}</div> : null}
      {saved ? <div className="toast" role="status">{saved}</div> : null}
      <div className="overview">
        <div className="col">
          <SectionCard title="Schedule" hint="Changes apply from the next run." action={<button type="button" className="btn btn-primary" style={{ height: 28 }} disabled={patch.isPending} onClick={() => void save({ ...schedule, reminderMinutesBefore: Number(schedule.reminderMinutesBefore) }, 'Schedule')}>Save</button>}>
            <SettingsRow label="Prompt and deadline" hint="Prompt goes out in each person’s own timezone">
              <input type="time" required className="input" aria-label="Prompt time" style={{ width: 110 }} value={schedule.promptTime} onChange={(e) => setSchedule({ ...schedule, promptTime: e.target.value })} />
              <span>→</span>
              <input type="time" required className="input" aria-label="Deadline time" style={{ width: 110 }} value={schedule.deadlineTime} onChange={(e) => setSchedule({ ...schedule, deadlineTime: e.target.value })} />
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
            <SettingsRow label="Time off" hint="Who can mark someone away, and whether a manager must approve. Managers can always override.">
              <select className="input" aria-label="Time-off policy" style={{ width: 'auto' }} value={s.timeOffPolicy} disabled={patch.isPending} onChange={(e) => void save({ timeOffPolicy: e.target.value }, 'Time-off policy')}>
                <option value="self">Self-service — managers get a daily digest</option>
                <option value="approval">Needs a manager’s approval</option>
                <option value="managers">Managers only</option>
              </select>
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
          <SectionCard title={`People · ${s.participants.length} on this standup`} hint="Tick who is prompted, who is required to answer, and which days each person works.">
            <SettingsRow label="Roster" hint={followsGroup ? 'Follows a Google Group: joiners get the default setup, leavers drop off, and people you untick stay off.' : 'People you pick from the space’s members.'}>
              <select
                className="input"
                aria-label="Roster source"
                style={{ width: 'auto' }}
                value={groupDraft !== null || followsGroup ? 'group' : 'space'}
                disabled={patch.isPending}
                onChange={(e) => (e.target.value === 'group' ? setGroupDraft(s.roster.group ?? '') : void save({ rosterGroup: null }, 'Roster').then(() => setGroupDraft(null)))}
              >
                <option value="space">Picked from the space</option>
                <option value="group">Everyone in a Google Group</option>
              </select>
              {groupDraft !== null || followsGroup ? (
                <>
                  <input className="input" aria-label="Roster group email" style={{ width: 240 }} placeholder="team@example.com" value={draft} onChange={(e) => setGroupDraft(e.target.value)} />
                  <button type="button" className="btn btn-primary" style={{ height: 28 }} disabled={patch.isPending || !draft.trim() || draft.trim().toLowerCase() === s.roster.group} onClick={() => void save({ rosterGroup: draft.trim() }, 'Roster group').then(() => setGroupDraft(null))}>Save</button>
                </>
              ) : null}
            </SettingsRow>
            {followsGroup ? (
              <SettingsRow label="Last sync" hint="Also syncs hourly and in the hour before each run.">
                <span className="t-small">{s.roster.syncedAt ? `Synced ${ago(Date.now() - Date.parse(s.roster.syncedAt))}` : 'Not synced yet'}</span>
                <button type="button" className="btn" style={{ height: 28 }} disabled={sync.isPending} onClick={runSync}>Sync now</button>
                {s.roster.error ? <div className="alert" style={{ flexBasis: '100%' }}>{s.roster.error}</div> : null}
                {synced ? (
                  <div className="notice t-small" role="status" style={{ flexBasis: '100%' }}>
                    {synced.added.length ? `Added ${synced.added.join(', ')}. ` : ''}
                    {synced.removed.length ? `Removed ${synced.removed.join(', ')}. ` : ''}
                    {!synced.added.length && !synced.removed.length ? 'Already up to date. ' : ''}
                    {synced.skipped.length ? `Skipped ${synced.skipped.map((x) => `${x.email} (${x.reason})`).join(', ')}.` : ''}
                  </div>
                ) : null}
              </SettingsRow>
            ) : null}
            {members.isError ? <div className="settings-row"><span className="alert">Could not list the space’s members: {members.error.message}. Showing the current roster only.</span></div> : null}
            <PeopleMatrix rows={rows} standupDays={s.schedule.days as Weekday[]} busy={pAdd.isPending || pPatch.isPending || pRemove.isPending || setWeek.isPending} onChange={change} />
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
                {[...s.participants, ...s.admins.filter((a) => !s.participants.some((p) => p.userName === a.userName))].map((p) => (
                  <option key={p.userName} value={p.userName}>{p.displayName}</option>
                ))}
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
            <SettingsRow
              label="Delete standup"
              hint={
                me.data?.kind !== 'admin'
                  ? 'Only workspace admins can delete a standup. Archiving stops it and keeps its history.'
                  : s.active
                    ? 'Archive it first. Deleting removes every run, answer, blocker and poll for good.'
                    : 'Removes every run, answer, blocker and poll for good. People’s own days and time off stay.'
              }
            >
              <button type="button" className="btn btn-danger" style={{ height: 28 }} disabled={me.data?.kind !== 'admin' || s.active} onClick={() => setConfirm('delete')}>Delete</button>
            </SettingsRow>
          </SectionCard>
        </div>
      </div>
      {confirm === 'delete' ? (
        <ConfirmDialog
          title={`Delete ${s.name}?`}
          body="Every run, answer, blocker and poll of this standup is removed for good. Messages already posted in Chat stay there."
          confirmLabel="Delete"
          typed={s.name}
          danger
          onConfirm={async () => {
            try {
              setError(null);
              await remove.mutateAsync(s.name);
              await navigate({ to: '/standups' });
            } catch (err) {
              setError(err instanceof Error ? err.message : 'That did not delete.');
              setConfirm(null);
            }
          }}
          onCancel={() => setConfirm(null)}
        />
      ) : confirm === 'archive' ? (
        <ConfirmDialog title={`Archive ${s.name}?`} body="No more prompts or reports. History stays in the database and exports." confirmLabel="Archive" typed="ARCHIVE" danger onConfirm={() => roster(() => archive.mutateAsync('archive')).then(() => setConfirm(null))} onCancel={() => setConfirm(null)} />
      ) : confirm ? (
        <ConfirmDialog title={`Remove ${confirm.displayName}?`} body="They stop being prompted from the next run. Their past answers stay in the history." confirmLabel="Remove" danger onConfirm={() => roster(() => pRemove.mutateAsync({ standupId: id, userName: confirm.userName })).then(() => setConfirm(null))} onCancel={() => setConfirm(null)} />
      ) : null}
    </>
  );
}

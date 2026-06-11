import express, { type Express, type Request, type Response } from 'express';
import { DateTime, IANAZone } from 'luxon';
import { moodEmoji, rangeStats } from '../core/insights.js';
import {
  MOOD_EMOJI,
  standupQuestions,
  WEEKDAYS,
  type Standup,
  type Weekday,
} from '../core/types.js';
import type { Repo } from '../db/repo.js';

export interface DashboardDeps {
  repo: Repo;
  /** Empty string disables the dashboard entirely. */
  token: string;
  now?: () => DateTime;
}

const COOKIE = 'asyncup_dash';
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function registerDashboard(app: Express, deps: DashboardDeps): void {
  if (!deps.token) return;
  const { repo, token } = deps;
  const now = deps.now ?? (() => DateTime.utc());

  app.use('/dashboard', express.urlencoded({ extended: false }));

  const authed = (req: Request, res: Response): boolean => {
    if (req.query.token === token) {
      res.setHeader(
        'Set-Cookie',
        `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/dashboard`,
      );
      return true;
    }
    const cookie = req.headers.cookie
      ?.split(';')
      .map((c) => c.trim())
      .find((c) => c.startsWith(`${COOKIE}=`));
    if (cookie && decodeURIComponent(cookie.slice(COOKIE.length + 1)) === token) return true;
    res.status(401).send(layout('Unauthorized', `<p>Open <code>/dashboard?token=…</code> with your DASHBOARD_TOKEN.</p>`));
    return false;
  };

  app.get('/dashboard', (req, res) => {
    if (!authed(req, res)) return;
    const standups = repo.listActiveStandups();
    const rows = standups
      .map((s) => {
        const today = now().setZone(s.timezone).toISODate()!;
        const run = repo.getRun(s.id, today);
        const todayCell = run
          ? `${repo.listSubmissions(run.id).length} submitted (${run.status})`
          : '—';
        return `<tr>
          <td><a href="/dashboard/standup/${s.id}">#${s.id} ${esc(s.name)}</a></td>
          <td>${esc(s.spaceName)}</td>
          <td>${esc(s.promptTime)} → ${esc(s.deadlineTime)} ${esc(s.timezone)}</td>
          <td>${repo.listParticipants(s.id).length}</td>
          <td>${todayCell}</td>
        </tr>`;
      })
      .join('');
    res.send(
      layout(
        'AsyncUp dashboard',
        `<h1>Standups</h1>
        ${standups.length === 0 ? '<p>No standups yet — create one from Google Chat with <code>setup</code>.</p>' : ''}
        <table><tr><th>Standup</th><th>Space</th><th>Schedule</th><th>People</th><th>Today</th></tr>${rows}</table>`,
      ),
    );
  });

  app.get('/dashboard/standup/:id', (req, res) => {
    if (!authed(req, res)) return;
    const standup = repo.getStandupById(Number(req.params.id));
    if (!standup) {
      res.status(404).send(layout('Not found', '<p>Unknown standup.</p>'));
      return;
    }
    res.send(layout(`${standup.name} — AsyncUp`, standupPage(repo, standup, now(), req.query.saved === '1', null)));
  });

  app.post('/dashboard/standup/:id', (req, res) => {
    if (!authed(req, res)) return;
    const standup = repo.getStandupById(Number(req.params.id));
    if (!standup) {
      res.status(404).send(layout('Not found', '<p>Unknown standup.</p>'));
      return;
    }
    const error = applyConfig(repo, standup, req.body);
    if (error) {
      res.status(400).send(layout(`${standup.name} — AsyncUp`, standupPage(repo, repo.getStandupById(standup.id)!, now(), false, error)));
      return;
    }
    res.redirect(`/dashboard/standup/${standup.id}?saved=1`);
  });

  app.get('/dashboard/standup/:id/run/:date', (req, res) => {
    if (!authed(req, res)) return;
    const standup = repo.getStandupById(Number(req.params.id));
    const run = standup ? repo.getRun(standup.id, String(req.params.date)) : null;
    if (!standup || !run) {
      res.status(404).send(layout('Not found', '<p>Unknown run.</p>'));
      return;
    }
    const submissions = repo.listSubmissions(run.id)
      .map(
        (s) => `<div class="card">
          <h3>${s.mood && !standup.moodAnonymous ? MOOD_EMOJI[s.mood] : '📝'} ${esc(s.displayName)}
            ${s.late ? '<span class="tag">late</span>' : ''}${s.editedAt ? '<span class="tag">edited</span>' : ''}</h3>
          ${s.answers.map((a) => `<p><b>${esc(a.question)}</b><br>${esc(a.answer)}</p>`).join('')}
        </div>`,
      )
      .join('');
    const roster = repo.listRunParticipants(run.id);
    const submitted = new Set(repo.listSubmissions(run.id).map((s) => s.userName));
    const missing = roster
      .filter((p) => p.mandatory && !submitted.has(p.userName) && !p.skippedAt && !p.onVacation)
      .map((p) => esc(p.displayName));
    res.send(
      layout(
        `${run.date} — ${standup.name}`,
        `<p><a href="/dashboard/standup/${standup.id}">← ${esc(standup.name)}</a></p>
        <h1>${run.date} <small>(${run.status})</small></h1>
        ${missing.length ? `<p>❌ Missing: ${missing.join(', ')}</p>` : ''}
        ${submissions || '<p>No submissions.</p>'}`,
      ),
    );
  });
}

function applyConfig(repo: Repo, standup: Standup, body: any): string | null {
  const name = String(body.name ?? '').trim();
  if (!name) return 'Name is required.';
  const promptTime = String(body.promptTime ?? '');
  const deadlineTime = String(body.deadlineTime ?? '');
  if (!TIME_RE.test(promptTime) || !TIME_RE.test(deadlineTime)) return 'Times must be HH:MM (24h).';
  if (promptTime >= deadlineTime) return 'Prompt time must be before the deadline.';
  const timezone = String(body.timezone ?? '');
  if (!IANAZone.isValidZone(timezone)) return `Invalid IANA timezone: ${timezone}`;
  const reminder = Number(body.reminderMinutesBefore);
  if (!Number.isInteger(reminder) || reminder < 0 || reminder > 1440) return 'Reminder must be 0–1440 minutes.';
  const escalateDays = Number(body.escalateAfterDays);
  if (!Number.isInteger(escalateDays) || escalateDays < 1 || escalateDays > 30) return 'Escalation days must be 1–30.';

  const days = String(body.days ?? '')
    .toLowerCase()
    .split(/[,\s]+/)
    .filter(Boolean) as Weekday[];
  if (days.length === 0 || days.some((d) => !WEEKDAYS.includes(d))) {
    return 'Days must be a comma list of mon,tue,wed,thu,fri,sat,sun.';
  }

  const questionLines = String(body.questions ?? '')
    .split('\n')
    .map((q: string) => q.trim())
    .filter(Boolean);
  if (questionLines.length === 0 || questionLines.length > 10) return 'Provide 1–10 questions (one per line).';
  if (questionLines.some((q: string) => q.length > 200)) return 'Questions must be ≤200 characters.';

  repo.updateStandup(standup.id, {
    name,
    promptTime,
    deadlineTime,
    timezone,
    reminderMinutesBefore: reminder,
    days: WEEKDAYS.filter((d) => days.includes(d)).join(','),
    questions: questionLines,
    moodEnabled: body.moodEnabled === 'on',
    moodAnonymous: body.moodAnonymous === 'on',
    digestEnabled: body.digestEnabled === 'on',
    aiEnabled: body.aiEnabled === 'on',
    escalateAfterDays: escalateDays,
  });
  return null;
}

function standupPage(repo: Repo, s: Standup, now: DateTime, saved: boolean, error: string | null): string {
  const participants = repo.listParticipants(s.id)
    .map(
      (p) =>
        `<li>${esc(p.displayName)}${p.mandatory ? '' : ' <span class="tag">optional</span>'}${p.onVacation ? ' 🏖️' : ''}</li>`,
    )
    .join('');
  const admins = repo.listAdmins(s.id).map((a) => esc(a.displayName)).join(', ') || '<i>none (open config)</i>';

  const runs = repo.listRecentRuns(s.id, 14)
    .map((run) => {
      const roster = repo.listRunParticipants(run.id);
      const submitted = new Set(repo.listSubmissions(run.id).map((x) => x.userName));
      const away = roster.filter((p) => !submitted.has(p.userName) && (p.skippedAt || p.onVacation));
      const missing = roster.filter(
        (p) => p.mandatory && !submitted.has(p.userName) && !p.skippedAt && !p.onVacation,
      );
      return `<tr>
        <td><a href="/dashboard/standup/${s.id}/run/${run.date}">${run.date}</a></td>
        <td>${run.status}</td>
        <td>${submitted.size}/${roster.length - away.length}</td>
        <td>${missing.map((p) => esc(p.displayName)).join(', ') || '—'}</td>
      </tr>`;
    })
    .join('');

  const local = now.setZone(s.timezone);
  const trendRows = [3, 2, 1, 0]
    .map((i) => {
      const start = local.minus({ weeks: i }).startOf('week');
      const end = local.minus({ weeks: i }).endOf('week');
      const stats = rangeStats(repo, s.id, start.toISODate()!, end.toISODate()!);
      if (stats.runCount === 0) return `<tr><td>${start.toFormat('dd LLL')}</td><td colspan="2">no runs</td></tr>`;
      const pct = stats.expected === 0 ? 100 : Math.round((stats.submitted / stats.expected) * 100);
      const mood = stats.moodCount ? Math.round((stats.moodSum / stats.moodCount) * 10) / 10 : null;
      return `<tr><td>${start.toFormat('dd LLL')}–${end.toFormat('dd LLL')}</td><td>${pct}%</td><td>${
        mood !== null ? `${moodEmoji(mood)} ${mood}/5` : '—'
      }</td></tr>`;
    })
    .join('');

  const blockers = repo.listOpenBlockers(s.id)
    .map((b) => `<li>⚠️ <b>${esc(b.displayName)}</b>: ${esc(b.text)} <small>(since ${b.openedDate}${b.escalatedAt ? ', escalated' : ''})</small></li>`)
    .join('');

  const check = (v: boolean) => (v ? 'checked' : '');
  return `<p><a href="/dashboard">← All standups</a></p>
  <h1>#${s.id} ${esc(s.name)}</h1>
  ${saved ? '<p class="ok">✅ Saved.</p>' : ''}
  ${error ? `<p class="err">⚠️ ${esc(error)}</p>` : ''}
  <div class="cols">
  <form method="post" action="/dashboard/standup/${s.id}">
    <h2>Configuration</h2>
    <label>Name <input name="name" value="${esc(s.name)}"></label>
    <label>Prompt time <input name="promptTime" value="${esc(s.promptTime)}"> <small>participant-local</small></label>
    <label>Deadline <input name="deadlineTime" value="${esc(s.deadlineTime)}"></label>
    <label>Timezone <input name="timezone" value="${esc(s.timezone)}"></label>
    <label>Days <input name="days" value="${esc(s.days)}"></label>
    <label>Reminder (min before) <input name="reminderMinutesBefore" value="${s.reminderMinutesBefore}"></label>
    <label>Escalate after (days) <input name="escalateAfterDays" value="${s.escalateAfterDays}"></label>
    <label>Questions (one per line)<textarea name="questions" rows="4">${esc(standupQuestions(s).join('\n'))}</textarea></label>
    <label><input type="checkbox" name="moodEnabled" ${check(s.moodEnabled)}> Mood question</label>
    <label><input type="checkbox" name="moodAnonymous" ${check(s.moodAnonymous)}> Anonymous mood</label>
    <label><input type="checkbox" name="digestEnabled" ${check(s.digestEnabled)}> Weekly digest</label>
    <label><input type="checkbox" name="aiEnabled" ${check(s.aiEnabled)}> AI summaries</label>
    <button type="submit">Save</button>
    <p><small>Participants, admins and the escalation contact are managed from Google Chat
    (<code>add</code>, <code>admin</code>, <code>escalate @user</code> …) since they need Chat identities.</small></p>
  </form>
  <div>
    <h2>People</h2>
    <ul>${participants || '<li><i>none yet</i></li>'}</ul>
    <p><b>Admins:</b> ${admins}</p>
    <h2>Open blockers</h2>
    <ul>${blockers || '<li>✅ none</li>'}</ul>
    <h2>Trends</h2>
    <table><tr><th>Week</th><th>Participation</th><th>Mood</th></tr>${trendRows}</table>
  </div>
  </div>
  <h2>History (last 14 runs)</h2>
  <table><tr><th>Date</th><th>Status</th><th>Submitted</th><th>Missing</th></tr>${runs || '<tr><td colspan="4">no runs yet</td></tr>'}</table>`;
}

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function layout(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  body{font:15px/1.5 -apple-system,system-ui,sans-serif;max-width:960px;margin:2rem auto;padding:0 1rem;color:#222}
  table{border-collapse:collapse;width:100%;margin:.5rem 0}
  th,td{border:1px solid #ddd;padding:.4rem .6rem;text-align:left;font-size:.95em}
  th{background:#f6f6f6}
  a{color:#1a63c9} h1 small{color:#888;font-weight:normal}
  label{display:block;margin:.45rem 0} input,textarea{width:100%;max-width:320px;padding:.3rem;font:inherit}
  input[type=checkbox]{width:auto}
  button{margin-top:.6rem;padding:.45rem 1.2rem;font:inherit;background:#1a63c9;color:#fff;border:0;border-radius:4px;cursor:pointer}
  .cols{display:grid;grid-template-columns:1fr 1fr;gap:2rem}
  .card{border:1px solid #ddd;border-radius:6px;padding:.6rem 1rem;margin:.6rem 0}
  .tag{background:#eee;border-radius:3px;padding:0 .35rem;font-size:.8em;margin-left:.3rem}
  .ok{color:#1a7f37}.err{color:#c62828}
  @media(max-width:720px){.cols{grid-template-columns:1fr}}
</style></head><body>${body}</body></html>`;
}

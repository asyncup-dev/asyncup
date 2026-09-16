import type { DateTime } from 'luxon';
import { moodEmoji } from '../core/insights.js';
import { runProgress } from '../core/progress.js';
import { standupQuestions, type Standup } from '../core/types.js';
import { validateStandupConfig } from '../core/standup-config.js';
import type { Repo } from '../db/repo.js';
import { blockersChart, moodChart, participationChart, weeklySeries } from './charts.js';
import { esc } from './chrome.js';

/** The per-standup config form handler + the rendered detail page. */

export async function applyConfig(repo: Repo, standup: Standup, body: any): Promise<string | null> {
  const result = await validateStandupConfig(repo, standup, {
    name: String(body.name ?? ''),
    promptTime: String(body.promptTime ?? ''),
    deadlineTime: String(body.deadlineTime ?? ''),
    timezone: String(body.timezone ?? ''),
    reminderMinutesBefore: body.reminderMinutesBefore,
    escalateAfterDays: body.escalateAfterDays,
    days: String(body.days ?? ''),
    webhookUrl: String(body.webhookUrl ?? ''),
    questions: String(body.questions ?? '').split('\n'),
    moodEnabled: body.moodEnabled === 'on',
    moodAnonymous: body.moodAnonymous === 'on',
    digestEnabled: body.digestEnabled === 'on',
    escalateUserName: String(body.escalateUserName ?? ''),
  });
  if (!result.ok) return result.message;
  await repo.updateStandup(standup.id, result.fields);
  return null;
}

export async function standupPage(
  repo: Repo,
  s: Standup,
  now: DateTime,
  saved: boolean,
  error: string | null,
  notice: string | null = null,
  canRunNow = false,
  webhookSecret?: (standupId: number) => string,
): Promise<string> {
  const roster = await repo.listParticipants(s.id);
  const rosterAction = (p: { userName: string }, action: string, label: string, danger = false) =>
    `<form method="post" action="/dashboard/standup/${s.id}/roster" class="inline-form">
       <input type="hidden" name="userName" value="${esc(p.userName)}">
       <button class="btn ghost${danger ? ' danger' : ''}" name="action" value="${action}" type="submit">${label}</button>
     </form>`;
  const participants = roster
    .map(
      (p) =>
        `<li>${esc(p.displayName)}${p.mandatory ? '' : ' <span class="tag">optional</span>'}${p.timezone ? ` <span class="tag">${esc(p.timezone)}</span>` : ''}${p.onVacation ? ' 🏖️' : ''}
          <span class="row-actions">
            ${rosterAction(p, p.mandatory ? 'optional' : 'mandatory', p.mandatory ? 'Make optional' : 'Make mandatory')}
            ${rosterAction(p, p.onVacation ? 'back' : 'vacation', p.onVacation ? 'Back' : 'Away')}
            ${rosterAction(p, 'admin', 'Make admin')}
            ${rosterAction(p, 'remove', 'Remove', true)}
          </span></li>`,
    )
    .join('');
  const adminRows = await repo.listAdmins(s.id);
  const admins = adminRows.length
    ? adminRows
        .map((a) => `${esc(a.displayName)} <span class="row-actions">${rosterAction(a, 'unadmin', 'Remove admin', true)}</span>`)
        .join(' · ')
    : '<i>none (open config)</i>';

  const runRows: string[] = [];
  for (const run of await repo.listRecentRuns(s.id, 14)) {
    const progress = runProgress(await repo.listRunParticipants(run.id), await repo.listSubmissions(run.id));
    runRows.push(`<tr>
        <td><a href="/dashboard/standup/${s.id}/run/${run.date}">${run.date}</a></td>
        <td>${run.status}</td>
        <td>${progress.submitted}/${progress.expected}</td>
        <td>${progress.missingMandatory.map((p) => esc(p.displayName)).join(', ') || '—'}</td>
      </tr>`);
  }

  const weekly = await weeklySeries(repo, s, now, 8);
  const trendRows = weekly
    .map((w) =>
      w.participationPct === null
        ? `<tr><td>${w.label}</td><td colspan="3">no runs</td></tr>`
        : `<tr><td>${w.label}</td><td>${w.participationPct}%</td><td>${
            w.mood !== null ? `${moodEmoji(w.mood)} ${w.mood}/5` : '—'
          }</td><td>${w.blockersOpened} / ${w.blockersResolved}</td></tr>`,
    )
    .join('');

  const blockers = (await repo.listOpenBlockers(s.id))
    .map((b) => `<li>⚠️ <b>${esc(b.displayName)}</b>: ${esc(b.text)} <small>(since ${b.openedDate}${b.escalatedAt ? ', escalated' : ''})</small></li>`)
    .join('');

  const check = (v: boolean) => (v ? 'checked' : '');
  const escalateSelect = `<label>Escalation contact
      <select name="escalateUserName">
        <option value="">— off —</option>
        ${roster
          .map(
            (p) =>
              `<option value="${esc(p.userName)}" ${p.userName === s.escalateUserName ? 'selected' : ''}>${esc(p.displayName)}</option>`,
          )
          .join('')}
      </select> <small class="muted">DMed when blockers stay open past the threshold</small></label>`;
  return `<p class="crumbs"><a href="/dashboard">← All standups</a></p>
  <h1>#${s.id} ${esc(s.name)}
    ${
      canRunNow
        ? `<form method="post" action="/dashboard/standup/${s.id}/run-now" class="inline-form" style="float:right">
             <button class="btn" type="submit">▶ Run now</button>
           </form>`
        : ''
    }
    <a class="btn ghost" style="float:right;margin-right:.5rem" href="/dashboard/standup/${s.id}/export.csv">⬇ CSV (90d)</a>
  </h1>
  ${saved ? '<div class="toast ok">✓ Saved</div>' : ''}
  ${notice ? `<div class="toast ok">${esc(notice)}</div>` : ''}
  ${error ? `<div class="toast err">⚠ ${esc(error)}</div>` : ''}
  <div class="cols">
  <form method="post" action="/dashboard/standup/${s.id}" class="card">
    <div class="kicker">Configuration</div>
    <label>Name <input name="name" value="${esc(s.name)}"></label>
    <label>Prompt time <input name="promptTime" value="${esc(s.promptTime)}"> <small class="muted">participant-local</small></label>
    <label>Deadline <input name="deadlineTime" value="${esc(s.deadlineTime)}"></label>
    <label>Timezone <input name="timezone" value="${esc(s.timezone)}"></label>
    <label>Days <input name="days" value="${esc(s.days)}"></label>
    <label>Reminder (min before) <input name="reminderMinutesBefore" value="${s.reminderMinutesBefore}"></label>
    <label>Escalate after (days) <input name="escalateAfterDays" value="${s.escalateAfterDays}"></label>
    ${escalateSelect}
    <label>Webhook URL <input name="webhookUrl" value="${esc(s.webhookUrl ?? '')}" placeholder="https://… (optional)"> <small class="muted">JSON POST on each submission and wrap-up</small></label>
    ${
      s.webhookUrl && webhookSecret?.(s.id)
        ? `<p class="reveal">Deliveries carry <code>X-AsyncUp-Signature: sha256=HMAC_SHA256(body, secret)</code> — signing secret:
           <code>${esc(webhookSecret(s.id))}</code></p>`
        : ''
    }
    <label>Questions (one per line)<textarea name="questions" rows="4">${esc(standupQuestions(s).join('\n'))}</textarea></label>
    <label class="inline"><input type="checkbox" name="moodEnabled" ${check(s.moodEnabled)}> Mood question</label>
    <label class="inline"><input type="checkbox" name="moodAnonymous" ${check(s.moodAnonymous)}> Anonymous mood</label>
    <label class="inline"><input type="checkbox" name="digestEnabled" ${check(s.digestEnabled)}> Weekly digest</label>
    <button class="btn" type="submit">Save</button>
    <p><small class="muted">Adding <em>new</em> people still happens in Google Chat (<code>add @user</code>) —
    the dashboard can only manage people whose Chat identity it already knows.</small></p>
  </form>
  <div>
    <section class="card">
      <div class="kicker">People</div>
      <ul>${participants || '<li><i>none yet</i></li>'}</ul>
      <p><b>Admins:</b> ${admins}</p>
    </section>
    <section class="card">
      <div class="kicker">Open blockers</div>
      <ul>${blockers || '<li>✅ none</li>'}</ul>
    </section>
    <section class="card">
      <div class="kicker">Trends · last 8 weeks</div>
      <h3 class="chart-title">Participation</h3>
      ${participationChart(weekly)}
      <h3 class="chart-title">Mood</h3>
      ${moodChart(weekly)}
      <h3 class="chart-title">Blockers</h3>
      ${blockersChart(weekly)}
      <details class="chart-data">
        <summary>Data table</summary>
        <table><tr><th>Week of</th><th>Participation</th><th>Mood</th><th>Blockers open/res.</th></tr>${trendRows}</table>
      </details>
    </section>
  </div>
  </div>
  <section class="card">
    <div class="kicker">History</div>
    <h2>Last 14 runs</h2>
    <table><tr><th>Date</th><th>Status</th><th>Submitted</th><th>Missing</th></tr>${runRows.join('') || '<tr><td colspan="4">no runs yet</td></tr>'}</table>
  </section>`;
}

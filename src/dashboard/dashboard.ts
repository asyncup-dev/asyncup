import express, { type Express, type Request, type Response } from 'express';
import { DateTime, IANAZone } from 'luxon';
import { generateToken, tokenEquals } from '../core/crypto.js';
import { moodEmoji } from '../core/insights.js';
import { blockersChart, moodChart, participationChart, weeklySeries } from './charts.js';
import type { AppSettings, SettingsService } from '../core/settings.js';
import {
  MOOD_EMOJI,
  standupQuestions,
  WEEKDAYS,
  type Standup,
  type Weekday,
} from '../core/types.js';
import type { Repo } from '../db/repo.js';
import { buildCsv } from '../core/export.js';

export interface DashboardDeps {
  repo: Repo;
  settings: SettingsService;
  /** Empty string disables the dashboard entirely. */
  token: string;
  now?: () => DateTime;
  /** Opens today's run immediately (scheduler.runNow); enables the button. */
  runNow?: (standup: Standup) => Promise<'started' | 'already_open' | 'already_closed' | 'no_participants'>;
  /** Per-standup webhook signing secret to show next to a configured URL. */
  webhookSecret?: (standupId: number) => string;
}

const COOKIE = 'asyncup_dash';
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function registerDashboard(app: Express, deps: DashboardDeps): void {
  if (!deps.token) return;
  const { repo, settings, token } = deps;
  const now = deps.now ?? (() => DateTime.utc());

  app.use('/dashboard', express.urlencoded({ extended: false }));

  const authed = (req: Request, res: Response): boolean => {
    if (tokenEquals(req.query.token, token)) {
      res.setHeader(
        'Set-Cookie',
        `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/dashboard`,
      );
      // Get the token out of the address bar (history, access logs, Referer):
      // the cookie now carries the session, so bounce to a clean URL. A fixed
      // destination — echoing any part of the request would be a redirect sink.
      if (req.method === 'GET') {
        res.redirect(303, '/dashboard');
        return false;
      }
      return true;
    }
    const cookie = req.headers.cookie
      ?.split(';')
      .map((c) => c.trim())
      .find((c) => c.startsWith(`${COOKIE}=`));
    if (cookie && tokenEquals(decodeURIComponent(cookie.slice(COOKIE.length + 1)), token)) return true;
    res.status(401).send(layout('Unauthorized', 'home', `<div class="card"><p>Open <code>/dashboard?token=…</code> with your DASHBOARD_TOKEN.</p></div>`));
    return false;
  };

  // ---------- home: checklist + standups ----------

  app.get('/dashboard', async (req, res) => {
    if (!authed(req, res)) return;
    const standups = await repo.listActiveStandups();
    const s = await settings.get();

    const unverifiedWarning = s.chatAudience
      ? ''
      : `<section class="card warn">
          <div class="kicker">Action needed</div>
          <h2>Google Chat events are being refused</h2>
          <p>Until the GCP project number is set in <a href="/dashboard/settings">Settings</a>, incoming
          Chat webhooks cannot be verified, so AsyncUp answers every event with a setup notice instead of
          processing it.</p>
        </section>`;

    const steps = [
      { done: !!(s.chatAudience && s.serviceAccountJson), label: 'Connect Google Chat', hint: 'Project number + service-account key in Settings', href: '/dashboard/settings' },
      { done: standups.length > 0, label: 'Create a standup', hint: 'Mention the bot in a space: <code>@AsyncUp setup</code>', href: null },
      { done: false, label: 'Add your team', hint: '<code>@AsyncUp add @Alice @Bob</code> in the space', href: null },
      { done: !!s.llmProvider, label: 'Optional: AI summaries', hint: 'Bring your own key in Settings', href: '/dashboard/settings' },
    ];
    // "Add your team" is done when any standup has participants.
    for (const st of standups) {
      if ((await repo.listParticipants(st.id)).length > 0) {
        steps[2]!.done = true;
        break;
      }
    }
    const doneCount = steps.filter((x) => x.done).length;
    const checklist =
      doneCount === steps.length
        ? ''
        : `<section class="card setup">
            <div class="kicker">First-run setup</div>
            <h2>Good morning. Let's get the standups flowing.</h2>
            <div class="meter" role="img" aria-label="${doneCount} of ${steps.length} steps done">
              ${steps.map((x, i) => `<span class="bar b${i + 1} ${x.done ? 'done' : ''}"></span>`).join('')}
              <span class="meter-label">${doneCount}/${steps.length}</span>
            </div>
            <ol class="steps">
              ${steps
                .map(
                  (x) => `<li class="${x.done ? 'done' : ''}">
                    <span class="tick">${x.done ? '✓' : ''}</span>
                    <div><b>${x.label}</b><small>${x.hint}</small></div>
                    ${x.href && !x.done ? `<a class="btn ghost" href="${x.href}">Open</a>` : ''}
                  </li>`,
                )
                .join('')}
            </ol>
          </section>`;

    const rows: string[] = [];
    for (const st of standups) {
      const today = now().setZone(st.timezone).toISODate()!;
      const run = await repo.getRun(st.id, today);
      const todayCell = run ? `${(await repo.listSubmissions(run.id)).length} submitted (${run.status})` : '—';
      rows.push(`<tr>
          <td><a href="/dashboard/standup/${st.id}">#${st.id} ${esc(st.name)}</a></td>
          <td>${esc(st.spaceName)}</td>
          <td>${esc(st.promptTime)} → ${esc(st.deadlineTime)} ${esc(st.timezone)}</td>
          <td>${(await repo.listParticipants(st.id)).length}</td>
          <td>${todayCell}</td>
        </tr>`);
    }
    res.send(
      layout(
        'AsyncUp dashboard',
        'home',
        `${unverifiedWarning}${checklist}
        <section class="card">
          <div class="kicker">Teams</div>
          <h2>Standups</h2>
          ${standups.length === 0 ? '<p class="muted">None yet — create one from Google Chat with <code>@AsyncUp setup</code>.</p>' : ''}
          ${standups.length ? `<table><tr><th>Standup</th><th>Space</th><th>Schedule</th><th>People</th><th>Today</th></tr>${rows.join('')}</table>` : ''}
        </section>`,
      ),
    );
  });

  // ---------- settings ----------

  app.get('/dashboard/settings', async (req, res) => {
    if (!authed(req, res)) return;
    res.send(
      layout(
        'Settings — AsyncUp',
        'settings',
        await settingsPage(await settings.get(), req.query.saved === '1', null, null),
      ),
    );
  });

  app.post('/dashboard/settings', async (req, res) => {
    if (!authed(req, res)) return;
    const body = req.body ?? {};

    if (typeof body.action === 'string') {
      const [verb, which] = body.action.split('-');
      const field = which === 'tick' ? 'tickToken' : which === 'export' ? 'exportToken' : null;
      if (field && verb === 'generate') {
        const fresh = generateToken();
        await settings.update({ [field]: fresh });
        res.send(
          layout('Settings — AsyncUp', 'settings', await settingsPage(await settings.get(), false, null, { field, value: fresh })),
        );
        return;
      }
      if (field && verb === 'clear') {
        await settings.update({ [field]: '' });
        res.redirect('/dashboard/settings?saved=1');
        return;
      }
      res.status(400).send(layout('Settings — AsyncUp', 'settings', await settingsPage(await settings.get(), false, 'Unknown action.', null)));
      return;
    }

    const error = await applySettings(settings, body);
    if (error) {
      res.status(400).send(layout('Settings — AsyncUp', 'settings', await settingsPage(await settings.get(), false, error, null)));
      return;
    }
    res.redirect('/dashboard/settings?saved=1');
  });

  // ---------- standup detail + config ----------

  app.get('/dashboard/standup/:id', async (req, res) => {
    if (!authed(req, res)) return;
    const standup = await repo.getStandupById(Number(req.params.id));
    if (!standup) {
      res.status(404).send(layout('Not found', 'home', '<div class="card"><p>Unknown standup.</p></div>'));
      return;
    }
    const notice = typeof req.query.notice === 'string' ? req.query.notice : null;
    res.send(
      layout(
        `${standup.name} — AsyncUp`,
        'home',
        await standupPage(repo, standup, now(), req.query.saved === '1', null, notice, !!deps.runNow, deps.webhookSecret),
      ),
    );
  });

  // Open today's run immediately — the "see it work" button.
  app.post('/dashboard/standup/:id/run-now', async (req, res) => {
    if (!authed(req, res)) return;
    const standup = await repo.getStandupById(Number(req.params.id));
    if (!standup || !deps.runNow) {
      res.status(404).send(layout('Not found', 'home', '<div class="card"><p>Unknown standup.</p></div>'));
      return;
    }
    const result = await deps.runNow(standup);
    const notices = {
      started: "Run opened — everyone eligible was just prompted.",
      already_open: "Today's run was already open — anyone not yet prompted was prompted.",
      already_closed: "Today's run already closed; the next opens on schedule.",
      no_participants: 'No one to prompt — add participants first.',
    };
    res.redirect(`/dashboard/standup/${standup.id}?notice=${encodeURIComponent(notices[result])}`);
  });

  // Roster management — everything here already has a Chat identity on file.
  app.post('/dashboard/standup/:id/roster', async (req, res) => {
    if (!authed(req, res)) return;
    const standup = await repo.getStandupById(Number(req.params.id));
    if (!standup) {
      res.status(404).send(layout('Not found', 'home', '<div class="card"><p>Unknown standup.</p></div>'));
      return;
    }
    const userName = String(req.body?.userName ?? '');
    const action = String(req.body?.action ?? '');
    let notice: string;
    if (action === 'remove') {
      notice = (await repo.removeParticipant(standup.id, userName)) ? 'Participant removed.' : 'Not a participant.';
    } else if (action === 'mandatory' || action === 'optional') {
      await repo.setParticipantMandatory(standup.id, userName, action === 'mandatory');
      notice = `Marked ${action}.`;
    } else if (action === 'vacation' || action === 'back') {
      await repo.setParticipantVacation(standup.id, userName, action === 'vacation');
      notice = action === 'vacation' ? 'Marked away.' : 'Marked back.';
    } else if (action === 'unadmin') {
      const admins = await repo.listAdmins(standup.id);
      if (admins.length === 1 && admins[0]!.userName === userName) {
        notice = 'A standup must keep at least one admin.';
      } else {
        await repo.removeAdmin(standup.id, userName);
        notice = 'Admin removed.';
      }
    } else if (action === 'admin') {
      const p = (await repo.listParticipants(standup.id)).find((x) => x.userName === userName);
      if (p) {
        await repo.addAdmin(standup.id, p.userName, p.displayName);
        notice = 'Admin added.';
      } else notice = 'Not a participant.';
    } else {
      res.status(400).send(layout('Bad request', 'home', '<div class="card"><p>Unknown roster action.</p></div>'));
      return;
    }
    res.redirect(`/dashboard/standup/${standup.id}?notice=${encodeURIComponent(notice)}`);
  });

  // CSV for one standup via the dashboard session (no bearer token juggling).
  app.get('/dashboard/standup/:id/export.csv', async (req, res) => {
    if (!authed(req, res)) return;
    const standup = await repo.getStandupById(Number(req.params.id));
    if (!standup) {
      res.status(404).send(layout('Not found', 'home', '<div class="card"><p>Unknown standup.</p></div>'));
      return;
    }
    const days = Math.min(Math.max(Number(req.query.days) || 90, 1), 365);
    const today = now().setZone(standup.timezone);
    const csv = await buildCsv(repo, standup, today.minus({ days }).toISODate()!, today.toISODate()!);
    res
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="standup-${standup.id}-last-${days}d.csv"`)
      .send(csv);
  });

  app.post('/dashboard/standup/:id', async (req, res) => {
    if (!authed(req, res)) return;
    const standup = await repo.getStandupById(Number(req.params.id));
    if (!standup) {
      res.status(404).send(layout('Not found', 'home', '<div class="card"><p>Unknown standup.</p></div>'));
      return;
    }
    const error = await applyConfig(repo, standup, req.body);
    if (error) {
      res.status(400).send(layout(`${standup.name} — AsyncUp`, 'home', await standupPage(repo, (await repo.getStandupById(standup.id))!, now(), false, error, null, !!deps.runNow, deps.webhookSecret)));
      return;
    }
    res.redirect(`/dashboard/standup/${standup.id}?saved=1`);
  });

  app.get('/dashboard/standup/:id/run/:date', async (req, res) => {
    if (!authed(req, res)) return;
    const standup = await repo.getStandupById(Number(req.params.id));
    const run = standup ? await repo.getRun(standup.id, String(req.params.date)) : null;
    if (!standup || !run) {
      res.status(404).send(layout('Not found', 'home', '<div class="card"><p>Unknown run.</p></div>'));
      return;
    }
    const submissions = (await repo.listSubmissions(run.id))
      .map(
        (s) => `<div class="card sub">
          <h3>${s.mood && !standup.moodAnonymous ? MOOD_EMOJI[s.mood] : '📝'} ${esc(s.displayName)}
            ${s.late ? '<span class="tag">late</span>' : ''}${s.editedAt ? '<span class="tag">edited</span>' : ''}</h3>
          ${s.answers.map((a) => `<p><b>${esc(a.question)}</b><br>${esc(a.answer)}</p>`).join('')}
        </div>`,
      )
      .join('');
    const roster = await repo.listRunParticipants(run.id);
    const submitted = new Set((await repo.listSubmissions(run.id)).map((s) => s.userName));
    const missing = roster
      .filter((p) => p.mandatory && !submitted.has(p.userName) && !p.skippedAt && !p.onVacation)
      .map((p) => esc(p.displayName));
    res.send(
      layout(
        `${run.date} — ${standup.name}`,
        'home',
        `<p class="crumbs"><a href="/dashboard/standup/${standup.id}">← ${esc(standup.name)}</a></p>
        <h1>${run.date} <small>(${run.status})</small></h1>
        ${missing.length ? `<p>❌ Missing: ${missing.join(', ')}</p>` : ''}
        ${submissions || '<div class="card"><p class="muted">No submissions.</p></div>'}`,
      ),
    );
  });
}

// ---------- settings rendering ----------

async function applySettings(settings: SettingsService, body: any): Promise<string | null> {
  const section = String(body.section ?? '');

  if (section === 'chat') {
    const chatAudience = String(body.chatAudience ?? '').trim();
    // Accepts the GCP project number and/or the app URL (Chat API "Audience"
    // can be either) — space/comma separated. Reject obvious mistakes like
    // the project ID slug or org ID being pasted as the only value.
    const auds = chatAudience.split(/[\s,]+/).filter(Boolean);
    const bad = auds.find((a) => !/^\d+$/.test(a) && !/^https:\/\/\S+$/i.test(a));
    if (bad) {
      return `"${bad}" isn't a GCP project number or an https app URL. Use the project number (digits) or the Chat app's HTTP endpoint URL — not the project ID slug or org ID.`;
    }
    const json = String(body.serviceAccountJson ?? '').trim();
    if (json) {
      try {
        const parsed = JSON.parse(json);
        if (!parsed.client_email || !parsed.private_key) {
          return 'That JSON is missing client_email / private_key — paste the full service-account key file.';
        }
      } catch {
        return 'The service-account key must be valid JSON — paste the whole downloaded file.';
      }
    }
    await settings.update({ chatAudience, ...(json ? { serviceAccountJson: json } : {}) });
    if (body.clear_serviceAccountJson === 'on') await settings.update({ serviceAccountJson: '' });
    return null;
  }

  if (section === 'ai') {
    const llmProvider = String(body.llmProvider ?? '');
    if (!['', 'anthropic', 'openai'].includes(llmProvider)) return 'Unknown AI provider.';
    const llmModel = String(body.llmModel ?? '').trim();
    if (llmProvider === 'openai' && !llmModel && !body.llmApiKey) {
      // model checked properly below once we know a key exists
    }
    const key = String(body.llmApiKey ?? '').trim();
    if (llmProvider === 'openai' && !llmModel) return 'OpenAI needs an explicit model name.';
    await settings.update({
      llmProvider: llmProvider as AppSettings['llmProvider'],
      llmModel,
      ...(key ? { llmApiKey: key } : {}),
    });
    if (body.clear_llmApiKey === 'on') await settings.update({ llmApiKey: '' });
    return null;
  }

  if (section === 'workspace') {
    const tz = String(body.defaultTimezone ?? '').trim();
    if (!IANAZone.isValidZone(tz)) return `Invalid IANA timezone: ${tz || '(empty)'} — e.g. Asia/Kolkata.`;
    const adminEmail = String(body.workspaceAdminEmail ?? '').trim();
    // Shape check without a backtracking regex (CodeQL: polynomial ReDoS).
    const at = adminEmail.indexOf('@');
    const dot = adminEmail.lastIndexOf('.');
    if (adminEmail && (at < 1 || at !== adminEmail.lastIndexOf('@') || dot < at + 2 || dot === adminEmail.length - 1 || /\s/.test(adminEmail))) {
      return `"${adminEmail}" doesn't look like an email address.`;
    }
    await settings.update({
      defaultTimezone: tz,
      calendarOoo: body.calendarOoo === 'on',
      workspaceAdminEmail: adminEmail,
    });
    return null;
  }

  return 'Unknown settings section.';
}

function secretStatus(value: string, describe?: (v: string) => string): string {
  if (!value) return '<span class="chip off">Not set</span>';
  const detail = describe ? describe(value) : `ends in <code>${esc(value.slice(-4))}</code>`;
  return `<span class="chip on">Configured</span> <small class="muted">${detail}</small>`;
}

async function settingsPage(
  s: AppSettings,
  saved: boolean,
  error: string | null,
  revealed: { field: string; value: string } | null,
): Promise<string> {
  const saJsonStatus = secretStatus(s.serviceAccountJson, (v) => {
    try {
      return `key for <code>${esc(JSON.parse(v).client_email ?? 'unknown')}</code>`;
    } catch {
      return 'stored';
    }
  });

  const tokenRow = (field: 'tickToken' | 'exportToken', title: string, hint: string) => {
    const value = s[field];
    const which = field === 'tickToken' ? 'tick' : 'export';
    const reveal =
      revealed?.field === field
        ? `<div class="reveal">New token (copy now — it won't be shown again):<code>${esc(revealed.value)}</code></div>`
        : '';
    return `<div class="token-row">
      <div><b>${title}</b><small class="muted">${hint}</small><div>${secretStatus(value)}</div>${reveal}</div>
      <div class="token-actions">
        <form method="post" action="/dashboard/settings"><button class="btn ghost" name="action" value="generate-${which}">↻ Generate</button></form>
        ${value ? `<form method="post" action="/dashboard/settings"><button class="btn ghost danger" name="action" value="clear-${which}">Clear</button></form>` : ''}
      </div>
    </div>`;
  };

  return `
  <div class="kicker">Configuration</div>
  <h1>Settings</h1>
  <p class="muted">Stored in your database; secrets are encrypted with your <code>SECRET_KEY</code>. Changes apply immediately — no restart.</p>
  ${saved ? '<div class="toast ok">✓ Saved</div>' : ''}
  ${error ? `<div class="toast err">⚠ ${esc(error)}</div>` : ''}

  <form method="post" action="/dashboard/settings" class="card">
    <input type="hidden" name="section" value="chat">
    <div class="kicker">01 · Google Chat</div>
    <h2>Workspace connection</h2>
    <label>Audience — GCP project <em>number</em> (or app URL)
      <input name="chatAudience" value="${esc(s.chatAudience)}" placeholder="e.g. 819177304171">
      <small class="muted">Verifies webhook calls come from Google Chat. Use the project <b>number</b> (digits, from
      Cloud overview → Project info — <em>not</em> the project ID or org ID). If your Chat API "Audience" is set to
      the App URL instead, paste that URL; you can enter both, space-separated.</small>
    </label>
    <label>Service-account key (JSON)
      <textarea name="serviceAccountJson" rows="4" placeholder='${s.serviceAccountJson ? 'Paste a new key to replace the stored one' : '{ "type": "service_account", … } — paste the downloaded key file'}'></textarea>
      <small>${saJsonStatus}${s.serviceAccountJson ? ' · <label class="inline"><input type="checkbox" name="clear_serviceAccountJson"> clear stored key (use ADC)</label>' : ' · <span class="muted">empty = Application Default Credentials</span>'}</small>
    </label>
    <button class="btn" type="submit">Save connection</button>
  </form>

  <form method="post" action="/dashboard/settings" class="card">
    <input type="hidden" name="section" value="ai">
    <div class="kicker">02 · AI summaries</div>
    <h2>Bring your own key</h2>
    <label>Provider
      <select name="llmProvider">
        <option value="" ${s.llmProvider === '' ? 'selected' : ''}>Off</option>
        <option value="anthropic" ${s.llmProvider === 'anthropic' ? 'selected' : ''}>Anthropic</option>
        <option value="openai" ${s.llmProvider === 'openai' ? 'selected' : ''}>OpenAI</option>
      </select>
    </label>
    <label>API key
      <input name="llmApiKey" type="password" placeholder="${s.llmApiKey ? 'Enter a new key to replace the stored one' : 'sk-…'}" autocomplete="off">
      <small>${secretStatus(s.llmApiKey)}${s.llmApiKey ? ' · <label class="inline"><input type="checkbox" name="clear_llmApiKey"> clear</label>' : ''}</small>
    </label>
    <label>Model
      <input name="llmModel" value="${esc(s.llmModel)}" placeholder="anthropic default: claude-opus-4-7">
    </label>
    <small class="muted">Then enable per standup with <code>@AsyncUp ai on</code>.</small>
    <button class="btn" type="submit">Save AI settings</button>
  </form>

  <form method="post" action="/dashboard/settings" class="card">
    <input type="hidden" name="section" value="workspace">
    <div class="kicker">03 · Workspace</div>
    <h2>Defaults &amp; integrations</h2>
    <label>Default timezone for new standups
      <input name="defaultTimezone" value="${esc(s.defaultTimezone)}" placeholder="Asia/Kolkata">
    </label>
    <label class="inline big"><input type="checkbox" name="calendarOoo" ${s.calendarOoo ? 'checked' : ''}>
      Google Calendar OOO sync <small class="muted">auto-mark people away on out-of-office days (needs the service-account key + domain-wide delegation)</small>
    </label>
    <label>Workspace admin email
      <input name="workspaceAdminEmail" value="${esc(s.workspaceAdminEmail)}" placeholder="admin@yourdomain.com (optional)">
      <small class="muted">Enables Directory API lookups (impersonated for reads; needs the
      <code>admin.directory.user.readonly</code> scope in domain-wide delegation). With it, Calendar OOO works
      for people who never interacted with the bot.</small>
    </label>
    <button class="btn" type="submit">Save workspace</button>
  </form>

  <section class="card">
    <div class="kicker">04 · Access tokens</div>
    <h2>Machine endpoints</h2>
    ${tokenRow('tickToken', 'Scheduler tick token', 'Authorizes POST /tick for external cron (scale-to-zero deploys).')}
    ${tokenRow('exportToken', 'CSV export token', 'Enables GET /export. Endpoint stays off until a token exists.')}
  </section>`;
}

// ---------- standup pages (unchanged behavior, restyled) ----------

async function applyConfig(repo: Repo, standup: Standup, body: any): Promise<string | null> {
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

  const webhookUrl = String(body.webhookUrl ?? '').trim();
  if (webhookUrl && !/^https:\/\/\S+$/i.test(webhookUrl)) return 'Webhook URL must be https:// (or empty to disable).';

  const questionLines = String(body.questions ?? '')
    .split('\n')
    .map((q: string) => q.trim())
    .filter(Boolean);
  if (questionLines.length === 0 || questionLines.length > 10) return 'Provide 1–10 questions (one per line).';
  if (questionLines.some((q: string) => q.length > 200)) return 'Questions must be ≤200 characters.';

  // Escalation contact: picked from the roster (they have Chat identities).
  const escalateUserName = String(body.escalateUserName ?? '');
  let escalate: { escalateUserName: string | null; escalateDisplayName: string | null } | null = null;
  if (escalateUserName === '') {
    escalate = { escalateUserName: null, escalateDisplayName: null };
  } else {
    const contact = (await repo.listParticipants(standup.id)).find((p) => p.userName === escalateUserName);
    if (!contact) return 'Escalation contact must be a current participant.';
    escalate = { escalateUserName: contact.userName, escalateDisplayName: contact.displayName };
  }

  await repo.updateStandup(standup.id, {
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
    webhookUrl: webhookUrl || null,
    ...escalate,
  });
  return null;
}

async function standupPage(
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
    const roster = await repo.listRunParticipants(run.id);
    const submitted = new Set((await repo.listSubmissions(run.id)).map((x) => x.userName));
    const away = roster.filter((p) => !submitted.has(p.userName) && (p.skippedAt || p.onVacation));
    const missing = roster.filter(
      (p) => p.mandatory && !submitted.has(p.userName) && !p.skippedAt && !p.onVacation,
    );
    runRows.push(`<tr>
        <td><a href="/dashboard/standup/${s.id}/run/${run.date}">${run.date}</a></td>
        <td>${run.status}</td>
        <td>${submitted.size}/${roster.length - away.length}</td>
        <td>${missing.map((p) => esc(p.displayName)).join(', ') || '—'}</td>
      </tr>`);
  }

  const weekly = await weeklySeries(repo, s, now);
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
    <label class="inline"><input type="checkbox" name="aiEnabled" ${check(s.aiEnabled)}> AI summaries</label>
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

// ---------- chrome ----------

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const LOGO_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="28" height="28"><g fill="#fff" opacity=".96"><rect x="24" y="28" width="208" height="168" rx="52"/><path d="M86 188 L60 236 Q54 247 68 240 L132 196 Z"/></g><rect x="66" y="120" width="30" height="44" rx="15" fill="#FFD27D"/><rect x="113" y="92" width="30" height="72" rx="15" fill="#FFAE52"/><rect x="160" y="64" width="30" height="100" rx="15" fill="#FF8A3D"/></svg>';

function layout(title: string, active: 'home' | 'settings', body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root{
    --ink:#15435f; --ink-deep:#0c2c40; --ink-faint:rgba(21,67,95,.14);
    --amber:#ff8a3d; --amber-soft:#ffae52; --amber-pale:#ffd27d;
    --paper:#faf6ef; --card:#fffdf9; --text:#22323d; --muted:#68798a;
    --serif:'Iowan Old Style','Palatino Linotype',Palatino,Georgia,serif;
    --sans:'Avenir Next',Avenir,Seravek,'Segoe UI Variable Text','Segoe UI',Verdana,sans-serif;
    --mono:ui-monospace,'SF Mono',Menlo,Consolas,monospace;
  }
  *{box-sizing:border-box}
  body{
    margin:0;color:var(--text);font:15px/1.55 var(--sans);
    background:
      radial-gradient(1100px 360px at 50% -180px, rgba(255,174,82,.22), transparent 70%),
      radial-gradient(900px 300px at 85% -120px, rgba(21,67,95,.10), transparent 70%),
      var(--paper);
    min-height:100vh;
  }
  header{
    background:linear-gradient(180deg,var(--ink) 0%,var(--ink-deep) 100%);
    border-bottom:3px solid var(--amber);
  }
  .bar{max-width:1020px;margin:0 auto;padding:.85rem 1.2rem;display:flex;align-items:center;gap:.7rem}
  .bar .word{font-family:var(--serif);font-size:1.25rem;color:#fff;letter-spacing:.01em;text-decoration:none}
  .bar .word em{font-style:normal;color:var(--amber-soft)}
  nav{margin-left:auto;display:flex;gap:.4rem}
  nav a{color:rgba(255,255,255,.85);text-decoration:none;padding:.35rem .8rem;border-radius:999px;font-size:.92rem}
  nav a:hover{background:rgba(255,255,255,.12)}
  nav a.active{background:var(--amber);color:#3b2204;font-weight:600}
  main{max-width:1020px;margin:1.6rem auto 4rem;padding:0 1.2rem}
  h1{font-family:var(--serif);font-weight:600;font-size:1.9rem;margin:.2rem 0 1rem;color:var(--ink-deep)}
  h1 small{color:var(--muted);font-family:var(--sans);font-size:.95rem}
  h2{font-family:var(--serif);font-weight:600;font-size:1.25rem;margin:.1rem 0 .8rem;color:var(--ink-deep)}
  .kicker{font-size:.72rem;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--amber);margin-bottom:.15rem}
  .muted{color:var(--muted)} .crumbs{margin:.2rem 0 .6rem}
  a{color:#176d94}
  .card{
    background:var(--card);border:1px solid var(--ink-faint);border-radius:12px;
    padding:1.1rem 1.3rem 1.2rem;margin:0 0 1.1rem;box-shadow:0 1px 2px rgba(21,67,95,.05),0 10px 30px -18px rgba(21,67,95,.25);
    animation:rise .45s ease both;
  }
  .card:nth-of-type(2){animation-delay:.06s}.card:nth-of-type(3){animation-delay:.12s}.card:nth-of-type(4){animation-delay:.18s}
  @keyframes rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
  @media (prefers-reduced-motion: reduce){.card{animation:none}}
  table{border-collapse:collapse;width:100%;margin:.5rem 0;font-size:.93rem}
  th,td{border-bottom:1px solid var(--ink-faint);padding:.45rem .6rem;text-align:left}
  th{font-size:.72rem;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);font-weight:700}
  tr:hover td{background:rgba(255,174,82,.06)}
  label{display:block;margin:.6rem 0;font-weight:600;font-size:.92rem}
  label small{font-weight:400}
  label.inline{display:flex;gap:.5rem;align-items:baseline;font-weight:500}
  label.inline.big{margin:.9rem 0}
  input,textarea,select{
    width:100%;max-width:380px;padding:.45rem .6rem;font:inherit;margin-top:.25rem;
    border:1px solid var(--ink-faint);border-radius:8px;background:#fff;color:var(--text);
  }
  textarea{max-width:100%;font-family:var(--mono);font-size:.82rem}
  input[type=checkbox]{width:auto;accent-color:var(--amber)}
  input:focus,textarea:focus,select:focus{outline:2px solid var(--amber-soft);outline-offset:1px;border-color:var(--amber)}
  .btn{
    display:inline-block;margin-top:.7rem;padding:.5rem 1.5rem;font:inherit;font-weight:700;
    background:var(--amber);color:#3b2204;border:0;border-radius:999px;cursor:pointer;
    transition:transform .15s,background .15s;text-decoration:none;
  }
  .btn:hover{background:var(--amber-soft);transform:translateY(-1px)}
  .btn.ghost{background:transparent;border:1.5px solid var(--ink-faint);color:var(--ink);padding:.35rem 1rem;font-weight:600}
  .btn.ghost:hover{border-color:var(--amber);background:rgba(255,174,82,.08)}
  .btn.ghost.danger{color:#a33a17}
  .inline-form{display:inline}
  .inline-form .btn{margin-top:0;padding:.15rem .6rem;font-size:.78rem}
  .row-actions{margin-left:.5rem;opacity:.35;transition:opacity .15s}
  li:hover .row-actions,h1:hover .row-actions{opacity:1}
  .chart-title{font-family:var(--sans);font-size:.78rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin:.9rem 0 .3rem}
  .chart-title:first-of-type{margin-top:.2rem}
  .chart-data{margin-top:.6rem}
  .chart-data summary{cursor:pointer;font-size:.85rem;color:var(--muted)}
  .card.warn{border-color:#f3cfc2;background:#fdf3ef}
  .card.warn .kicker{color:#a33a17}
  .toast{border-radius:10px;padding:.6rem 1rem;margin:.4rem 0 1rem;font-weight:600;animation:rise .3s ease both}
  .toast.ok{background:#e8f5ec;color:#176a37;border:1px solid #bfe3cb}
  .toast.err{background:#fdeeea;color:#a33a17;border:1px solid #f3cfc2}
  .tag{background:rgba(21,67,95,.08);border-radius:4px;padding:.05rem .4rem;font-size:.78rem;margin-left:.3rem}
  .chip{font-size:.75rem;font-weight:700;border-radius:999px;padding:.12rem .6rem}
  .chip.on{background:#e8f5ec;color:#176a37}.chip.off{background:rgba(21,67,95,.08);color:var(--muted)}
  .cols{display:grid;grid-template-columns:1.1fr .9fr;gap:1.1rem}
  @media(max-width:760px){.cols{grid-template-columns:1fr}}
  .sub h3{margin:.1rem 0 .5rem}
  .token-row{display:flex;justify-content:space-between;gap:1rem;align-items:flex-start;padding:.8rem 0;border-bottom:1px solid var(--ink-faint)}
  .token-row:last-child{border-bottom:none}
  .token-row small{display:block;margin:.1rem 0 .35rem}
  .token-actions{display:flex;gap:.5rem;flex-shrink:0}
  .reveal{margin-top:.5rem;background:#fff7ea;border:1px dashed var(--amber);border-radius:8px;padding:.5rem .8rem;font-size:.85rem}
  .reveal code{display:block;font-family:var(--mono);font-size:.85rem;margin-top:.25rem;word-break:break-all}
  /* setup checklist — the logo's ascending bars as a progress meter */
  .setup h2{font-size:1.45rem}
  .meter{display:flex;align-items:flex-end;gap:6px;height:44px;margin:.4rem 0 1rem}
  .meter .bar{width:13px;border-radius:7px;background:rgba(21,67,95,.12);transition:background .3s}
  .meter .b1{height:16px}.meter .b2{height:25px}.meter .b3{height:34px}.meter .b4{height:43px}
  .meter .bar.done{background:linear-gradient(180deg,var(--amber-pale),var(--amber))}
  .meter-label{align-self:center;margin-left:.5rem;font-family:var(--serif);font-size:1.05rem;color:var(--ink)}
  .steps{list-style:none;margin:0;padding:0}
  .steps li{display:flex;gap:.8rem;align-items:center;padding:.55rem 0;border-bottom:1px dashed var(--ink-faint)}
  .steps li:last-child{border-bottom:none}
  .steps li.done{opacity:.55}
  .steps .tick{
    flex:none;width:26px;height:26px;border-radius:8px;display:flex;align-items:center;justify-content:center;
    border:1.5px solid var(--ink-faint);color:#176a37;font-weight:800;background:#fff;
  }
  .steps li.done .tick{background:#e8f5ec;border-color:#bfe3cb}
  .steps li div{flex:1} .steps small{display:block;color:var(--muted)}
</style></head><body>
<header><div class="bar">
  ${LOGO_SVG}
  <a class="word" href="/dashboard">Async<em>Up</em></a>
  <nav>
    <a href="/dashboard" class="${active === 'home' ? 'active' : ''}">Standups</a>
    <a href="/dashboard/settings" class="${active === 'settings' ? 'active' : ''}">Settings</a>
  </nav>
</div></header>
<main>${body}</main>
</body></html>`;
}

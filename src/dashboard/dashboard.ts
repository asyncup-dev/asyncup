import express, { type Express, type Request, type Response } from 'express';
import { DateTime } from 'luxon';
import { sessionFrom } from '../auth/session.js';
import { generateToken, tokenEquals } from '../core/crypto.js';
import { buildCsv } from '../core/export.js';
import { readCookie } from '../core/http.js';
import { runProgress } from '../core/progress.js';
import { MOOD_EMOJI, type Standup } from '../core/types.js';
import { clampExportDays } from '../core/validation.js';
import type { Repo } from '../db/repo.js';
import { esc, layout, notFound, signInCard } from './chrome.js';
import { applySettings, settingsPage } from './settings-page.js';
import { registerSetup } from './setup.js';
import { applyConfig, standupPage } from './standup-page.js';
import type { SettingsService } from '../core/settings.js';

export { esc, layout } from './chrome.js';

export interface DashboardDeps {
  repo: Repo;
  settings: SettingsService;
  /** Operator break-glass token; empty disables token access (sessions still work). */
  token: string;
  now?: () => DateTime;
  /** Opens today's run immediately (scheduler.runNow); enables the button. */
  runNow?: (standup: Standup) => Promise<'started' | 'already_open' | 'already_closed' | 'no_participants'>;
  /** Per-standup webhook signing secret to show next to a configured URL. */
  webhookSecret?: (standupId: number) => string;
  /** Verifies Google session cookies; empty disables session-based access. */
  secretKey?: string;
  /** Whether Google sign-in is configured (renders the login button). */
  signInEnabled?: () => Promise<boolean>;
  /** Whether SAML sign-in is configured (renders the SSO button). */
  samlEnabled?: () => Promise<boolean>;
}

const COOKIE = 'asyncup_dash';

export function registerDashboard(app: Express, deps: DashboardDeps): void {
  // The dashboard needs at least one way in: the operator token or admin
  // sessions (Google/SAML sign-in). With neither, it stays unregistered.
  if (!deps.token && !deps.secretKey) return;
  const { repo, settings, token } = deps;
  const now = deps.now ?? (() => DateTime.utc());

  app.use('/dashboard', express.urlencoded({ extended: false }));

  const authed = async (req: Request, res: Response): Promise<boolean> => {
    // Google/SAML session: Workspace admins get the full dashboard.
    const session = deps.secretKey ? sessionFrom(req, deps.secretKey) : null;
    if (session?.admin) return true;
    if (session) {
      // Signed in but not a Workspace admin — their place is the user console.
      if (req.method === 'GET') res.redirect(303, '/me');
      else res.status(403).send('Admins only.');
      return false;
    }
    // The operator token only counts while token sign-in is enabled; once
    // switched off in settings, recovery is a DB edit (documented there).
    const tokenOn = (await settings.get()).tokenSignIn;
    if (token && tokenOn && tokenEquals(req.query.token, token)) {
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
    const cookie = readCookie(req, COOKIE);
    if (token && tokenOn && cookie && tokenEquals(decodeURIComponent(cookie), token)) return true;
    const google = !!(deps.secretKey && (await deps.signInEnabled?.()));
    const saml = !!(deps.secretKey && (await deps.samlEnabled?.()));
    const tokenForm = !!(token && tokenOn);
    res.status(401).send(
      layout(
        'Sign in — AsyncUp',
        'home',
        signInCard({
          kicker: 'Admin console',
          heading: 'Sign in',
          google,
          saml,
          tokenForm,
          footnotes:
            google || saml
              ? ['Workspace admins only — everyone else lands on their own <code>/me</code> page.']
              : tokenForm
                ? ['The token is the DASHBOARD_TOKEN from the server environment.']
                : ["Token sign-in is switched off and no other method is configured. Re-enable it in the database: <code>DELETE FROM settings WHERE key='tokenSignIn'</code>, then restart the app."],
        }),
      ),
    );
    return false;
  };

  registerSetup(app, { settings, authed, hasToken: !!token });

  // ---------- home: checklist + standups ----------

  app.get('/dashboard', async (req, res) => {
    if (!(await authed(req, res))) return;
    const standups = await repo.listActiveStandups();
    const s = await settings.get();

    // Fresh install: hand over to the walkthrough until it finishes (or the
    // Chat connection exists — existing installs never see the wizard).
    if (!s.setupComplete && !(s.chatAudience && s.serviceAccountJson)) {
      res.redirect(303, '/dashboard/setup');
      return;
    }

    const unverifiedWarning = s.chatAudience
      ? ''
      : `<section class="card warn">
          <div class="kicker">Action needed</div>
          <h2>Google Chat events are being refused</h2>
          <p>Until the GCP project number is set in <a href="/dashboard/settings">Settings</a>, incoming
          Chat webhooks cannot be verified, so AsyncUp answers every event with a setup notice instead of
          processing it.</p>
        </section>`;

    // One roster fetch per standup, reused by the checklist and the table.
    const rosterSizes = new Map<number, number>();
    for (const st of standups) {
      rosterSizes.set(st.id, (await repo.listParticipants(st.id)).length);
    }

    const steps = [
      { done: !!(s.chatAudience && s.serviceAccountJson), label: 'Connect Google Chat', hint: 'Project number + service-account key in Settings', href: '/dashboard/settings' },
      { done: standups.length > 0, label: 'Create a standup', hint: 'Mention the bot in a space: <code>@AsyncUp setup</code>', href: null },
      { done: [...rosterSizes.values()].some((n) => n > 0), label: 'Add your team', hint: '<code>@AsyncUp add @Alice @Bob</code> in the space', href: null },
    ];
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
      let todayCell = '—';
      if (run) {
        const progress = runProgress(await repo.listRunParticipants(run.id), await repo.listSubmissions(run.id));
        todayCell = `${progress.submitted}/${progress.expected} submitted (${run.status})`;
      }
      rows.push(`<tr>
          <td><a href="/dashboard/standup/${st.id}">#${st.id} ${esc(st.name)}</a></td>
          <td>${esc(st.spaceName)}</td>
          <td>${esc(st.promptTime)} → ${esc(st.deadlineTime)} ${esc(st.timezone)}</td>
          <td>${rosterSizes.get(st.id)}</td>
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
    if (!(await authed(req, res))) return;
    res.send(
      layout(
        'Settings — AsyncUp',
        'settings',
        await settingsPage(await settings.get(), req.query.saved === '1', null, null),
      ),
    );
  });

  app.post('/dashboard/settings', async (req, res) => {
    if (!(await authed(req, res))) return;
    const body = req.body ?? {};

    if (typeof body.action === 'string') {
      const [verb, which] = body.action.split('-');
      const field =
        which === 'tick' ? 'tickToken' : which === 'export' ? 'exportToken' : which === 'scim' ? 'scimToken' : null;
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
    if (!(await authed(req, res))) return;
    const standup = await repo.getStandupById(Number(req.params.id));
    if (!standup) return notFound(res, 'Unknown standup.');
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
    if (!(await authed(req, res))) return;
    const standup = await repo.getStandupById(Number(req.params.id));
    if (!standup || !deps.runNow) return notFound(res, 'Unknown standup.');
    const result = await deps.runNow(standup);
    const notices = {
      started: 'Run opened — everyone eligible was just prompted.',
      already_open: "Today's run was already open — anyone not yet prompted was prompted.",
      already_closed: "Today's run already closed; the next opens on schedule.",
      no_participants: 'No one to prompt — add participants first.',
    };
    res.redirect(`/dashboard/standup/${standup.id}?notice=${encodeURIComponent(notices[result])}`);
  });

  // Roster management — everything here already has a Chat identity on file.
  app.post('/dashboard/standup/:id/roster', async (req, res) => {
    if (!(await authed(req, res))) return;
    const standup = await repo.getStandupById(Number(req.params.id));
    if (!standup) return notFound(res, 'Unknown standup.');
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
    if (!(await authed(req, res))) return;
    const standup = await repo.getStandupById(Number(req.params.id));
    if (!standup) return notFound(res, 'Unknown standup.');
    const days = clampExportDays(req.query.days, 90);
    const today = now().setZone(standup.timezone);
    const csv = await buildCsv(repo, standup, today.minus({ days }).toISODate()!, today.toISODate()!);
    res
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="standup-${standup.id}-last-${days}d.csv"`)
      .send(csv);
  });

  app.post('/dashboard/standup/:id', async (req, res) => {
    if (!(await authed(req, res))) return;
    const standup = await repo.getStandupById(Number(req.params.id));
    if (!standup) return notFound(res, 'Unknown standup.');
    const error = await applyConfig(repo, standup, req.body);
    if (error) {
      res.status(400).send(layout(`${standup.name} — AsyncUp`, 'home', await standupPage(repo, (await repo.getStandupById(standup.id))!, now(), false, error, null, !!deps.runNow, deps.webhookSecret)));
      return;
    }
    res.redirect(`/dashboard/standup/${standup.id}?saved=1`);
  });

  app.get('/dashboard/standup/:id/run/:date', async (req, res) => {
    if (!(await authed(req, res))) return;
    const standup = await repo.getStandupById(Number(req.params.id));
    const run = standup ? await repo.getRun(standup.id, String(req.params.date)) : null;
    if (!standup || !run) return notFound(res, 'Unknown run.');
    const submissions = await repo.listSubmissions(run.id);
    const cards = submissions
      .map(
        (s) => `<div class="card sub">
          <h3>${s.mood && !standup.moodAnonymous ? MOOD_EMOJI[s.mood] : '📝'} ${esc(s.displayName)}
            ${s.late ? '<span class="tag">late</span>' : ''}${s.editedAt ? '<span class="tag">edited</span>' : ''}</h3>
          ${s.answers.map((a) => `<p><b>${esc(a.question)}</b><br>${esc(a.answer)}</p>`).join('')}
        </div>`,
      )
      .join('');
    const progress = runProgress(await repo.listRunParticipants(run.id), submissions);
    const missing = progress.missingMandatory.map((p) => esc(p.displayName));
    res.send(
      layout(
        `${run.date} — ${standup.name}`,
        'home',
        `<p class="crumbs"><a href="/dashboard/standup/${standup.id}">← ${esc(standup.name)}</a></p>
        <h1>${run.date} <small>(${run.status})</small></h1>
        ${missing.length ? `<p>❌ Missing: ${missing.join(', ')}</p>` : ''}
        ${cards || '<div class="card"><p class="muted">No submissions.</p></div>'}`,
      ),
    );
  });
}

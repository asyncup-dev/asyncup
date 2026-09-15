import type { Express, Request, Response } from 'express';
import { IANAZone, type DateTime } from 'luxon';
import { sessionFrom, type Session } from '../auth/session.js';
import { MOOD_EMOJI } from '../core/types.js';
import type { Repo } from '../db/repo.js';
import { esc, layout } from './dashboard.js';

export interface MeDeps {
  repo: Repo;
  secretKey: string;
  now?: () => DateTime;
  /** Whether Google sign-in is configured (renders the login button). */
  signInEnabled: () => Promise<boolean>;
}

/**
 * The user console — every signed-in Workspace member gets this view of
 * their own standups. Identity comes from the Google session: the OIDC
 * `sub` is the same user id Chat uses in `users/<id>` resource names.
 */
export function registerUserConsole(app: Express, deps: MeDeps): void {
  const { repo } = deps;

  const requireSession = async (req: Request, res: Response): Promise<Session | null> => {
    const session = sessionFrom(req, deps.secretKey);
    if (session) return session;
    const enabled = deps.secretKey && (await deps.signInEnabled());
    res.status(401).send(
      layout(
        'Sign in — AsyncUp',
        'me',
        `<section class="card" style="max-width:420px;margin:3rem auto;text-align:center">
          <div class="kicker">My standups</div>
          <h2>Sign in to see your standups</h2>
          ${
            enabled
              ? `<a class="btn" href="/auth/google">Sign in with Google</a>
                 <p><small class="muted">Workspace admins land in the admin dashboard automatically.</small></p>`
              : `<p class="muted">Google sign-in isn't configured yet — an admin can set the OAuth client
                 in dashboard settings.</p>`
          }
        </section>`,
      ),
    );
    return null;
  };

  app.get('/me', async (req, res) => {
    const session = await requireSession(req, res);
    if (!session) return;
    const userName = `users/${session.sub}`;
    const now = (deps.now ?? (() => null))();

    const standups = await repo.listStandupsForUser(userName);
    const timezone = await repo.getUserTimezone(userName);
    const onVacation =
      standups.length > 0 &&
      (await repo.listParticipants(standups[0]!.id)).find((p) => p.userName === userName)?.onVacation === true;

    const rows: string[] = [];
    for (const s of standups) {
      const today = now ? now.setZone(s.timezone).toISODate()! : null;
      const run = today ? await repo.getRun(s.id, today) : null;
      let todayCell = '—';
      if (run) {
        const mine = await repo.getSubmission(run.id, userName);
        todayCell = mine ? '✅ submitted' : run.status === 'open' ? '⏳ waiting for you' : 'closed';
      }
      rows.push(`<tr>
        <td>${esc(s.name)}</td>
        <td>${esc(s.promptTime)} → ${esc(s.deadlineTime)} ${esc(s.timezone)} · ${esc(s.days)}</td>
        <td>${todayCell}</td>
      </tr>`);
    }

    const history = (await repo.listRecentSubmissionsForUser(userName, 10))
      .map(
        ({ submission, runDate, standupName }) => `<div class="card sub">
          <h3>${submission.mood ? MOOD_EMOJI[submission.mood] : '📝'} ${runDate} · ${esc(standupName)}
            ${submission.late ? '<span class="tag">late</span>' : ''}${submission.editedAt ? '<span class="tag">edited</span>' : ''}</h3>
          ${submission.answers.map((a) => `<p><b>${esc(a.question)}</b><br>${esc(a.answer)}</p>`).join('')}
        </div>`,
      )
      .join('');

    res.send(
      layout(
        'My standups — AsyncUp',
        'me',
        `<h1>${esc(session.name)} <small class="muted">${esc(session.email)}</small></h1>
        ${typeof req.query.notice === 'string' ? `<div class="toast ok">${esc(req.query.notice)}</div>` : ''}
        <section class="card">
          <div class="kicker">My standups</div>
          ${standups.length === 0 ? '<p class="muted">You are not on any standup roster yet — ask an admin to <code>add</code> you in the team space.</p>' : ''}
          ${standups.length ? `<table><tr><th>Standup</th><th>Schedule</th><th>Today</th></tr>${rows.join('')}</table>` : ''}
        </section>
        <div class="cols">
          <section class="card">
            <div class="kicker">My settings</div>
            <form method="post" action="/me/timezone">
              <label>My timezone <input name="timezone" value="${esc(timezone ?? '')}" placeholder="e.g. Asia/Kolkata — empty follows each standup">
              <small class="muted">Prompts arrive at the standup's prompt time in this zone.</small></label>
              <button class="btn" type="submit">Save timezone</button>
            </form>
            <form method="post" action="/me/vacation" style="margin-top:.8rem">
              <button class="btn ghost" name="state" value="${onVacation ? 'off' : 'on'}" type="submit">
                ${onVacation ? '👋 I\'m back — resume prompts' : '🏖️ Vacation mode — pause prompts'}
              </button>
            </form>
            <form method="post" action="/auth/logout" style="margin-top:.8rem">
              <button class="btn ghost" type="submit">Sign out</button>
            </form>
          </section>
          <section class="card">
            <div class="kicker">Recent submissions</div>
            ${history || '<p class="muted">Nothing yet — your submissions will appear here.</p>'}
          </section>
        </div>`,
        { user: session },
      ),
    );
  });

  app.post('/me/timezone', async (req, res) => {
    const session = await requireSession(req, res);
    if (!session) return;
    const tz = String(req.body?.timezone ?? '').trim();
    if (tz && !IANAZone.isValidZone(tz)) {
      res.redirect(`/me?notice=${encodeURIComponent(`Invalid IANA timezone: ${tz}`)}`);
      return;
    }
    await repo.setTimezoneForUser(`users/${session.sub}`, tz || null);
    res.redirect(`/me?notice=${encodeURIComponent(tz ? `Prompts now follow ${tz}.` : "Following each standup's timezone.")}`);
  });

  app.post('/me/vacation', async (req, res) => {
    const session = await requireSession(req, res);
    if (!session) return;
    const on = String(req.body?.state) === 'on';
    await repo.setVacationForUser(`users/${session.sub}`, on);
    res.redirect(`/me?notice=${encodeURIComponent(on ? 'Vacation mode on — prompts paused.' : 'Welcome back — prompts resume.')}`);
  });
}

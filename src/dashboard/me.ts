import type { Express, Request, Response } from 'express';
import { DateTime } from 'luxon';
import { chatUserName as toChatUserName } from '../core/directory.js';
import { setMemberTimezone, setMemberVacation } from '../core/member.js';
import { sessionFrom, type Session } from '../auth/session.js';
import { MOOD_EMOJI } from '../core/types.js';
import type { Repo } from '../db/repo.js';
import { esc, layout, signInCard } from './chrome.js';

export interface MeDeps {
  repo: Repo;
  secretKey: string;
  now?: () => DateTime;
  /** Whether Google sign-in is configured (renders the login button). */
  signInEnabled?: () => Promise<boolean>;
  /** Whether SAML sign-in is configured (renders the SSO button). */
  samlEnabled?: () => Promise<boolean>;
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
    const google = !!(deps.secretKey && (await deps.signInEnabled?.()));
    const saml = !!(deps.secretKey && (await deps.samlEnabled?.()));
    res.status(401).send(
      layout(
        'Sign in — AsyncUp',
        'me',
        signInCard({
          kicker: 'My standups',
          heading: 'Sign in to see your standups',
          google,
          saml,
          footnotes: [
            google || saml
              ? 'Workspace admins land in the admin dashboard automatically.'
              : "Sign-in isn't configured yet — an admin can set the OAuth client or SAML IdP in dashboard settings.",
          ],
        }),
      ),
    );
    return null;
  };

  // Google sign-ins carry the Chat user id; SAML sign-ins may only carry an
  // email — then the cached email map (Chat events / Directory) links them.
  const chatUserName = async (session: Session): Promise<string | null> =>
    session.sub ? toChatUserName(session.sub) : repo.findUserNameByEmail(session.email);

  app.get('/me', async (req, res) => {
    const session = await requireSession(req, res);
    if (!session) return;
    const userName = (await chatUserName(session)) ?? '';
    const now = (deps.now ?? (() => DateTime.utc()))();

    const standups = userName ? await repo.listStandupsForUser(userName) : [];
    const timezone = userName ? await repo.getUserTimezone(userName) : null;
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
          ${
            !userName
              ? '<p class="muted">Your account isn\'t linked to Google Chat yet — it links automatically the first time you use the AsyncUp bot in Chat (or when an admin configures the Directory integration).</p>'
              : standups.length === 0
                ? '<p class="muted">You are not on any standup roster yet — ask an admin to <code>add</code> you in the team space.</p>'
                : ''
          }
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
    const userName = await chatUserName(session);
    if (!userName) {
      res.redirect(`/me?notice=${encodeURIComponent('Account not linked to Chat yet.')}`);
      return;
    }
    const result = await setMemberTimezone(repo, userName, String(req.body?.timezone ?? ''));
    if (!result.ok) {
      res.redirect(`/me?notice=${encodeURIComponent(result.message)}`);
      return;
    }
    res.redirect(`/me?notice=${encodeURIComponent(result.timezone ? `Prompts now follow ${result.timezone}.` : "Following each standup's timezone.")}`);
  });

  app.post('/me/vacation', async (req, res) => {
    const session = await requireSession(req, res);
    if (!session) return;
    const userName = await chatUserName(session);
    if (!userName) {
      res.redirect(`/me?notice=${encodeURIComponent('Account not linked to Chat yet.')}`);
      return;
    }
    const on = String(req.body?.state) === 'on';
    await setMemberVacation(repo, userName, on);
    res.redirect(`/me?notice=${encodeURIComponent(on ? 'Vacation mode on — prompts paused.' : 'Welcome back — prompts resume.')}`);
  });
}

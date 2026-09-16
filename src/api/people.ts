import type { Router } from 'express';
import { apiError, principalOf, visibleStandups, type ApiContext } from './shared.js';

/** The Team directory: everyone on a roster the caller may see, with their standups and roles. */
export function registerPeopleRoutes(api: Router, ctx: ApiContext): void {
  const { repo } = ctx;

  api.get('/people', async (req, res) => {
    const p = principalOf(req);
    if (p.kind === 'member') {
      apiError(res, 403, 'forbidden', 'Only admins and managers can list the team.');
      return;
    }
    const visible = new Set((await visibleStandups(repo, p)).map((s) => s.id));
    const emails = new Map((await repo.listUserEmails()).map((e) => [e.userName, e.email]));
    const admins = new Set<string>();
    for (const id of visible) for (const a of await repo.listAdmins(id)) admins.add(`${id}:${a.userName}`);

    const people = new Map<
      string,
      {
        userName: string;
        displayName: string;
        email: string | null;
        timezone: string | null;
        onVacation: boolean;
        standups: { id: number; name: string; mandatory: boolean; admin: boolean }[];
      }
    >();
    for (const row of await repo.listTenantParticipants(p.tenantId)) {
      if (!visible.has(row.standupId)) continue;
      const entry = people.get(row.userName) ?? {
        userName: row.userName,
        displayName: row.displayName,
        email: emails.get(row.userName) ?? null,
        timezone: row.timezone,
        onVacation: false,
        standups: [],
      };
      entry.onVacation = entry.onVacation || row.onVacation;
      entry.standups.push({
        id: row.standupId,
        name: row.standupName,
        mandatory: row.mandatory,
        admin: admins.has(`${row.standupId}:${row.userName}`),
      });
      people.set(row.userName, entry);
    }
    res.json({ people: [...people.values()] });
  });
}

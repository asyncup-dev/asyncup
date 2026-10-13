import { describe, expect, it } from 'bun:test';
import { validateStandupConfig } from '../src/core/standup-config.js';
import { makeStack, seedStandup, TENANT } from './helpers.js';

describe('runs and deadlines', () => {
  it('never opens a run after the deadline, even when the roster fills late', async () => {
    const { repo, scheduler, clock, adapter } = await makeStack();
    const standup = await repo.createStandup({ tenantId: TENANT, spaceName: 'spaces/late', name: 'Late', timezone: 'Asia/Kolkata' });
    clock.set('2026-06-10T11:45'); // Wednesday, after the 11:30 deadline
    await repo.upsertParticipant({ standupId: standup.id, userName: 'users/a', displayName: 'Asha' });
    await scheduler.tick();
    expect(await repo.getRun(standup.id, '2026-06-10')).toBeNull();
    expect(adapter.dms).toEqual([]);

    // the next day opens as usual
    clock.set('2026-06-11T09:30');
    await scheduler.tick();
    expect((await repo.getRun(standup.id, '2026-06-11'))!.status).toBe('open');
  });

  it('refuses run-now once the deadline has passed, and says how to run today', async () => {
    const { repo, scheduler, commands, clock } = await makeStack();
    const standup = await seedStandup(repo);
    clock.set('2026-06-10T12:00');
    expect(await scheduler.runNow(standup)).toBe('past_deadline');
    expect(await repo.getRun(standup.id, '2026-06-10')).toBeNull();
    const reply = await commands.handle({ tenantId: TENANT, spaceName: standup.spaceName, text: 'run now', mentions: [], sender: { userName: 'users/alice', displayName: 'Alice' } });
    expect(reply).toBe("Today's 11:30 deadline has passed, so a run would close as soon as it opened. Move it with `deadline HH:MM` to run today.");
  });
});

describe('escalation contact', () => {
  it('can be anyone on the standup or one of its admins, but no one else', async () => {
    const { repo } = await makeStack();
    const standup = await seedStandup(repo);
    await repo.addAdmin(standup.id, 'users/lead', 'Lead');
    expect(await validateStandupConfig(repo, standup, { escalateUserName: 'users/lead' })).toEqual({
      ok: true,
      fields: { escalateUserName: 'users/lead', escalateDisplayName: 'Lead' },
    });
    expect(await validateStandupConfig(repo, standup, { escalateUserName: 'users/alice' })).toMatchObject({ ok: true });
    expect(await validateStandupConfig(repo, standup, { escalateUserName: 'users/zed' })).toEqual({
      ok: false,
      field: 'escalateUserName',
      message: 'Escalation contact must be on this standup or one of its admins.',
    });
  });
});

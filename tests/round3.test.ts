import { describe, expect, it } from 'vitest';
import { EventRouter } from '../src/adapters/gchat/events.js';
import { submissionMessage, summaryText } from '../src/adapters/gchat/cards.js';
import type { Mention } from '../src/core/commands.js';
import type { OooChecker } from '../src/core/ooo.js';
import type { RunSummary } from '../src/core/types.js';
import { ANSWERS, makeStack, seedStandup, TENANT, withBlocker } from './helpers.js';

const ADMIN = { userName: 'users/admin', displayName: 'Admin' };
const LEAD = { userName: 'users/lead', displayName: 'Lead' };

function ctx(text: string, mentions: Mention[] = [], sender: Mention = ADMIN) {
  return { tenantId: TENANT, spaceName: 'spaces/team', text, mentions, sender };
}

describe('Calendar OOO sync', () => {
  function makeChecker(oooEmails: string[]): OooChecker & { calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      async isOoo(email) {
        calls.push(email);
        return oooEmails.includes(email);
      },
    };
  }

  it('marks participants with an OOO event as away for the run', async () => {
    const checker = makeChecker(['bob@org.com']);
    const stack = await makeStack();
    const scheduler = new (await import('../src/core/scheduler.js')).Scheduler(
      stack.repo,
      stack.adapter,
      stack.service,
      stack.clock.now,
      () => {},
      null,
      checker,
    );
    const standup = await seedStandup(stack.repo);
    await stack.repo.setUserEmail('users/alice', 'alice@org.com');
    await stack.repo.setUserEmail('users/bob', 'bob@org.com');
    // carol has no known email — never checked

    stack.clock.set('2026-06-10T09:30');
    await scheduler.tick();

    expect(checker.calls.sort()).toEqual(['alice@org.com', 'bob@org.com']);
    const run = (await stack.repo.getRun(standup.id, '2026-06-10'))!;
    const bob = (await stack.repo.listRunParticipants(run.id)).find((p) => p.userName === 'users/bob')!;
    expect(bob.onVacation).toBe(true);
    // bob never prompted; persistent participant record untouched
    expect(stack.adapter.dms.filter((d) => d.kind === 'prompt').map((d) => d.userName).sort()).toEqual([
      'users/alice',
      'users/carol',
    ]);
    expect(
      (await stack.repo.listParticipants(standup.id)).find((p) => p.userName === 'users/bob')!.onVacation,
    ).toBe(false);

    stack.clock.set('2026-06-10T11:30');
    await scheduler.tick();
    const summary = stack.adapter.posts.find((p) => p.kind === 'summary')!.payload as RunSummary;
    expect(summary.away).toContain('Bob');
    expect(summary.missingMandatory).not.toContain('Bob');
  });

  it('treats checker failures as not-OOO', async () => {
    const stack = await makeStack();
    const failing: OooChecker = {
      async isOoo() {
        throw new Error('DWD not configured');
      },
    };
    const scheduler = new (await import('../src/core/scheduler.js')).Scheduler(
      stack.repo,
      stack.adapter,
      stack.service,
      stack.clock.now,
      () => {},
      null,
      failing,
    );
    await seedStandup(stack.repo);
    await stack.repo.setUserEmail('users/alice', 'alice@org.com');
    stack.clock.set('2026-06-10T09:30');
    await scheduler.tick();
    expect(stack.adapter.dms.filter((d) => d.kind === 'prompt')).toHaveLength(3);
  });
});

describe('Anonymous mood', () => {
  it('hides per-person mood on cards and shows the team average in the wrap-up', async () => {
    const { repo, service } = await makeStack();
    const standup = await seedStandup(repo);
    await repo.updateStandup(standup.id, { moodAnonymous: true });
    const run = await repo.createRun(standup.id, '2026-06-10', 'k');
    await service.submit(run.id, 'users/alice', 'Alice', { ...ANSWERS, mood: 'great' }); // 5
    await service.submit(run.id, 'users/bob', 'Bob', { ...ANSWERS, mood: 'okay' }); // 3

    const summary = await service.buildSummary(run.id);
    expect(summary.teamMood).toBe(4);
    expect(summaryText(summary)).toContain('💭 Team mood today: 🙂 4/5');

    const sub = (await repo.getSubmission(run.id, 'users/alice'))!;
    const card = JSON.stringify(submissionMessage(sub, true));
    expect(card).toContain('📝 Alice');
    expect(card).not.toContain('😄');
  });

  it('keeps teamMood null when mood is not anonymous', async () => {
    const { repo, service } = await makeStack();
    const standup = await seedStandup(repo);
    const run = await repo.createRun(standup.id, '2026-06-10', 'k');
    await service.submit(run.id, 'users/alice', 'Alice', ANSWERS);
    expect((await service.buildSummary(run.id)).teamMood).toBeNull();
  });

  it('is configured via `mood anon`', async () => {
    const { commands, repo } = await makeStack();
    await commands.handle(ctx('setup'));
    expect(await commands.handle(ctx('mood anon'))).toContain('anonymous');
    const standup = (await repo.listStandupsBySpace(TENANT, 'spaces/team'))[0]!;
    expect(standup.moodEnabled).toBe(true);
    expect(standup.moodAnonymous).toBe(true);
    expect(await commands.handle(ctx('mood on'))).toContain('moods show');
    expect((await repo.listStandupsBySpace(TENANT, 'spaces/team'))[0]!.moodAnonymous).toBe(false);
  });
});

describe('Blocker escalation', () => {
  it('configures the contact and threshold via commands', async () => {
    const { commands, repo } = await makeStack();
    await commands.handle(ctx('setup'));
    expect(await commands.handle(ctx('escalate'))).toContain('Mention who');
    expect(await commands.handle(ctx('escalate @Lead', [LEAD]))).toContain('Lead will be DMed');
    expect(await commands.handle(ctx('escalate days 3'))).toContain('after 3 days');
    const standup = (await repo.listStandupsBySpace(TENANT, 'spaces/team'))[0]!;
    expect(standup.escalateUserName).toBe(LEAD.userName);
    expect(standup.escalateAfterDays).toBe(3);
    expect(await commands.handle(ctx('escalate off'))).toContain('escalation off');
    expect((await repo.listStandupsBySpace(TENANT, 'spaces/team'))[0]!.escalateUserName).toBeNull();
  });

  it('DMs the contact once when blockers stay open past the threshold', async () => {
    const { repo, adapter, scheduler, service, clock } = await makeStack();
    const standup = await seedStandup(repo);
    await repo.updateStandup(standup.id, {
      escalateUserName: LEAD.userName,
      escalateDisplayName: LEAD.displayName,
      escalateAfterDays: 2,
    });

    // Monday: alice reports a blocker
    clock.set('2026-06-08T09:30');
    await scheduler.tick();
    const mon = (await repo.getRun(standup.id, '2026-06-08'))!;
    await service.submit(mon.id, 'users/alice', 'Alice', withBlocker('Waiting on API keys'));
    clock.set('2026-06-08T11:30');
    await scheduler.tick();
    expect(adapter.dms.filter((d) => d.kind === 'text')).toHaveLength(0); // age 0 — no ping

    // Wednesday close: blocker is 2 days old → escalate once
    clock.set('2026-06-10T09:30');
    await scheduler.tick();
    clock.set('2026-06-10T11:30');
    await scheduler.tick();
    const pings = adapter.dms.filter((d) => d.kind === 'text');
    expect(pings).toHaveLength(1);
    expect(pings[0]!.userName).toBe(LEAD.userName);
    expect(pings[0]!.text).toContain('Waiting on API keys');

    // Thursday close: already escalated — no repeat
    clock.set('2026-06-11T09:30');
    await scheduler.tick();
    clock.set('2026-06-11T11:30');
    await scheduler.tick();
    expect(adapter.dms.filter((d) => d.kind === 'text')).toHaveLength(1);
  });
});

describe('Email capture', () => {
  it('learns user emails from interaction events', async () => {
    const stack = await makeStack();
    const router = new EventRouter(stack.commands, stack.service, stack.repo, TENANT);
    await router.handle({
      type: 'MESSAGE',
      space: { name: 'spaces/team', type: 'ROOM' },
      message: { argumentText: 'help' },
      user: { name: 'users/alice', displayName: 'Alice', email: 'alice@org.com' },
    });
    expect(await stack.repo.getUserEmail('users/alice')).toBe('alice@org.com');
    expect(await stack.repo.getUserEmail('users/bob')).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import type { Mention } from '../src/core/commands.js';
import { ANSWERS, makeStack, TENANT, withBlocker } from './helpers.js';

const SPACE = 'spaces/team';
const ADMIN = { userName: 'users/admin', displayName: 'Admin' };
const ALICE = { userName: 'users/alice', displayName: 'Alice' };
const BOB = { userName: 'users/bob', displayName: 'Bob' };

function ctx(text: string, mentions: Mention[] = [], sender: Mention = ADMIN) {
  return { tenantId: TENANT, spaceName: SPACE, text, mentions, sender };
}

describe('CommandHandler', () => {
  it('shows help for empty or help text', async () => {
    const { commands } = await makeStack();
    expect(await commands.handle(ctx(''))).toContain('AsyncUp commands');
    expect(await commands.handle(ctx('help'))).toContain('setup');
  });

  it('requires setup before other commands', async () => {
    const { commands } = await makeStack();
    expect(await commands.handle(ctx('status'))).toContain('Run `setup` first');
  });

  it('creates a standup with setup, making the creator admin', async () => {
    const { commands, repo } = await makeStack();
    const reply = await commands.handle(ctx('setup Platform Team'));
    expect(reply).toContain('Platform Team');
    expect(reply).toContain('You are its admin');
    const standup = (await repo.listStandupsBySpace(TENANT, SPACE))[0]!;
    expect(await repo.isAdmin(standup.id, ADMIN.userName)).toBe(true);
  });

  it('supports multiple standups per space via #id addressing', async () => {
    const { commands, repo } = await makeStack();
    await commands.handle(ctx('setup Eng'));
    await commands.handle(ctx('setup Design'));
    const [eng, design] = await repo.listStandupsBySpace(TENANT, SPACE);

    // ambiguous without a prefix
    expect(await commands.handle(ctx('time 08:00'))).toContain('prefix your command');

    expect(await commands.handle(ctx(`#${design!.id} time 08:00`))).toContain('08:00');
    expect((await repo.getStandupById(design!.id))!.promptTime).toBe('08:00');
    expect((await repo.getStandupById(eng!.id))!.promptTime).toBe('09:30');

    expect(await commands.handle(ctx('#999 time 08:00'))).toContain('No standup #999');

    // bare status shows all standups
    const status = await commands.handle(ctx('status'));
    expect(status).toContain('Eng');
    expect(status).toContain('Design');
  });

  it('restricts config commands to admins', async () => {
    const { commands, repo } = await makeStack();
    await commands.handle(ctx('setup'));
    const standup = (await repo.listStandupsBySpace(TENANT, SPACE))[0]!;

    expect(await commands.handle(ctx('time 08:00', [], ALICE))).toContain('🔒 Only admins');
    expect(await commands.handle(ctx('status', [], ALICE))).not.toContain('🔒');

    await commands.handle(ctx('admin @Alice', [ALICE]));
    expect(await repo.isAdmin(standup.id, ALICE.userName)).toBe(true);
    expect(await commands.handle(ctx('time 08:00', [], ALICE))).toContain('08:00');

    // can't remove the last admin
    await commands.handle(ctx('unadmin @Admin', [ADMIN], ALICE));
    expect(await commands.handle(ctx('unadmin @Alice', [ALICE], ALICE))).toContain('at least one admin');
  });

  it('adds, removes and toggles participants via mentions', async () => {
    const { commands, repo } = await makeStack();
    await commands.handle(ctx('setup'));
    expect(await commands.handle(ctx('add'))).toContain('Mention the people');

    await commands.handle(ctx('add @Alice @Bob', [ALICE, BOB]));
    const standup = (await repo.listStandupsBySpace(TENANT, SPACE))[0]!;
    expect(await repo.listParticipants(standup.id)).toHaveLength(2);
    expect((await repo.listParticipants(standup.id)).every((p) => p.mandatory)).toBe(true);

    expect(await commands.handle(ctx('optional @Bob', [BOB]))).toContain('Bob now optional');
    expect(await commands.handle(ctx('mandatory @Bob', [BOB]))).toContain('Bob now mandatory');
    expect(await commands.handle(ctx('remove @Alice', [ALICE]))).toContain('Removed Alice');
    expect(await repo.listParticipants(standup.id)).toHaveLength(1);
  });

  it('marks people on vacation and back', async () => {
    const { commands, repo } = await makeStack();
    await commands.handle(ctx('setup'));
    await commands.handle(ctx('add @Alice', [ALICE]));
    const standup = (await repo.listStandupsBySpace(TENANT, SPACE))[0]!;

    expect(await commands.handle(ctx('vacation @Alice', [ALICE]))).toContain('🏖️ Alice');
    expect((await repo.listParticipants(standup.id))[0]!.onVacation).toBe(true);
    expect(await commands.handle(ctx('back @Alice', [ALICE]))).toContain('Alice back');
    expect((await repo.listParticipants(standup.id))[0]!.onVacation).toBe(false);
    expect(await commands.handle(ctx('vacation @Bob', [BOB]))).toContain('Not participants');
  });

  it('validates and sets times', async () => {
    const { commands, repo } = await makeStack();
    await commands.handle(ctx('setup'));
    expect(await commands.handle(ctx('time 25:00'))).toContain('24h time');
    expect(await commands.handle(ctx('time 08:30'))).toContain('08:30');
    expect(await commands.handle(ctx('deadline 10:00'))).toContain('10:00');
    expect(await commands.handle(ctx('deadline 08:00'))).toContain('must be before');
    const standup = (await repo.listStandupsBySpace(TENANT, SPACE))[0]!;
    expect(standup.promptTime).toBe('08:30');
    expect(standup.deadlineTime).toBe('10:00');
  });

  it('validates timezone, days and reminder', async () => {
    const { commands, repo } = await makeStack();
    await commands.handle(ctx('setup'));
    expect(await commands.handle(ctx('timezone Mars/Olympus'))).toContain('valid IANA');
    expect(await commands.handle(ctx('timezone Europe/Berlin'))).toContain('Europe/Berlin');
    expect(await commands.handle(ctx('days mon,funday'))).toContain('list days');
    expect(await commands.handle(ctx('days wed,mon'))).toContain('mon, wed');
    expect(await commands.handle(ctx('remind 0'))).toContain('disabled');
    const standup = (await repo.listStandupsBySpace(TENANT, SPACE))[0]!;
    expect(standup.timezone).toBe('Europe/Berlin');
    expect(standup.days).toBe('mon,wed');
  });

  it('manages custom questions', async () => {
    const { commands, repo } = await makeStack();
    await commands.handle(ctx('setup'));
    expect(await commands.handle(ctx('questions'))).toContain('What did you do yesterday?');

    const reply = await commands.handle(ctx('questions set What shipped? | What is next? | Any blockers?'));
    expect(reply).toContain('1. What shipped?');
    const standup = (await repo.listStandupsBySpace(TENANT, SPACE))[0]!;
    expect(standup.questions).toEqual(['What shipped?', 'What is next?', 'Any blockers?']);

    expect(await commands.handle(ctx('questions set'))).toContain('separated by `|`');
    expect(await commands.handle(ctx('questions reset'))).toContain('defaults');
    expect((await repo.listStandupsBySpace(TENANT, SPACE))[0]!.questions).toBeNull();
  });

  it('toggles mood, digest and ai', async () => {
    const { commands, repo } = await makeStack();
    await commands.handle(ctx('setup'));
    expect(await commands.handle(ctx('mood off'))).toContain('Mood question off');
    expect(await commands.handle(ctx('digest on'))).toContain('Weekly digest on');
    expect(await commands.handle(ctx('ai on'))).toContain('LLM_PROVIDER');
    expect(await commands.handle(ctx('ai banana'))).toContain('`on` or `off`');
    const standup = (await repo.listStandupsBySpace(TENANT, SPACE))[0]!;
    expect(standup.moodEnabled).toBe(false);
    expect(standup.digestEnabled).toBe(true);
    expect(standup.aiEnabled).toBe(true);
  });

  it('lists open blockers with age', async () => {
    const { commands, repo, service, clock } = await makeStack();
    await commands.handle(ctx('setup'));
    await commands.handle(ctx('add @Alice', [ALICE]));
    const standup = (await repo.listStandupsBySpace(TENANT, SPACE))[0]!;
    expect(await commands.handle(ctx('blockers'))).toContain('No open blockers');

    const run = await repo.createRun(standup.id, '2026-06-08', 'k');
    await service.submit(run.id, ALICE.userName, ALICE.displayName, withBlocker('Waiting on keys'));
    clock.set('2026-06-10T12:00');
    const reply = await commands.handle(ctx('blockers'));
    expect(reply).toContain('Waiting on keys');
    expect(reply).toContain('(2d old)');
  });

  it('shows trends and export info', async () => {
    const { commands } = await makeStack();
    await commands.handle(ctx('setup'));
    expect(await commands.handle(ctx('trends'))).toContain('last 4 weeks');
    const exportReply = await commands.handle(ctx('export'));
    expect(exportReply).toContain('/export?standupId=');
    expect(exportReply).toContain('EXPORT_TOKEN');
  });

  it('reports status including today’s progress with away handling', async () => {
    const { commands, repo, scheduler, service, clock } = await makeStack();
    await commands.handle(ctx('setup'));
    await commands.handle(ctx('add @Alice @Bob', [ALICE, BOB]));

    clock.set('2026-06-10T09:30');
    await scheduler.tick();
    const standup = (await repo.listStandupsBySpace(TENANT, SPACE))[0]!;
    const run = (await repo.getRun(standup.id, '2026-06-10'))!;
    await service.submit(run.id, ALICE.userName, ALICE.displayName, ANSWERS);
    await service.skipToday(run.id, BOB.userName);

    const status = await commands.handle(ctx('status'));
    expect(status).toContain('1/1 submitted');
    expect(status).toContain('✅ Alice');
    expect(status).toContain('🏖️ Bob');
    expect(status).toContain('Admins: Admin');
  });

  it('rejects unknown commands', async () => {
    const { commands } = await makeStack();
    await commands.handle(ctx('setup'));
    expect(await commands.handle(ctx('frobnicate'))).toContain('Unknown command');
  });
});

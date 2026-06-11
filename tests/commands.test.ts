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
  it('shows help for empty or help text', () => {
    const { commands } = makeStack();
    expect(commands.handle(ctx(''))).toContain('AsyncUp commands');
    expect(commands.handle(ctx('help'))).toContain('setup');
  });

  it('requires setup before other commands', () => {
    const { commands } = makeStack();
    expect(commands.handle(ctx('status'))).toContain('Run `setup` first');
  });

  it('creates a standup with setup, making the creator admin', () => {
    const { commands, repo } = makeStack();
    const reply = commands.handle(ctx('setup Platform Team'));
    expect(reply).toContain('Platform Team');
    expect(reply).toContain('You are its admin');
    const standup = repo.listStandupsBySpace(TENANT, SPACE)[0]!;
    expect(repo.isAdmin(standup.id, ADMIN.userName)).toBe(true);
  });

  it('supports multiple standups per space via #id addressing', () => {
    const { commands, repo } = makeStack();
    commands.handle(ctx('setup Eng'));
    commands.handle(ctx('setup Design'));
    const [eng, design] = repo.listStandupsBySpace(TENANT, SPACE);

    // ambiguous without a prefix
    expect(commands.handle(ctx('time 08:00'))).toContain('prefix your command');

    expect(commands.handle(ctx(`#${design!.id} time 08:00`))).toContain('08:00');
    expect(repo.getStandupById(design!.id)!.promptTime).toBe('08:00');
    expect(repo.getStandupById(eng!.id)!.promptTime).toBe('09:30');

    expect(commands.handle(ctx('#999 time 08:00'))).toContain('No standup #999');

    // bare status shows all standups
    const status = commands.handle(ctx('status'));
    expect(status).toContain('Eng');
    expect(status).toContain('Design');
  });

  it('restricts config commands to admins', () => {
    const { commands, repo } = makeStack();
    commands.handle(ctx('setup'));
    const standup = repo.listStandupsBySpace(TENANT, SPACE)[0]!;

    expect(commands.handle(ctx('time 08:00', [], ALICE))).toContain('🔒 Only admins');
    expect(commands.handle(ctx('status', [], ALICE))).not.toContain('🔒');

    commands.handle(ctx('admin @Alice', [ALICE]));
    expect(repo.isAdmin(standup.id, ALICE.userName)).toBe(true);
    expect(commands.handle(ctx('time 08:00', [], ALICE))).toContain('08:00');

    // can't remove the last admin
    commands.handle(ctx('unadmin @Admin', [ADMIN], ALICE));
    expect(commands.handle(ctx('unadmin @Alice', [ALICE], ALICE))).toContain('at least one admin');
  });

  it('adds, removes and toggles participants via mentions', () => {
    const { commands, repo } = makeStack();
    commands.handle(ctx('setup'));
    expect(commands.handle(ctx('add'))).toContain('Mention the people');

    commands.handle(ctx('add @Alice @Bob', [ALICE, BOB]));
    const standup = repo.listStandupsBySpace(TENANT, SPACE)[0]!;
    expect(repo.listParticipants(standup.id)).toHaveLength(2);
    expect(repo.listParticipants(standup.id).every((p) => p.mandatory)).toBe(true);

    expect(commands.handle(ctx('optional @Bob', [BOB]))).toContain('Bob now optional');
    expect(commands.handle(ctx('mandatory @Bob', [BOB]))).toContain('Bob now mandatory');
    expect(commands.handle(ctx('remove @Alice', [ALICE]))).toContain('Removed Alice');
    expect(repo.listParticipants(standup.id)).toHaveLength(1);
  });

  it('marks people on vacation and back', () => {
    const { commands, repo } = makeStack();
    commands.handle(ctx('setup'));
    commands.handle(ctx('add @Alice', [ALICE]));
    const standup = repo.listStandupsBySpace(TENANT, SPACE)[0]!;

    expect(commands.handle(ctx('vacation @Alice', [ALICE]))).toContain('🏖️ Alice');
    expect(repo.listParticipants(standup.id)[0]!.onVacation).toBe(true);
    expect(commands.handle(ctx('back @Alice', [ALICE]))).toContain('Alice back');
    expect(repo.listParticipants(standup.id)[0]!.onVacation).toBe(false);
    expect(commands.handle(ctx('vacation @Bob', [BOB]))).toContain('Not participants');
  });

  it('validates and sets times', () => {
    const { commands, repo } = makeStack();
    commands.handle(ctx('setup'));
    expect(commands.handle(ctx('time 25:00'))).toContain('24h time');
    expect(commands.handle(ctx('time 08:30'))).toContain('08:30');
    expect(commands.handle(ctx('deadline 10:00'))).toContain('10:00');
    expect(commands.handle(ctx('deadline 08:00'))).toContain('must be before');
    const standup = repo.listStandupsBySpace(TENANT, SPACE)[0]!;
    expect(standup.promptTime).toBe('08:30');
    expect(standup.deadlineTime).toBe('10:00');
  });

  it('validates timezone, days and reminder', () => {
    const { commands, repo } = makeStack();
    commands.handle(ctx('setup'));
    expect(commands.handle(ctx('timezone Mars/Olympus'))).toContain('valid IANA');
    expect(commands.handle(ctx('timezone Europe/Berlin'))).toContain('Europe/Berlin');
    expect(commands.handle(ctx('days mon,funday'))).toContain('list days');
    expect(commands.handle(ctx('days wed,mon'))).toContain('mon, wed');
    expect(commands.handle(ctx('remind 0'))).toContain('disabled');
    const standup = repo.listStandupsBySpace(TENANT, SPACE)[0]!;
    expect(standup.timezone).toBe('Europe/Berlin');
    expect(standup.days).toBe('mon,wed');
  });

  it('manages custom questions', () => {
    const { commands, repo } = makeStack();
    commands.handle(ctx('setup'));
    expect(commands.handle(ctx('questions'))).toContain('What did you do yesterday?');

    const reply = commands.handle(ctx('questions set What shipped? | What is next? | Any blockers?'));
    expect(reply).toContain('1. What shipped?');
    const standup = repo.listStandupsBySpace(TENANT, SPACE)[0]!;
    expect(standup.questions).toEqual(['What shipped?', 'What is next?', 'Any blockers?']);

    expect(commands.handle(ctx('questions set'))).toContain('separated by `|`');
    expect(commands.handle(ctx('questions reset'))).toContain('defaults');
    expect(repo.listStandupsBySpace(TENANT, SPACE)[0]!.questions).toBeNull();
  });

  it('toggles mood, digest and ai', () => {
    const { commands, repo } = makeStack();
    commands.handle(ctx('setup'));
    expect(commands.handle(ctx('mood off'))).toContain('Mood question off');
    expect(commands.handle(ctx('digest on'))).toContain('Weekly digest on');
    expect(commands.handle(ctx('ai on'))).toContain('LLM_PROVIDER');
    expect(commands.handle(ctx('ai banana'))).toContain('`on` or `off`');
    const standup = repo.listStandupsBySpace(TENANT, SPACE)[0]!;
    expect(standup.moodEnabled).toBe(false);
    expect(standup.digestEnabled).toBe(true);
    expect(standup.aiEnabled).toBe(true);
  });

  it('lists open blockers with age', async () => {
    const { commands, repo, service, clock } = makeStack();
    commands.handle(ctx('setup'));
    commands.handle(ctx('add @Alice', [ALICE]));
    const standup = repo.listStandupsBySpace(TENANT, SPACE)[0]!;
    expect(commands.handle(ctx('blockers'))).toContain('No open blockers');

    const run = repo.createRun(standup.id, '2026-06-08', 'k');
    await service.submit(run.id, ALICE.userName, ALICE.displayName, withBlocker('Waiting on keys'));
    clock.set('2026-06-10T12:00');
    const reply = commands.handle(ctx('blockers'));
    expect(reply).toContain('Waiting on keys');
    expect(reply).toContain('(2d old)');
  });

  it('shows trends and export info', () => {
    const { commands } = makeStack();
    commands.handle(ctx('setup'));
    expect(commands.handle(ctx('trends'))).toContain('last 4 weeks');
    const exportReply = commands.handle(ctx('export'));
    expect(exportReply).toContain('/export?standupId=');
    expect(exportReply).toContain('EXPORT_TOKEN');
  });

  it('reports status including today’s progress with away handling', async () => {
    const { commands, repo, scheduler, service, clock } = makeStack();
    commands.handle(ctx('setup'));
    commands.handle(ctx('add @Alice @Bob', [ALICE, BOB]));

    clock.set('2026-06-10T09:30');
    await scheduler.tick();
    const standup = repo.listStandupsBySpace(TENANT, SPACE)[0]!;
    const run = repo.getRun(standup.id, '2026-06-10')!;
    await service.submit(run.id, ALICE.userName, ALICE.displayName, ANSWERS);
    service.skipToday(run.id, BOB.userName);

    const status = commands.handle(ctx('status'));
    expect(status).toContain('1/1 submitted');
    expect(status).toContain('✅ Alice');
    expect(status).toContain('🏖️ Bob');
    expect(status).toContain('Admins: Admin');
  });

  it('rejects unknown commands', () => {
    const { commands } = makeStack();
    commands.handle(ctx('setup'));
    expect(commands.handle(ctx('frobnicate'))).toContain('Unknown command');
  });
});

import { describe, expect, it } from 'vitest';
import type { Mention } from '../src/core/commands.js';
import { makeStack, TENANT } from './helpers.js';

const SPACE = 'spaces/team';

function ctx(text: string, mentions: Mention[] = []) {
  return { tenantId: TENANT, spaceName: SPACE, text, mentions };
}

const ALICE = { userName: 'users/alice', displayName: 'Alice' };
const BOB = { userName: 'users/bob', displayName: 'Bob' };

describe('CommandHandler', () => {
  it('shows help for empty or help text', () => {
    const { commands } = makeStack();
    expect(commands.handle(ctx(''))).toContain('Standup bot commands');
    expect(commands.handle(ctx('help'))).toContain('setup');
  });

  it('requires setup before other commands', () => {
    const { commands } = makeStack();
    expect(commands.handle(ctx('status'))).toContain('Run `setup` first');
  });

  it('creates a standup with setup and prevents duplicates', () => {
    const { commands, repo } = makeStack();
    const reply = commands.handle(ctx('setup Platform Team'));
    expect(reply).toContain('Platform Team');
    expect(repo.getStandupBySpace(TENANT, SPACE)?.name).toBe('Platform Team');
    expect(commands.handle(ctx('setup Again'))).toContain('already exists');
  });

  it('adds, removes and toggles participants via mentions', () => {
    const { commands, repo } = makeStack();
    commands.handle(ctx('setup'));
    expect(commands.handle(ctx('add'))).toContain('Mention the people');

    commands.handle(ctx('add @Alice @Bob', [ALICE, BOB]));
    const standup = repo.getStandupBySpace(TENANT, SPACE)!;
    expect(repo.listParticipants(standup.id)).toHaveLength(2);
    expect(repo.listParticipants(standup.id).every((p) => p.mandatory)).toBe(true);

    expect(commands.handle(ctx('optional @Bob', [BOB]))).toContain('Bob now optional');
    expect(repo.listParticipants(standup.id).find((p) => p.userName === BOB.userName)?.mandatory).toBe(
      false,
    );
    expect(commands.handle(ctx('mandatory @Bob', [BOB]))).toContain('Bob now mandatory');

    expect(commands.handle(ctx('remove @Alice', [ALICE]))).toContain('Removed Alice');
    expect(repo.listParticipants(standup.id)).toHaveLength(1);

    expect(commands.handle(ctx('mandatory @Alice', [ALICE]))).toContain('Not participants');
  });

  it('validates and sets times', () => {
    const { commands, repo } = makeStack();
    commands.handle(ctx('setup'));
    expect(commands.handle(ctx('time 25:00'))).toContain('24h time');
    expect(commands.handle(ctx('time 8:30'))).toContain('24h time');
    expect(commands.handle(ctx('time 08:30'))).toContain('08:30');
    expect(commands.handle(ctx('deadline 10:00'))).toContain('10:00');
    // prompt must stay before deadline
    expect(commands.handle(ctx('deadline 08:00'))).toContain('must be before');
    const standup = repo.getStandupBySpace(TENANT, SPACE)!;
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
    expect(commands.handle(ctx('remind never'))).toContain('number of minutes');
    expect(commands.handle(ctx('remind 30'))).toContain('30 minutes');
    expect(commands.handle(ctx('remind 0'))).toContain('disabled');
    const standup = repo.getStandupBySpace(TENANT, SPACE)!;
    expect(standup.timezone).toBe('Europe/Berlin');
    expect(standup.days).toBe('mon,wed');
    expect(standup.reminderMinutesBefore).toBe(0);
  });

  it('reports status including today’s progress', async () => {
    const { commands, repo, scheduler, service, clock } = makeStack();
    commands.handle(ctx('setup'));
    commands.handle(ctx('add @Alice @Bob', [ALICE, BOB]));

    clock.set('2026-06-10T09:30');
    await scheduler.tick();
    const standup = repo.getStandupBySpace(TENANT, SPACE)!;
    const run = repo.getRun(standup.id, '2026-06-10')!;
    await service.submit(run.id, ALICE.userName, ALICE.displayName, {
      yesterday: 'x',
      today: 'y',
      blockers: 'none',
      mood: 'great',
    });

    const status = commands.handle(ctx('status'));
    expect(status).toContain('1/2 submitted');
    expect(status).toContain('✅ Alice');
    expect(status).toContain('⏳ Bob');
  });

  it('rejects unknown commands', () => {
    const { commands } = makeStack();
    commands.handle(ctx('setup'));
    expect(commands.handle(ctx('frobnicate'))).toContain('Unknown command');
  });
});

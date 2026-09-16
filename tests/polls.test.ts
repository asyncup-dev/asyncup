import { describe, expect, it } from 'bun:test';
import { EventRouter } from '../src/adapters/gchat/events.js';
import type { Mention } from '../src/core/commands.js';
import { makeStack, seedStandup, TENANT } from './helpers.js';

const ADMIN = { userName: 'users/admin', displayName: 'Admin' };
const ALICE = { userName: 'users/alice', displayName: 'Alice' };
const BOB = { userName: 'users/bob', displayName: 'Bob' };

function ctx(text: string, mentions: Mention[] = [], sender: Mention = ADMIN) {
  return { tenantId: TENANT, spaceName: 'spaces/team', text, mentions, sender };
}

function voteEvent(pollId: number, optionIndex: number, user = ALICE) {
  return {
    type: 'CARD_CLICKED',
    common: {
      invokedFunction: 'votePoll',
      parameters: { pollId: String(pollId), optionIndex: String(optionIndex) },
    },
    space: { name: 'spaces/team', type: 'ROOM' },
    user: { name: user.userName, displayName: user.displayName },
  };
}

async function makePollStack() {
  const stack = await makeStack();
  const standup = await seedStandup(stack.repo);
  await stack.repo.addAdmin(standup.id, ADMIN.userName, ADMIN.displayName);
  const router = new EventRouter(
    stack.commands,
    stack.service,
    stack.blockers,
    stack.repo,
    TENANT,
    stack.polls,
  );
  return { ...stack, standup, router };
}

describe('Polls', () => {
  it('creates a poll card in the space from the command', async () => {
    const { commands, adapter, repo, standup } = await makePollStack();
    const reply = await commands.handle(ctx('poll Deploy on Friday? | Yes | No | Only hotfixes'));
    expect(reply).toContain('Poll *#1* posted');

    const posted = adapter.posts.filter((p) => p.kind === 'poll');
    expect(posted).toHaveLength(1);
    const poll = (await repo.getPollById(1))!;
    expect(poll.standupId).toBe(standup.id);
    expect(poll.question).toBe('Deploy on Friday?');
    expect(poll.options).toEqual(['Yes', 'No', 'Only hotfixes']);
    expect(poll.messageName).not.toBeNull();
  });

  it('rejects malformed polls', async () => {
    const { commands } = await makePollStack();
    expect(await commands.handle(ctx('poll Deploy?'))).toContain('2–6 options');
    expect(await commands.handle(ctx('poll Q | a | b | c | d | e | f | g'))).toContain('2–6 options');
  });

  it('records votes via card clicks, updates the card, allows changing your vote', async () => {
    const { commands, router, repo } = await makePollStack();
    await commands.handle(ctx('poll Deploy? | Yes | No'));

    const first: any = await router.handle(voteEvent(1, 0, ALICE));
    expect(first.actionResponse.type).toBe('UPDATE_MESSAGE');
    expect(JSON.stringify(first.cardsV2)).toContain('1 vote');

    await router.handle(voteEvent(1, 0, BOB));
    // Alice changes her mind — replaces, not adds
    const changed: any = await router.handle(voteEvent(1, 1, ALICE));
    expect(changed.actionResponse.type).toBe('UPDATE_MESSAGE');

    const votes = await repo.listPollVotes(1);
    expect(votes).toHaveLength(2);
    expect(votes.find((v) => v.userName === ALICE.userName)?.optionIndex).toBe(1);
  });

  it('closes: creator or admin only, posts results, blocks further votes', async () => {
    const { commands, router, adapter } = await makePollStack();
    await commands.handle(ctx('poll Deploy? | Yes | No', [], ALICE));
    await router.handle(voteEvent(1, 0, ALICE));
    await router.handle(voteEvent(1, 0, BOB));

    expect(await commands.handle(ctx('poll 1 close', [], BOB))).toContain('Only the poll creator');
    expect(await commands.handle(ctx('poll 1 close', [], ALICE))).toContain('closed');

    const results = adapter.posts.filter((p) => p.kind === 'text' && p.text?.includes('Poll results'));
    expect(results).toHaveLength(1);
    expect(results[0]!.text).toContain('Yes: *2* 🏆');
    expect(results[0]!.text).toContain('Alice, Bob');

    const late: any = await router.handle(voteEvent(1, 1, BOB));
    expect(late.text).toContain('closed');
    expect(await commands.handle(ctx('poll 1 close', [], ALICE))).toContain('already closed');
  });

  it('lists open polls and shows results on demand', async () => {
    const { commands, router } = await makePollStack();
    expect(await commands.handle(ctx('polls'))).toContain('No open polls');

    await commands.handle(ctx('poll Deploy? | Yes | No'));
    await router.handle(voteEvent(1, 0, ALICE));

    const list = await commands.handle(ctx('polls'));
    expect(list).toContain('#1 Deploy?');
    expect(list).toContain('1 vote');

    const results = await commands.handle(ctx('poll 1 results'));
    expect(results).toContain('Yes: *1*');
    expect(results).toContain('so far');
  });
});

import { DateTime } from 'luxon';
import type { ChatAdapter } from './adapter.js';
import type { Repo } from '../db/repo.js';
import type { Poll, Standup } from './types.js';

export type VoteResult =
  | { status: 'ok'; poll: Poll; tallies: number[] }
  | { status: 'closed' | 'not_found' | 'bad_option' };

/** Lightweight team polls posted as interactive cards in the report space. */
export class PollService {
  constructor(
    private repo: Repo,
    private adapter: ChatAdapter,
    private now: () => DateTime = () => DateTime.utc(),
  ) {}

  async create(
    standup: Standup,
    question: string,
    options: string[],
    creator: { userName: string; displayName: string },
  ): Promise<Poll> {
    const poll = await this.repo.createPoll({
      standupId: standup.id,
      question,
      options,
      createdBy: creator.userName,
      createdDisplay: creator.displayName,
      at: this.now().toISO()!,
    });
    const messageName = await this.adapter.postPoll(standup, poll, options.map(() => 0));
    if (messageName) await this.repo.setPollMessageName(poll.id, messageName);
    return poll;
  }

  async vote(pollId: number, user: { userName: string; displayName: string }, optionIndex: number): Promise<VoteResult> {
    const poll = await this.repo.getPollById(pollId);
    if (!poll) return { status: 'not_found' };
    if (poll.closedAt) return { status: 'closed' };
    if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= poll.options.length) {
      return { status: 'bad_option' };
    }
    await this.repo.votePoll({
      pollId,
      userName: user.userName,
      displayName: user.displayName,
      optionIndex,
      at: this.now().toISO()!,
    });
    return { status: 'ok', poll, tallies: await this.tallies(poll) };
  }

  /** Creator or a standup admin closes; results post to the space. */
  async close(
    standup: Standup,
    pollId: number,
    by: { userName: string; displayName: string },
  ): Promise<'closed' | 'already_closed' | 'not_allowed' | 'not_found'> {
    const poll = await this.repo.getPollById(pollId);
    if (!poll || poll.standupId !== standup.id) return 'not_found';
    if (poll.closedAt) return 'already_closed';
    if (poll.createdBy !== by.userName && !(await this.repo.isAdmin(standup.id, by.userName))) {
      return 'not_allowed';
    }
    await this.repo.closePoll(pollId, this.now().toISO()!);
    await this.adapter.postText(standup.spaceName, await this.resultsText(poll, true));
    return 'closed';
  }

  async resultsText(poll: Poll, final = false): Promise<string> {
    const votes = await this.repo.listPollVotes(poll.id);
    const max = Math.max(0, ...tallyVotes(poll, votes));
    const lines = poll.options.map((option, i) => {
      const voters = votes.filter((v) => v.optionIndex === i);
      const crown = final && max > 0 && voters.length === max ? ' 🏆' : '';
      const names = voters.length ? ` — ${voters.map((v) => v.displayName).join(', ')}` : '';
      return `${option}: *${voters.length}*${crown}${names}`;
    });
    return `📊 *${final ? 'Poll results' : 'Poll'} #${poll.id}: ${poll.question}*\n${lines.join('\n')}\n_${votes.length} vote${votes.length === 1 ? '' : 's'}${final ? '' : ' so far'}_`;
  }

  async tallies(poll: Poll): Promise<number[]> {
    return tallyVotes(poll, await this.repo.listPollVotes(poll.id));
  }
}

function tallyVotes(poll: Poll, votes: { optionIndex: number }[]): number[] {
  return poll.options.map((_, i) => votes.filter((v) => v.optionIndex === i).length);
}

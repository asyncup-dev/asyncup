import type { ChatAdapter, SpaceInfo, SpaceMember, SpaceMembership, PromptState } from '../../core/adapter.js';
import type { Blocker, Poll, Run, RunSummary, Standup, Submission } from '../../core/types.js';
import type { TimeOffRequest } from '../../core/schedule.js';
import type { EditRequestView } from '../../core/edit-requests.js';
import type { PollCardState, PollCounts, PollView } from '../../core/question-polls.js';

interface SentDm {
  kind: 'prompt' | 'reminder' | 'text' | 'blockerCard' | 'timeOffRequest' | 'editRequest' | 'editApproved';
  userName: string;
  standupId?: number;
  runId?: number;
  blockerId?: number;
  text?: string;
  request?: TimeOffRequest;
  editRequest?: EditRequestView;
  /** A blocker card sent to the person who raised it. */
  owner?: boolean;
}

interface PostedMessage {
  kind: 'parent' | 'submission' | 'summary' | 'update' | 'text' | 'poll' | 'skip' | 'pollSummary';
  spaceName: string;
  threadKey?: string;
  messageName?: string;
  text?: string;
  payload?: Submission | RunSummary | Poll;
  counts?: PollCounts;
  closed?: boolean;
}

/**
 * In-memory adapter for tests and the local demo mode (ADAPTER=fake).
 * Records every interaction and optionally logs it.
 */
export class FakeAdapter implements ChatAdapter {
  dms: SentDm[] = [];
  posts: PostedMessage[] = [];
  /** Users canDm() should report as unreachable (no DM space). */
  unreachable = new Set<string>();
  /** Fixtures for the space picker and roster suggestions. */
  spaces: SpaceInfo[] = [];
  members = new Map<string, SpaceMember[]>();
  /** Google Groups that are members of a space, as `groups/{id}`. */
  spaceGroups = new Map<string, string[]>();
  membershipError: Error | null = null;
  private messageCounter = 0;

  /** Poll cards sent and redrawn, and space summaries redrawn, newest last. */
  pollCards: { userName: string; view: PollView; state: PollCardState; messageName: string }[] = [];
  pollCardUpdates: { messageNames: string[]; view: PollView; state: PollCardState }[] = [];
  pollSummaryUpdates: { messageName: string; counts: PollCounts; closed: boolean }[] = [];

  constructor(private log: ((msg: string) => void) | null = null) {}

  async sendPollCard(userName: string, view: PollView, state: PollCardState): Promise<string | null> {
    const messageName = `messages/fake-${++this.messageCounter}`;
    this.pollCards.push({ userName, view, state, messageName });
    this.log?.(`DM poll "${view.title}" (${state.kind}) → ${userName}`);
    return messageName;
  }

  async updatePollCards(messageNames: string[], view: PollView, state: PollCardState): Promise<void> {
    this.pollCardUpdates.push({ messageNames, view, state });
  }

  async postPollSummary(standup: Standup, view: PollView, counts: PollCounts, closed: boolean): Promise<string | null> {
    const messageName = `messages/fake-${++this.messageCounter}`;
    this.posts.push({ kind: 'pollSummary', spaceName: standup.spaceName, threadKey: `qpoll-${view.id}`, messageName, counts, closed });
    this.log?.(`Poll "${view.title}" → ${standup.spaceName}`);
    return messageName;
  }

  async updatePollSummary(messageName: string, _view: PollView, counts: PollCounts, closed: boolean): Promise<void> {
    this.pollSummaryUpdates.push({ messageName, counts, closed });
  }

  async sendStandupPrompt(userName: string, standup: Standup, run: Run): Promise<string | null> {
    this.dms.push({ kind: 'prompt', userName, standupId: standup.id, runId: run.id });
    this.log?.(`DM prompt → ${userName} (standup "${standup.name}", ${run.date})`);
    return `messages/fake-${++this.messageCounter}`;
  }

  async sendReminder(userName: string, standup: Standup, run: Run): Promise<string | null> {
    this.dms.push({ kind: 'reminder', userName, standupId: standup.id, runId: run.id });
    this.log?.(`DM reminder → ${userName} (standup "${standup.name}", ${run.date})`);
    return `messages/fake-${++this.messageCounter}`;
  }

  /** Card rewrites, newest last: which messages, and the state they now show. */
  cardUpdates: { messageNames: string[]; runId: number; state: PromptState }[] = [];

  async updateStandupCards(messageNames: string[], _standup: Standup, run: Run, state: PromptState): Promise<void> {
    this.cardUpdates.push({ messageNames, runId: run.id, state });
  }

  async postThreadParent(standup: Standup, run: Run): Promise<void> {
    this.posts.push({ kind: 'parent', spaceName: standup.spaceName, threadKey: run.threadKey });
    this.log?.(`Thread parent → ${standup.spaceName} [${run.threadKey}]`);
  }

  async postSubmission(standup: Standup, run: Run, submission: Submission): Promise<string | null> {
    const messageName = `messages/fake-${++this.messageCounter}`;
    this.posts.push({
      kind: 'submission',
      spaceName: standup.spaceName,
      threadKey: run.threadKey,
      messageName,
      payload: submission,
    });
    this.log?.(`Submission by ${submission.displayName} → ${standup.spaceName} [${run.threadKey}]`);
    return messageName;
  }

  async updateSubmission(standup: Standup, submission: Submission): Promise<void> {
    this.posts.push({
      kind: 'update',
      spaceName: standup.spaceName,
      messageName: submission.messageName ?? undefined,
      payload: submission,
    });
    this.log?.(`Submission updated by ${submission.displayName} (${submission.messageName})`);
  }

  async postSummary(standup: Standup, run: Run, summary: RunSummary): Promise<void> {
    this.posts.push({
      kind: 'summary',
      spaceName: standup.spaceName,
      threadKey: run.threadKey,
      payload: summary,
    });
    this.log?.(
      `Summary → ${standup.spaceName} [${run.threadKey}]: ${summary.mandatorySubmitted}/${summary.mandatoryTotal}` +
        (summary.missingMandatory.length ? ` missing: ${summary.missingMandatory.join(', ')}` : ''),
    );
  }

  async postSkip(standup: Standup, run: Run, displayName: string, note: string): Promise<string | null> {
    const messageName = `messages/fake-${++this.messageCounter}`;
    this.posts.push({ kind: 'skip', spaceName: standup.spaceName, threadKey: run.threadKey, messageName, text: `${displayName}: ${note}` });
    this.log?.(`Skip by ${displayName} → ${standup.spaceName} [${run.threadKey}]: ${note}`);
    return messageName;
  }

  /** Message names removed with deleteMessage, oldest first. */
  deleted: string[] = [];

  async deleteMessage(messageName: string): Promise<void> {
    this.deleted.push(messageName);
  }

  async postText(spaceName: string, text: string, threadKey?: string): Promise<void> {
    this.posts.push({ kind: 'text', spaceName, threadKey, text });
    this.log?.(`Text → ${spaceName}${threadKey ? ` [${threadKey}]` : ''}: ${text.split('\n')[0]}`);
  }

  async sendDm(userName: string, text: string): Promise<void> {
    this.dms.push({ kind: 'text', userName, text });
    this.log?.(`DM text → ${userName}: ${text.split('\n')[0]}`);
  }

  async sendBlockerCard(userName: string, standup: Standup, blocker: Blocker, note: string, owner = false): Promise<void> {
    this.dms.push({ kind: 'blockerCard', userName, standupId: standup.id, blockerId: blocker.id, text: note, ...(owner ? { owner } : {}) });
    this.log?.(`DM blocker card #${blocker.id} → ${userName} (${note})`);
  }

  async sendTimeOffRequest(managerUserName: string, request: TimeOffRequest): Promise<void> {
    this.log?.(`time-off request to ${managerUserName}: ${request.person.displayName} ${request.dates.join(',')}`);
    this.dms.push({ kind: 'timeOffRequest', userName: managerUserName, standupId: request.standup.id, request });
  }

  /** Edit request card rewrites, newest last. */
  editCardUpdates: { messageNames: string[]; request: EditRequestView }[] = [];
  /** Makes edit request cards fail to send or redraw. */
  failEditCards = false;

  async sendEditRequest(managerUserName: string, request: EditRequestView): Promise<string | null> {
    if (this.failEditCards) throw new Error('Chat refused the card');
    this.dms.push({ kind: 'editRequest', userName: managerUserName, editRequest: request });
    this.log?.(`edit request to ${managerUserName}: ${request.person.displayName} ${request.date}`);
    return `messages/fake-${++this.messageCounter}`;
  }

  async updateEditRequestCards(messageNames: string[], request: EditRequestView): Promise<void> {
    if (this.failEditCards) throw new Error('Chat refused the card');
    this.editCardUpdates.push({ messageNames, request });
  }

  async sendEditApproved(userName: string, request: EditRequestView): Promise<void> {
    if (this.failEditCards) throw new Error('Chat refused the card');
    this.dms.push({ kind: 'editApproved', userName, editRequest: request });
  }

  async canDm(userName: string): Promise<boolean> {
    return !this.unreachable.has(userName);
  }

  async listSpaces(): Promise<SpaceInfo[]> {
    return [...this.spaces];
  }

  async listSpaceMembers(spaceName: string): Promise<SpaceMember[]> {
    return [...(this.members.get(spaceName) ?? [])];
  }

  async spaceMembership(spaceName: string): Promise<SpaceMembership> {
    if (this.membershipError) throw this.membershipError;
    return { people: [...(this.members.get(spaceName) ?? [])], groups: [...(this.spaceGroups.get(spaceName) ?? [])] };
  }

  async postPoll(standup: Standup, poll: Poll, _tallies: number[]): Promise<string | null> {
    const messageName = `messages/fake-${++this.messageCounter}`;
    this.posts.push({ kind: 'poll', spaceName: standup.spaceName, messageName, payload: poll });
    this.log?.(`Poll #${poll.id} "${poll.question}" → ${standup.spaceName}`);
    return messageName;
  }
}

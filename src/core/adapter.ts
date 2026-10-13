import type { Blocker, Poll, Run, RunSummary, Standup, Submission } from './types.js';
import type { TimeOffRequest } from './schedule.js';

/** A space the app has been added to. */
export interface SpaceInfo {
  name: string;
  displayName: string;
}

/** A human member of a space, as a roster candidate. */
export interface SpaceMember {
  userName: string;
  displayName: string;
}

/**
 * Platform abstraction. The core never touches Google Chat (or Slack/Teams)
 * APIs directly — only this interface. New platforms = new implementation.
 */
/** Where someone stands on a run, as their prompt cards show it. */
export type PromptState = { kind: 'open' } | { kind: 'submitted'; at: string; late: boolean } | { kind: 'skipped'; note: string | null };

export interface ChatAdapter {
  /** DM the user a prompt with a way to fill in the standup form; returns the card's message name when known. */
  sendStandupPrompt(userName: string, standup: Standup, run: Run): Promise<string | null>;

  /** DM a reminder to someone who has not submitted yet; returns the card's message name when known. */
  sendReminder(userName: string, standup: Standup, run: Run): Promise<string | null>;

  /** Rewrite the prompt, reminder and nudge cards already sent for a run to show where the person stands. */
  updateStandupCards(messageNames: string[], standup: Standup, run: Run, state: PromptState): Promise<void>;

  /** Post the parent message that opens the day's thread in the report space. */
  postThreadParent(standup: Standup, run: Run): Promise<void>;

  /** Tell the day's thread someone is skipping and why; returns the message name so an undo can remove it. */
  postSkip(standup: Standup, run: Run, displayName: string, note: string): Promise<string | null>;

  /** Remove a message the app posted. */
  deleteMessage(messageName: string): Promise<void>;

  /**
   * Post one person's submission as a reply in the day's thread.
   * Returns the platform message id (used to update the card on edits), or null.
   */
  postSubmission(standup: Standup, run: Run, submission: Submission): Promise<string | null>;

  /** Replace a previously posted submission card (submission.messageName is set). */
  updateSubmission(standup: Standup, submission: Submission): Promise<void>;

  /** Post the end-of-standup report (count + missing names) in the day's thread. */
  postSummary(standup: Standup, run: Run, summary: RunSummary): Promise<void>;

  /** Post plain text to a space — weekly digests, AI summaries, etc. */
  postText(spaceName: string, text: string, threadKey?: string): Promise<void>;

  /** Plain-text direct message — used for blocker escalation pings. */
  sendDm(userName: string, text: string): Promise<void>;

  /**
   * Interactive blocker card (Acknowledge / Add update / Resolve buttons),
   * DMed when someone is tagged on a blocker or nudged about one.
   */
  sendBlockerCard(userName: string, standup: Standup, blocker: Blocker, note: string, owner?: boolean): Promise<void>;

  /** DM a manager a time-off request with Approve / Decline. */
  sendTimeOffRequest(managerUserName: string, request: TimeOffRequest): Promise<void>;

  /**
   * Whether the platform can DM this user right now (e.g. the Chat app is
   * installed for them). Lets `add` warn immediately instead of failing
   * silently at prompt time.
   */
  canDm(userName: string): Promise<boolean>;

  /**
   * Interactive poll card in the report space (one vote button per option).
   * Returns the platform message id, or null.
   */
  postPoll(standup: Standup, poll: Poll, tallies: number[]): Promise<string | null>;

  /** Spaces the app is a member of — the create-standup space picker. */
  listSpaces(): Promise<SpaceInfo[]>;

  /** Human members of a space — roster suggestions when creating a standup. */
  listSpaceMembers(spaceName: string): Promise<SpaceMember[]>;
}

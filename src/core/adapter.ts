import type { Blocker, Run, RunSummary, Standup, Submission } from './types.js';

/**
 * Platform abstraction. The core never touches Google Chat (or Slack/Teams)
 * APIs directly — only this interface. New platforms = new implementation.
 */
export interface ChatAdapter {
  /** DM the user a prompt with a way to fill in the standup form. */
  sendStandupPrompt(userName: string, standup: Standup, run: Run): Promise<void>;

  /** DM a reminder to someone who has not submitted yet. */
  sendReminder(userName: string, standup: Standup, run: Run): Promise<void>;

  /** Post the parent message that opens the day's thread in the report space. */
  postThreadParent(standup: Standup, run: Run): Promise<void>;

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
  sendBlockerCard(userName: string, standup: Standup, blocker: Blocker, note: string): Promise<void>;
}

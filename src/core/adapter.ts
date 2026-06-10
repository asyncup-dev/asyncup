import type { Run, RunSummary, Standup, Submission } from './types.js';

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

  /** Post one person's submission as a reply in the day's thread. */
  postSubmission(standup: Standup, run: Run, submission: Submission): Promise<void>;

  /** Post the end-of-standup report (count + missing names) in the day's thread. */
  postSummary(standup: Standup, run: Run, summary: RunSummary): Promise<void>;
}

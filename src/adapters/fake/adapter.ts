import type { ChatAdapter } from '../../core/adapter.js';
import type { Run, RunSummary, Standup, Submission } from '../../core/types.js';

interface SentDm {
  kind: 'prompt' | 'reminder';
  userName: string;
  standupId: number;
  runId: number;
}

interface PostedMessage {
  kind: 'parent' | 'submission' | 'summary';
  spaceName: string;
  threadKey: string;
  payload?: Submission | RunSummary;
}

/**
 * In-memory adapter for tests and the local demo mode (ADAPTER=fake).
 * Records every interaction and optionally logs it.
 */
export class FakeAdapter implements ChatAdapter {
  dms: SentDm[] = [];
  posts: PostedMessage[] = [];

  constructor(private log: ((msg: string) => void) | null = null) {}

  async sendStandupPrompt(userName: string, standup: Standup, run: Run): Promise<void> {
    this.dms.push({ kind: 'prompt', userName, standupId: standup.id, runId: run.id });
    this.log?.(`DM prompt → ${userName} (standup "${standup.name}", ${run.date})`);
  }

  async sendReminder(userName: string, standup: Standup, run: Run): Promise<void> {
    this.dms.push({ kind: 'reminder', userName, standupId: standup.id, runId: run.id });
    this.log?.(`DM reminder → ${userName} (standup "${standup.name}", ${run.date})`);
  }

  async postThreadParent(standup: Standup, run: Run): Promise<void> {
    this.posts.push({ kind: 'parent', spaceName: standup.spaceName, threadKey: run.threadKey });
    this.log?.(`Thread parent → ${standup.spaceName} [${run.threadKey}]`);
  }

  async postSubmission(standup: Standup, run: Run, submission: Submission): Promise<void> {
    this.posts.push({
      kind: 'submission',
      spaceName: standup.spaceName,
      threadKey: run.threadKey,
      payload: submission,
    });
    this.log?.(`Submission by ${submission.displayName} → ${standup.spaceName} [${run.threadKey}]`);
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
}

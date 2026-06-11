import { auth as chatAuth, chat, type chat_v1 } from '@googleapis/chat';
import type { ChatAdapter } from '../../core/adapter.js';
import type { SettingsService } from '../../core/settings.js';
import type { Repo } from '../../db/repo.js';
import type { Blocker, Run, RunSummary, Standup, Submission } from '../../core/types.js';
import {
  blockerCard,
  promptMessage,
  reminderMessage,
  submissionMessage,
  summaryText,
  threadParentText,
} from './cards.js';

export class GoogleChatAdapter implements ChatAdapter {
  private client: chat_v1.Chat | null = null;

  constructor(
    private repo: Repo,
    private settings: SettingsService,
  ) {
    settings.onChange(() => {
      this.client = null;
    });
  }

  /** Auth comes from the pasted service-account JSON, falling back to ADC. */
  private async getClient(): Promise<chat_v1.Chat> {
    if (this.client) return this.client;
    const { serviceAccountJson } = await this.settings.get();
    const scopes = ['https://www.googleapis.com/auth/chat.bot'];
    const auth = serviceAccountJson
      ? new chatAuth.GoogleAuth({ credentials: JSON.parse(serviceAccountJson), scopes })
      : new chatAuth.GoogleAuth({ scopes });
    this.client = chat({ version: 'v1', auth });
    return this.client;
  }

  async sendStandupPrompt(userName: string, standup: Standup, run: Run): Promise<void> {
    const dm = await this.ensureDmSpace(userName);
    await (await this.getClient()).spaces.messages.create({ parent: dm, requestBody: promptMessage(standup, run) });
  }

  async sendReminder(userName: string, standup: Standup, run: Run): Promise<void> {
    const dm = await this.ensureDmSpace(userName);
    await (await this.getClient()).spaces.messages.create({ parent: dm, requestBody: reminderMessage(standup, run) });
  }

  async postThreadParent(standup: Standup, run: Run): Promise<void> {
    await this.postInThread(standup.spaceName, run.threadKey, { text: threadParentText(standup, run) });
  }

  async postSubmission(standup: Standup, run: Run, submission: Submission): Promise<string | null> {
    return this.postInThread(
      standup.spaceName,
      run.threadKey,
      submissionMessage(submission, standup.moodAnonymous),
    );
  }

  async updateSubmission(standup: Standup, submission: Submission): Promise<void> {
    await (await this.getClient()).spaces.messages.update({
      name: submission.messageName!,
      updateMask: 'cardsV2',
      requestBody: submissionMessage(submission, standup.moodAnonymous),
    });
  }

  async postSummary(standup: Standup, run: Run, summary: RunSummary): Promise<void> {
    await this.postInThread(standup.spaceName, run.threadKey, { text: summaryText(summary) });
  }

  async postText(spaceName: string, text: string, threadKey?: string): Promise<void> {
    if (threadKey) {
      await this.postInThread(spaceName, threadKey, { text });
      return;
    }
    await (await this.getClient()).spaces.messages.create({ parent: spaceName, requestBody: { text } });
  }

  async sendDm(userName: string, text: string): Promise<void> {
    const dm = await this.ensureDmSpace(userName);
    await (await this.getClient()).spaces.messages.create({ parent: dm, requestBody: { text } });
  }

  async sendBlockerCard(userName: string, standup: Standup, blocker: Blocker, note: string): Promise<void> {
    const dm = await this.ensureDmSpace(userName);
    await (await this.getClient()).spaces.messages.create({ parent: dm, requestBody: blockerCard(standup, blocker, note) });
  }

  private async postInThread(
    spaceName: string,
    threadKey: string,
    body: chat_v1.Schema$Message,
  ): Promise<string | null> {
    const res = await (await this.getClient()).spaces.messages.create({
      parent: spaceName,
      messageReplyOption: 'REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD',
      requestBody: { ...body, thread: { threadKey } },
    });
    return res.data.name ?? null;
  }

  /**
   * The DM between the app and a user exists once the app is installed for
   * that user (admin install or the user adding it themselves). We cache the
   * space name to avoid a lookup on every send.
   */
  private async ensureDmSpace(userName: string): Promise<string> {
    const cached = await this.repo.getDmSpace(userName);
    if (cached) return cached;
    try {
      const res = await (await this.getClient()).spaces.findDirectMessage({ name: userName });
      const spaceName = res.data.name!;
      await this.repo.setDmSpace(userName, spaceName);
      return spaceName;
    } catch (err: any) {
      if (err?.response?.status === 404 || err?.code === 404) {
        throw new Error(
          `No DM space with ${userName}. Install the Chat app for this user ` +
            `(Admin Console → Apps → Google Workspace Marketplace apps, or have them add the app).`,
        );
      }
      throw err;
    }
  }
}

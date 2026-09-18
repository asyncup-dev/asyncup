import { auth as chatAuth, chat, type chat_v1 } from '@googleapis/chat';
import type { ChatAdapter, SpaceInfo, SpaceMember } from '../../core/adapter.js';
import type { SettingsService } from '../../core/settings.js';
import { chatEndpointUrl } from './addon.js';
import type { TimeOffRequest } from '../../core/schedule.js';
import type { Repo } from '../../db/repo.js';
import type { Blocker, Poll, Run, RunSummary, Standup, Submission } from '../../core/types.js';
import {
  blockerCard,
  timeOffRequestCard,
  pollMessage,
  promptMessage,
  reminderMessage,
  submissionMessage,
  summaryText,
  threadParentText,
} from './cards.js';

export type ChatAuth = InstanceType<typeof chatAuth.GoogleAuth>;
export type ChatClientFactory = (auth: ChatAuth) => chat_v1.Chat;

export function createChatClient(auth: ChatAuth): chat_v1.Chat {
  return chat({ version: 'v1', auth });
}

export class GoogleChatAdapter implements ChatAdapter {
  private client: chat_v1.Chat | null = null;

  constructor(
    private repo: Repo,
    private settings: SettingsService,
    private createClient: ChatClientFactory = createChatClient,
  ) {
    settings.onChange(() => {
      this.client = null;
    });
  }

  private async endpoint(): Promise<string | null> {
    return chatEndpointUrl((await this.settings.get()).chatAudience);
  }

  /** Auth comes from the pasted service-account JSON, falling back to ADC. */
  private async getClient(): Promise<chat_v1.Chat> {
    if (this.client) return this.client;
    const { serviceAccountJson } = await this.settings.get();
    const scopes = ['https://www.googleapis.com/auth/chat.bot'];
    const auth = serviceAccountJson
      ? new chatAuth.GoogleAuth({ credentials: JSON.parse(serviceAccountJson), scopes })
      : new chatAuth.GoogleAuth({ scopes });
    this.client = this.createClient(auth);
    return this.client;
  }

  async sendStandupPrompt(userName: string, standup: Standup, run: Run): Promise<void> {
    const dm = await this.ensureDmSpace(userName);
    await (await this.getClient()).spaces.messages.create({ parent: dm, requestBody: promptMessage(standup, run, await this.endpoint()) });
  }

  async sendReminder(userName: string, standup: Standup, run: Run): Promise<void> {
    const dm = await this.ensureDmSpace(userName);
    await (await this.getClient()).spaces.messages.create({ parent: dm, requestBody: reminderMessage(standup, run, await this.endpoint()) });
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
    await (await this.getClient()).spaces.messages.create({ parent: dm, requestBody: blockerCard(standup, blocker, note, await this.endpoint()) });
  }

  async sendTimeOffRequest(managerUserName: string, request: TimeOffRequest): Promise<void> {
    const dm = await this.ensureDmSpace(managerUserName);
    await (await this.getClient()).spaces.messages.create({ parent: dm, requestBody: timeOffRequestCard(request, await this.endpoint()) });
  }

  async canDm(userName: string): Promise<boolean> {
    try {
      await this.ensureDmSpace(userName);
      return true;
    } catch {
      return false;
    }
  }

  async postPoll(standup: Standup, poll: Poll, tallies: number[]): Promise<string | null> {
    const res = await (await this.getClient()).spaces.messages.create({
      parent: standup.spaceName,
      requestBody: pollMessage(poll, tallies, false, await this.endpoint()),
    });
    return res.data.name ?? null;
  }

  /** Both list calls accept app credentials with the chat.bot scope; pages are 1000 wide. */
  async listSpaces(): Promise<SpaceInfo[]> {
    const client = await this.getClient();
    const spaces: SpaceInfo[] = [];
    let pageToken: string | undefined;
    do {
      const res = await client.spaces.list({ pageSize: 1000, filter: 'spaceType = "SPACE"', pageToken });
      for (const s of res.data.spaces ?? []) {
        if (s.name) spaces.push({ name: s.name, displayName: s.displayName || s.name });
      }
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
    return spaces;
  }

  async listSpaceMembers(spaceName: string): Promise<SpaceMember[]> {
    const client = await this.getClient();
    const members: SpaceMember[] = [];
    let pageToken: string | undefined;
    do {
      const res = await client.spaces.members.list({ parent: spaceName, pageSize: 1000, filter: 'member.type = "HUMAN"', pageToken });
      for (const m of res.data.memberships ?? []) {
        const name = m.member?.name;
        if (name) members.push({ userName: name, displayName: m.member?.displayName || name });
      }
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
    return members;
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

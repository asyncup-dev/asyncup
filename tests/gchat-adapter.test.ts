import { describe, expect, it } from 'bun:test';
import { auth as chatAuth, type chat_v1 } from '@googleapis/chat';
import { createChatClient, GoogleChatAdapter } from '../src/adapters/gchat/adapter.js';
import type { Blocker, Poll, Run, RunSummary, Standup, Submission } from '../src/core/types.js';
import { makeStack } from './helpers.js';

const standup: Standup = {
  id: 1,
  tenantId: 'default',
  spaceName: 'spaces/team',
  name: 'Daily Standup',
  promptTime: '09:30',
  deadlineTime: '11:30',
  reminderMinutesBefore: 60,
  timezone: 'Asia/Kolkata',
  days: 'mon,tue,wed,thu,fri',
  questions: null,
  moodEnabled: true,
  moodAnonymous: false,
  digestEnabled: false,
  escalateUserName: null,
  escalateDisplayName: null,
  escalateAfterDays: 0,
  webhookUrl: null,
  active: true,
};

const run: Run = { id: 7, standupId: 1, date: '2026-06-10', threadKey: 'standup-1-2026-06-10', status: 'open' };

const submission: Submission = {
  id: 1,
  runId: 7,
  userName: 'users/alice',
  displayName: 'Alice',
  answers: [
    { question: 'What did you do yesterday?', answer: 'Auth refactor' },
    { question: 'What will you do today?', answer: 'Billing webhooks' },
    { question: 'Any blockers?', answer: 'none' },
  ],
  mood: 'great',
  late: false,
  submittedAt: '2026-06-10T04:30:00Z',
  editedAt: null,
  messageName: 'spaces/team/messages/sub-1',
};

const summary: RunSummary = {
  standupName: 'Daily Standup',
  date: '2026-06-10',
  teamMood: null,
  mandatoryTotal: 2,
  mandatorySubmitted: 2,
  missingMandatory: [],
  away: [],
  optionalSubmitted: 0,
  lateCount: 0,
  openBlockers: 0,
};

const blocker: Blocker = {
  id: 3,
  standupId: 1,
  userName: 'users/alice',
  displayName: 'Alice',
  text: 'Waiting on API keys',
  openedRunId: 7,
  openedDate: '2026-06-10',
  resolvedRunId: null,
  resolvedDate: null,
  resolvedBy: null,
  escalatedAt: null,
};

const poll: Poll = {
  id: 4,
  standupId: 1,
  question: 'Retro on Friday?',
  options: ['Yes', 'No'],
  createdBy: 'users/admin',
  createdDisplay: 'Admin',
  messageName: null,
  closedAt: null,
};

const SERVICE_ACCOUNT = {
  type: 'service_account',
  client_email: 'asyncup@example.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----\n',
};

type Call = { method: 'findDirectMessage' | 'create' | 'update'; params: any };

function fakeChat() {
  const calls: Call[] = [];
  const state = {
    findDirectMessage: async (params: any): Promise<any> => ({
      data: { name: `spaces/dm-${params.name.split('/')[1]}` },
    }),
    createdName: (n: number): string | undefined => `spaces/x/messages/${n}`,
  };
  let created = 0;
  const client = {
    spaces: {
      findDirectMessage: async (params: any) => {
        calls.push({ method: 'findDirectMessage', params });
        return state.findDirectMessage(params);
      },
      messages: {
        create: async (params: any) => {
          calls.push({ method: 'create', params });
          return { data: { name: state.createdName(++created) } };
        },
        update: async (params: any) => {
          calls.push({ method: 'update', params });
          return { data: {} };
        },
      },
    },
  };
  return { client: client as unknown as chat_v1.Chat, calls, state };
}

async function makeAdapter() {
  const { repo, settings } = await makeStack();
  const { client, calls, state } = fakeChat();
  const auths: any[] = [];
  const gchat = new GoogleChatAdapter(repo, settings, (auth) => {
    auths.push(auth);
    return client;
  });
  return { repo, settings, gchat, calls, state, auths };
}

describe('GoogleChatAdapter', () => {
  it('DMs the prompt and reminder, looking the DM space up once and caching it', async () => {
    const { gchat, calls, repo } = await makeAdapter();
    await gchat.sendStandupPrompt('users/alice', standup, run);

    expect(calls.map((c) => c.method)).toEqual(['findDirectMessage', 'create']);
    expect(calls[0]!.params).toEqual({ name: 'users/alice' });
    expect(calls[1]!.params.parent).toBe('spaces/dm-alice');
    expect(calls[1]!.params.requestBody.cardsV2[0].cardId).toBe('standup-prompt-7');
    expect(await repo.getDmSpace('users/alice')).toBe('spaces/dm-alice');

    await gchat.sendReminder('users/alice', standup, run);
    expect(calls.map((c) => c.method)).toEqual(['findDirectMessage', 'create', 'create']);
    expect(calls[2]!.params.parent).toBe('spaces/dm-alice');
    expect(calls[2]!.params.requestBody.cardsV2[0].cardId).toBe('standup-reminder-7');
  });

  it('authenticates with ADC by default, the pasted service account once set, and rebuilds on change', async () => {
    const { gchat, settings, auths } = await makeAdapter();
    await gchat.sendDm('users/alice', 'hi');
    await gchat.sendDm('users/alice', 'again');
    expect(auths).toHaveLength(1);
    expect(auths[0].jsonContent).toBeNull();
    expect(auths[0].scopes).toEqual(['https://www.googleapis.com/auth/chat.bot']);

    await settings.update({ serviceAccountJson: JSON.stringify(SERVICE_ACCOUNT) });
    await gchat.sendDm('users/alice', 'after rotation');
    expect(auths).toHaveLength(2);
    expect(auths[1].jsonContent).toEqual(SERVICE_ACCOUNT);
    expect(auths[1].scopes).toEqual(['https://www.googleapis.com/auth/chat.bot']);
  });

  it('posts the thread parent, submissions and the wrap-up as replies keyed to the run thread', async () => {
    const { gchat, calls } = await makeAdapter();
    await gchat.postThreadParent(standup, run);
    const name = await gchat.postSubmission(standup, run, submission);
    await gchat.postSummary(standup, run, summary);

    expect(calls.map((c) => c.method)).toEqual(['create', 'create', 'create']);
    for (const call of calls) {
      expect(call.params.parent).toBe('spaces/team');
      expect(call.params.messageReplyOption).toBe('REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD');
      expect(call.params.requestBody.thread).toEqual({ threadKey: 'standup-1-2026-06-10' });
    }
    expect(calls[0]!.params.requestBody.text).toContain('Daily Standup');
    expect(calls[1]!.params.requestBody.cardsV2[0].cardId).toBe('submission-1');
    expect(name).toBe('spaces/x/messages/2');
    expect(calls[2]!.params.requestBody.text).toContain('wrap-up');
  });

  it('hides the mood on posted submission cards when the standup is anonymous', async () => {
    const { gchat, calls } = await makeAdapter();
    await gchat.postSubmission({ ...standup, moodAnonymous: true }, run, submission);
    expect(calls[0]!.params.requestBody.cardsV2[0].card.header.title).toBe('📝 Alice');
  });

  it('updates an existing submission card in place', async () => {
    const { gchat, calls } = await makeAdapter();
    await gchat.updateSubmission(standup, submission);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('update');
    expect(calls[0]!.params.name).toBe('spaces/team/messages/sub-1');
    expect(calls[0]!.params.updateMask).toBe('cardsV2');
    expect(calls[0]!.params.requestBody.cardsV2[0].card.header.title).toBe('😄 Alice');
  });

  it('posts plain text to a space directly, or into a thread when a key is given', async () => {
    const { gchat, calls } = await makeAdapter();
    await gchat.postText('spaces/team', 'top level');
    await gchat.postText('spaces/team', 'in thread', 'k1');

    expect(calls[0]!.params).toEqual({ parent: 'spaces/team', requestBody: { text: 'top level' } });
    expect(calls[1]!.params.requestBody).toEqual({ text: 'in thread', thread: { threadKey: 'k1' } });
    expect(calls[1]!.params.messageReplyOption).toBe('REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD');
  });

  it('sends DMs and blocker cards to the user DM space', async () => {
    const { gchat, calls } = await makeAdapter();
    await gchat.sendDm('users/bob', 'hello bob');
    await gchat.sendBlockerCard('users/bob', standup, blocker, 'Alice tagged you');

    const creates = calls.filter((c) => c.method === 'create');
    expect(creates).toHaveLength(2);
    expect(creates[0]!.params).toEqual({ parent: 'spaces/dm-bob', requestBody: { text: 'hello bob' } });
    expect(creates[1]!.params.parent).toBe('spaces/dm-bob');
    const card = creates[1]!.params.requestBody.cardsV2[0];
    expect(card.cardId).toBe('blocker-3');
    expect(card.card.header.subtitle).toBe('Alice tagged you');
  });

  it('posts a poll to the space and returns the message name, or null when absent', async () => {
    const { gchat, calls, state } = await makeAdapter();
    expect(await gchat.postPoll(standup, poll, [1, 0])).toBe('spaces/x/messages/1');
    expect(calls[0]!.params.parent).toBe('spaces/team');
    expect(calls[0]!.params.messageReplyOption).toBeUndefined();
    expect(calls[0]!.params.requestBody.cardsV2[0].cardId).toBe('poll-4');

    state.createdName = () => undefined;
    expect(await gchat.postPoll(standup, poll, [1, 0])).toBeNull();
    expect(await gchat.postSubmission(standup, run, submission)).toBeNull();
  });

  it('explains a missing DM space on 404 and passes other errors through', async () => {
    const { gchat, state, repo } = await makeAdapter();

    state.findDirectMessage = async () => {
      throw { code: 404 };
    };
    await expect(gchat.sendDm('users/zed', 'x')).rejects.toThrow('No DM space with users/zed');
    expect(await gchat.canDm('users/zed')).toBe(false);
    expect(await repo.getDmSpace('users/zed')).toBeNull();

    state.findDirectMessage = async () => {
      throw { response: { status: 404 } };
    };
    await expect(gchat.sendDm('users/zed', 'x')).rejects.toThrow('Install the Chat app');

    state.findDirectMessage = async () => {
      throw new Error('quota exceeded');
    };
    await expect(gchat.sendDm('users/zed', 'x')).rejects.toThrow('quota exceeded');
    expect(await gchat.canDm('users/zed')).toBe(false);

    state.findDirectMessage = async () => ({ data: { name: 'spaces/dm-zed' } });
    expect(await gchat.canDm('users/zed')).toBe(true);
  });
});

describe('createChatClient', () => {
  it('builds a Chat v1 client bound to the given auth', () => {
    const auth = new chatAuth.GoogleAuth({ scopes: ['https://www.googleapis.com/auth/chat.bot'] });
    const client = createChatClient(auth);
    expect(typeof client.spaces.messages.create).toBe('function');
    expect(typeof client.spaces.findDirectMessage).toBe('function');
    expect(client.context._options.auth).toBe(auth);
  });
});

import type { CommandHandler, Mention } from '../../core/commands.js';
import type { StandupService } from '../../core/standup-service.js';
import { MOODS, type Mood, type SubmissionAnswers } from '../../core/types.js';
import { OPEN_DIALOG_FN, standupDialog, SUBMIT_DIALOG_FN } from './cards.js';

/**
 * Routes Google Chat interaction events (MESSAGE, CARD_CLICKED, dialog
 * submits) to the core, and shapes the synchronous JSON response.
 * Event reference: https://developers.google.com/workspace/chat/receive-respond-interactions
 */
export class EventRouter {
  constructor(
    private commands: CommandHandler,
    private service: StandupService,
    private tenantId: string,
  ) {}

  async handle(event: any): Promise<object> {
    switch (event?.type) {
      case 'ADDED_TO_SPACE':
        return this.onAddedToSpace(event);
      case 'MESSAGE':
        return this.onMessage(event);
      case 'CARD_CLICKED':
        return this.onCardClicked(event);
      default:
        return {};
    }
  }

  private onAddedToSpace(event: any): object {
    if (isDm(event)) {
      return {
        text: "👋 Hi! When your team's standup is due you'll get a card here with a *Fill standup* button.",
      };
    }
    return {
      text: '👋 Thanks for adding me! Mention me with `setup` to create a standup that reports to this space, or `help` for all commands.',
    };
  }

  private onMessage(event: any): object {
    if (isDm(event)) {
      return {
        text: 'I work via the standup form — when a standup is due, you\'ll get a card here with a *Fill standup* button. Configuration happens in the team space (mention me with `help` there).',
      };
    }
    const text: string = event.message?.argumentText ?? event.message?.text ?? '';
    const reply = this.commands.handle({
      tenantId: this.tenantId,
      spaceName: event.space?.name ?? '',
      text,
      mentions: extractMentions(event),
    });
    return { text: reply };
  }

  private async onCardClicked(event: any): Promise<object> {
    const fn = event.common?.invokedFunction;
    const runId = Number(getParameter(event, 'runId'));

    if (fn === OPEN_DIALOG_FN) {
      if (!Number.isInteger(runId)) return dialogError('This standup prompt is no longer valid.');
      return standupDialog(runId);
    }

    if (fn === SUBMIT_DIALOG_FN) {
      return this.onDialogSubmit(event, runId);
    }

    return {};
  }

  private async onDialogSubmit(event: any, runId: number): Promise<object> {
    const yesterday = getFormValue(event, 'yesterday');
    const today = getFormValue(event, 'today');
    const blockers = getFormValue(event, 'blockers');
    const mood = getFormValue(event, 'mood') as Mood;

    if (!yesterday.trim() || !today.trim()) {
      return dialogError('Please fill in both "yesterday" and "today".');
    }
    if (!MOODS.includes(mood)) {
      return dialogError('Please pick your mood from the dropdown.');
    }
    if (!Number.isInteger(runId)) {
      return dialogError('This standup form is no longer valid.');
    }

    const answers: SubmissionAnswers = {
      yesterday: yesterday.trim(),
      today: today.trim(),
      blockers: blockers.trim() || 'none',
      mood,
    };
    const result = await this.service.submit(
      runId,
      event.user?.name ?? '',
      event.user?.displayName ?? 'Unknown',
      answers,
    );

    if (result.ok) {
      return dialogOk(
        result.late
          ? '✅ Submitted (after the deadline — marked late) and posted to the team space.'
          : '✅ Standup submitted — posted to the team space. Have a great day!',
      );
    }
    const messages: Record<typeof result.reason, string> = {
      already_submitted: 'You already submitted this standup today. 👍',
      run_not_found: 'This standup form is no longer valid.',
      not_a_participant: "You're not on this standup's roster — ask your admin to `add` you.",
    };
    return dialogError(messages[result.reason]);
  }
}

function isDm(event: any): boolean {
  const type = event.space?.type ?? event.space?.spaceType;
  return type === 'DM' || type === 'DIRECT_MESSAGE';
}

function extractMentions(event: any): Mention[] {
  const annotations: any[] = event.message?.annotations ?? [];
  const mentions: Mention[] = [];
  const seen = new Set<string>();
  for (const a of annotations) {
    if (a?.type !== 'USER_MENTION') continue;
    const user = a.userMention?.user;
    if (!user?.name || user.type === 'BOT') continue;
    if (seen.has(user.name)) continue;
    seen.add(user.name);
    mentions.push({ userName: user.name, displayName: user.displayName ?? user.name });
  }
  return mentions;
}

/** Action parameters arrive as a map or a {key,value} list depending on event shape. */
function getParameter(event: any, key: string): string | undefined {
  const params = event.common?.parameters;
  if (params && typeof params === 'object' && !Array.isArray(params) && key in params) {
    return String(params[key]);
  }
  const list: any[] = Array.isArray(params) ? params : (event.action?.parameters ?? []);
  return list.find((p) => p?.key === key)?.value;
}

function getFormValue(event: any, name: string): string {
  return event.common?.formInputs?.[name]?.stringInputs?.value?.[0] ?? '';
}

function dialogOk(message: string): object {
  return {
    actionResponse: {
      type: 'DIALOG',
      dialogAction: { actionStatus: { statusCode: 'OK', userFacingMessage: message } },
    },
  };
}

function dialogError(message: string): object {
  return {
    actionResponse: {
      type: 'DIALOG',
      dialogAction: { actionStatus: { statusCode: 'INVALID_ARGUMENT', userFacingMessage: message } },
    },
  };
}

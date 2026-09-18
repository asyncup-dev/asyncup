/**
 * Chat apps built as Google Workspace add-ons — the console's default for
 * every new app — receive add-on event objects and must answer with add-on
 * actions. The router speaks the older interaction-event format, so these two
 * translations let it serve both without knowing which one Google chose.
 * https://developers.google.com/workspace/add-ons/concepts/event-objects
 * https://developers.google.com/workspace/add-ons/chat/build#actions
 */

export function isAddonEvent(body: any): boolean {
  return !!body && typeof body === 'object' && !!body.chat && typeof body.chat === 'object';
}

/** Add-on event object → the interaction-event shape the router reads. */
export function fromAddonEvent(body: any): any {
  const chat = body.chat;
  const common = body.commonEventObject ?? {};
  const base = { user: chat.user, eventTime: chat.eventTime, addon: true };

  if (chat.messagePayload) {
    return { ...base, type: 'MESSAGE', space: chat.messagePayload.space ?? chat.space, message: chat.messagePayload.message };
  }
  if (chat.appCommandPayload) {
    const p = chat.appCommandPayload;
    return { ...base, type: 'MESSAGE', space: p.space ?? chat.space, message: p.message, isDialogEvent: p.isDialogEvent, dialogEventType: p.dialogEventType };
  }
  if (chat.addedToSpacePayload) {
    return { ...base, type: 'ADDED_TO_SPACE', space: chat.addedToSpacePayload.space ?? chat.space };
  }
  if (chat.removedFromSpacePayload) {
    return { ...base, type: 'REMOVED_FROM_SPACE', space: chat.removedFromSpacePayload.space ?? chat.space };
  }
  if (chat.buttonClickedPayload) {
    const p = chat.buttonClickedPayload;
    return {
      ...base,
      type: 'CARD_CLICKED',
      space: p.space ?? chat.space,
      message: p.message,
      isDialogEvent: p.isDialogEvent ?? false,
      dialogEventType: p.dialogEventType,
      common: { invokedFunction: common.invokedFunction, parameters: common.parameters, formInputs: common.formInputs },
    };
  }
  return { ...base, type: 'UNKNOWN', space: chat.space };
}

/**
 * Router reply (a Message, or an actionResponse envelope) → add-on actions.
 * Dialogs become card navigations; messages become Chat data actions, posted
 * into the thread the event came from so replies stay threaded.
 */
export function toAddonResponse(reply: any, event: any): object {
  const { actionResponse, ...message } = reply ?? {};

  if (actionResponse?.type === 'DIALOG') {
    const dialogAction = actionResponse.dialogAction ?? {};
    if (dialogAction.dialog) return { action: { navigations: [{ pushCard: dialogAction.dialog.body }] } };
    const status = dialogAction.actionStatus ?? {};
    const notification = status.userFacingMessage ? { notification: { text: status.userFacingMessage } } : {};
    if (status.statusCode === 'OK') {
      return { action: { navigations: [{ endNavigation: { action: 'CLOSE_DIALOG' } }], ...notification } };
    }
    return { action: notification };
  }

  if (Object.keys(message).length === 0) return {};

  if (actionResponse?.type === 'UPDATE_MESSAGE') {
    return { hostAppDataAction: { chatDataAction: { updateMessageAction: { message } } } };
  }
  const threadName = event?.message?.thread?.name;
  const created = threadName ? { ...message, thread: { name: threadName } } : message;
  return { hostAppDataAction: { chatDataAction: { createMessageAction: { message: created } } } };
}

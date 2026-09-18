import { describe, expect, it } from 'bun:test';
import { chatEndpointUrl, fromAddonEvent, isAddonEvent, toAddonResponse } from '../src/adapters/gchat/addon.js';

const USER = { name: 'users/alice', displayName: 'Alice', email: 'alice@example.com', type: 'HUMAN' };
const SPACE = { name: 'spaces/team', type: 'ROOM', spaceType: 'SPACE' };

describe('isAddonEvent', () => {
  it('recognises the add-on envelope and nothing else', () => {
    expect(isAddonEvent({ chat: { user: USER } })).toBe(true);
    expect(isAddonEvent({ type: 'MESSAGE' })).toBe(false);
    expect(isAddonEvent({ chat: 'no' })).toBe(false);
    expect(isAddonEvent(null)).toBe(false);
    expect(isAddonEvent('text')).toBe(false);
  });
});

describe('fromAddonEvent', () => {
  it('maps a message, keeping the thread and preferring the payload space', () => {
    const message = { name: 'spaces/team/messages/1', argumentText: ' setup Crew', thread: { name: 'spaces/team/threads/9' } };
    expect(
      fromAddonEvent({
        commonEventObject: { hostApp: 'CHAT' },
        chat: { user: USER, space: { name: 'spaces/other' }, eventTime: '2026-09-18T06:36:00Z', messagePayload: { message, space: SPACE } },
      }),
    ).toEqual({ type: 'MESSAGE', user: USER, eventTime: '2026-09-18T06:36:00Z', addon: true, space: SPACE, message });
  });

  it('falls back to chat.space when a payload carries none', () => {
    const e = fromAddonEvent({ chat: { user: USER, space: SPACE, messagePayload: { message: { text: 'hi' } } } });
    expect(e.space).toEqual(SPACE);
  });

  it('maps app commands as messages, including their dialog flags', () => {
    const e = fromAddonEvent({
      chat: { user: USER, space: SPACE, appCommandPayload: { message: { argumentText: 'help' }, isDialogEvent: false, dialogEventType: 'TYPE_UNSPECIFIED' } },
    });
    expect(e).toMatchObject({ type: 'MESSAGE', message: { argumentText: 'help' }, isDialogEvent: false, space: SPACE });
    expect(fromAddonEvent({ chat: { user: USER, appCommandPayload: { space: SPACE, message: {} } } }).space).toEqual(SPACE);
  });

  it('maps added-to-space and removed-from-space', () => {
    expect(fromAddonEvent({ chat: { user: USER, space: SPACE, addedToSpacePayload: { interactionAdd: true } } })).toMatchObject({ type: 'ADDED_TO_SPACE', space: SPACE });
    expect(fromAddonEvent({ chat: { user: USER, addedToSpacePayload: { space: SPACE } } })).toMatchObject({ type: 'ADDED_TO_SPACE', space: SPACE });
    expect(fromAddonEvent({ chat: { user: USER, space: SPACE, removedFromSpacePayload: {} } })).toMatchObject({ type: 'REMOVED_FROM_SPACE', space: SPACE });
    expect(fromAddonEvent({ chat: { user: USER, removedFromSpacePayload: { space: SPACE } } })).toMatchObject({ type: 'REMOVED_FROM_SPACE', space: SPACE });
  });

  it('maps button clicks with the invoked function, parameters and form inputs the router expects', () => {
    const formInputs = { q0: { stringInputs: { value: ['Did X'] } } };
    const e = fromAddonEvent({
      commonEventObject: { invokedFunction: 'submitStandup', parameters: { runId: '7' }, formInputs },
      chat: {
        user: USER,
        space: { name: 'spaces/dm', spaceType: 'DIRECT_MESSAGE' },
        buttonClickedPayload: { message: { name: 'spaces/dm/messages/3' }, isDialogEvent: true, dialogEventType: 'SUBMIT_DIALOG' },
      },
    });
    expect(e).toEqual({
      type: 'CARD_CLICKED',
      user: USER,
      eventTime: undefined,
      addon: true,
      space: { name: 'spaces/dm', spaceType: 'DIRECT_MESSAGE' },
      message: { name: 'spaces/dm/messages/3' },
      isDialogEvent: true,
      dialogEventType: 'SUBMIT_DIALOG',
      common: { invokedFunction: 'submitStandup', parameters: { runId: '7' }, formInputs },
    });
    const plain = fromAddonEvent({ chat: { user: USER, buttonClickedPayload: { space: SPACE } } });
    expect(plain).toMatchObject({ type: 'CARD_CLICKED', isDialogEvent: false, space: SPACE, common: {} });
  });

  it('labels payloads it does not know so the router ignores them', () => {
    expect(fromAddonEvent({ chat: { user: USER, space: SPACE, widgetUpdatedPayload: {} } })).toMatchObject({ type: 'UNKNOWN', space: SPACE });
  });
});

describe('toAddonResponse', () => {
  const event = { message: { thread: { name: 'spaces/team/threads/9' } } };

  it('turns an empty reply into an empty action set', () => {
    expect(toAddonResponse({}, event)).toEqual({});
    expect(toAddonResponse(undefined, event)).toEqual({});
  });

  it('posts text and card replies as a new message in the originating thread', () => {
    expect(toAddonResponse({ text: 'hi' }, event)).toEqual({
      hostAppDataAction: { chatDataAction: { createMessageAction: { message: { text: 'hi', thread: { name: 'spaces/team/threads/9' } } } } },
    });
    expect(toAddonResponse({ cardsV2: [{ cardId: 'c' }] }, {})).toEqual({
      hostAppDataAction: { chatDataAction: { createMessageAction: { message: { cardsV2: [{ cardId: 'c' }] } } } },
    });
    expect(toAddonResponse({ actionResponse: { type: 'NEW_MESSAGE' }, text: 'closed' }, {})).toEqual({
      hostAppDataAction: { chatDataAction: { createMessageAction: { message: { text: 'closed' } } } },
    });
  });

  it('turns UPDATE_MESSAGE into an update of the clicked message', () => {
    expect(toAddonResponse({ actionResponse: { type: 'UPDATE_MESSAGE' }, text: 'done' }, event)).toEqual({
      hostAppDataAction: { chatDataAction: { updateMessageAction: { message: { text: 'done' } } } },
    });
  });

  it('opens a dialog as a pushed card', () => {
    const body = { sections: [{ widgets: [] }] };
    expect(toAddonResponse({ actionResponse: { type: 'DIALOG', dialogAction: { dialog: { body } } } }, event)).toEqual({
      action: { navigations: [{ pushCard: body }] },
    });
  });

  it('closes the dialog with a notification on OK, keeps it open with the message on a validation error', () => {
    expect(
      toAddonResponse({ actionResponse: { type: 'DIALOG', dialogAction: { actionStatus: { statusCode: 'OK', userFacingMessage: 'Submitted' } } } }, event),
    ).toEqual({ action: { navigations: [{ endNavigation: { action: 'CLOSE_DIALOG' } }], notification: { text: 'Submitted' } } });
    expect(
      toAddonResponse({ actionResponse: { type: 'DIALOG', dialogAction: { actionStatus: { statusCode: 'INVALID_ARGUMENT', userFacingMessage: 'Please answer' } } } }, event),
    ).toEqual({ action: { notification: { text: 'Please answer' } } });
    expect(toAddonResponse({ actionResponse: { type: 'DIALOG', dialogAction: { actionStatus: { statusCode: 'OK' } } } }, event)).toEqual({
      action: { navigations: [{ endNavigation: { action: 'CLOSE_DIALOG' } }] },
    });
    expect(toAddonResponse({ actionResponse: { type: 'DIALOG' } }, event)).toEqual({ action: {} });
  });
});

describe('chatEndpointUrl', () => {
  it('picks the https audience out of the list, or nothing', () => {
    expect(chatEndpointUrl('742900314218 https://standup.example.com/chat/events')).toBe('https://standup.example.com/chat/events');
    expect(chatEndpointUrl('https://a.example/chat/events,742900314218')).toBe('https://a.example/chat/events');
    expect(chatEndpointUrl('742900314218')).toBeNull();
    expect(chatEndpointUrl('')).toBeNull();
  });
});

import { describe, expect, it, spyOn } from 'bun:test';
import { JWT, OAuth2Client } from 'google-auth-library';
import { GoogleLeaveWriter } from '../src/integrations/google-leave.js';

/** Stub the Google client: answers in order, recording each request. */
function stubGoogle(answers: ((opts: any) => unknown)[]) {
  const calls: { url: string; method?: string; params: any; data: any; subject?: string; scopes: unknown }[] = [];
  const spy = spyOn(OAuth2Client.prototype, 'request').mockImplementation(async function (this: JWT, opts: any) {
    calls.push({ url: opts.url, method: opts.method, params: opts.params, data: opts.data, subject: this.subject, scopes: this.scopes });
    const answer = answers.shift();
    if (!answer) throw new Error(`unexpected request ${opts.url}`);
    return answer(opts) as any;
  });
  return { calls, restore: () => spy.mockRestore() };
}
const httpError = (status: number) => () => {
  throw Object.assign(new Error(`HTTP ${status}`), { response: { status } });
};
const CREDS = JSON.stringify({ client_email: 'bot@proj.iam.gserviceaccount.com', private_key: 'PEM' });
const EVENT = { start: '2026-06-12T00:00:00.000+05:30', end: '2026-06-16T00:00:00.000+05:30', timeZone: 'Asia/Kolkata', decline: 'none' as const, message: 'I’m on leave until Mon 15 Jun.' };

describe('GoogleLeaveWriter', () => {
  it('sets and clears the Chat custom status as the person', async () => {
    const g = stubGoogle([() => ({ data: {} }), () => ({ data: {} }), () => ({ data: { customStatus: { text: 'On leave' } } }), () => ({ data: {} }), () => ({ data: { customStatus: { text: 'Hiking' } } }), () => ({ data: {} })]);
    try {
      const w = new GoogleLeaveWriter(CREDS);
      await w.setStatus('a@example.com', { text: 'On leave until Mon 15 Jun', emoji: '🌴', expireTime: '2026-06-15T18:30:00.000Z' });
      await w.setStatus('a@example.com', { text: 'On leave', emoji: '🌴', expireTime: null });
      await w.clearStatus('a@example.com', 'On leave');
      await w.clearStatus('a@example.com', 'On leave'); // their own status now: left alone
      expect(g.calls[0]).toMatchObject({
        url: 'https://chat.googleapis.com/v1/users/me/availability',
        method: 'PATCH',
        params: { updateMask: 'customStatus' },
        data: { customStatus: { text: 'On leave until Mon 15 Jun', emoji: { unicode: '🌴' }, expireTime: '2026-06-15T18:30:00.000Z' } },
        subject: 'a@example.com',
        scopes: ['https://www.googleapis.com/auth/chat.users.availability'],
      });
      expect(g.calls[1]!.data).toEqual({ customStatus: { text: 'On leave', emoji: { unicode: '🌴' } } });
      expect(g.calls[2]).toMatchObject({ url: 'https://chat.googleapis.com/v1/users/me/availability', method: undefined });
      expect(g.calls[3]).toMatchObject({ method: 'PATCH', data: {} });
      expect(g.calls).toHaveLength(5);
    } finally {
      g.restore();
    }
  });

  it('creates, moves and deletes the out-of-office event on the primary calendar', async () => {
    const g = stubGoogle([() => ({ data: { id: 'ev 1' } }), () => ({ data: {} }), () => ({ data: {} }), httpError(410), httpError(500)]);
    try {
      const w = new GoogleLeaveWriter(CREDS);
      expect(await w.createOutOfOffice('a@example.com', EVENT)).toBe('ev 1');
      await w.updateOutOfOffice('a@example.com', 'ev 1', { ...EVENT, decline: 'all' });
      await w.deleteOutOfOffice('a@example.com', 'ev 1');
      await w.deleteOutOfOffice('a@example.com', 'ev 1'); // already gone in Calendar
      await expect(w.deleteOutOfOffice('a@example.com', 'ev 1')).rejects.toThrow('HTTP 500');
      expect(g.calls[0]).toMatchObject({
        url: 'https://www.googleapis.com/calendar/v3/calendars/primary/events',
        method: 'POST',
        subject: 'a@example.com',
        scopes: ['https://www.googleapis.com/auth/calendar.events'],
        data: {
          eventType: 'outOfOffice',
          summary: 'On leave',
          transparency: 'opaque',
          start: { dateTime: EVENT.start, timeZone: 'Asia/Kolkata' },
          end: { dateTime: EVENT.end, timeZone: 'Asia/Kolkata' },
          outOfOfficeProperties: { autoDeclineMode: 'declineNone' },
        },
      });
      expect(g.calls[1]).toMatchObject({ url: 'https://www.googleapis.com/calendar/v3/calendars/primary/events/ev%201', method: 'PATCH', data: { outOfOfficeProperties: { autoDeclineMode: 'declineAllConflictingInvitations', declineMessage: EVENT.message } } });
      expect(g.calls[2]).toMatchObject({ method: 'DELETE' });
    } finally {
      g.restore();
    }
  });

  it('names the scope to delegate when Google refuses', async () => {
    const w = new GoogleLeaveWriter(CREDS);
    let g = stubGoogle([httpError(403)]);
    await expect(w.setStatus('a@example.com', { text: 'x', emoji: '🌴', expireTime: null })).rejects.toThrow('Google refused it (403). Check that https://www.googleapis.com/auth/chat.users.availability is delegated to bot@proj.iam.gserviceaccount.com.');
    g.restore();
    g = stubGoogle([() => { throw new Error('unauthorized_client: Client is unauthorized to retrieve access tokens'); }]);
    await expect(w.createOutOfOffice('a@example.com', { ...EVENT, decline: 'new' })).rejects.toThrow('Google refused it (unauthorized_client). Check that https://www.googleapis.com/auth/calendar.events is delegated');
    g.restore();
    g = stubGoogle([() => { throw 'boom'; }]);
    await expect(w.createOutOfOffice('a@example.com', EVENT)).rejects.toThrow('boom');
    g.restore();
  });
});

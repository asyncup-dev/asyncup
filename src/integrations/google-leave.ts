import { JWT } from 'google-auth-library';
import type { DeclineMode, LeaveWriter, OooEvent } from '../core/leave-presence.js';

const CHAT_SCOPE = 'https://www.googleapis.com/auth/chat.users.availability';
const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
const AVAILABILITY = 'https://chat.googleapis.com/v1/users/me/availability';
const EVENTS = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';

const DECLINE: Record<DeclineMode, string> = {
  none: 'declineNone',
  new: 'declineOnlyNewConflictingInvitations',
  all: 'declineAllConflictingInvitations',
};

/**
 * Sets Chat custom statuses and Calendar out-of-office events as each person,
 * through the service account's domain-wide delegation. Chat only lets a
 * user change their own status, so there is no app-auth alternative.
 */
export class GoogleLeaveWriter implements LeaveWriter {
  private clientEmail: string;
  private privateKey: string;

  constructor(credentialsJson: string) {
    const creds = JSON.parse(credentialsJson);
    this.clientEmail = creds.client_email;
    this.privateKey = creds.private_key;
  }

  async setStatus(email: string, status: { text: string; emoji: string; expireTime: string | null }): Promise<void> {
    const customStatus = { text: status.text, emoji: { unicode: status.emoji }, ...(status.expireTime ? { expireTime: status.expireTime } : {}) };
    await this.call(email, CHAT_SCOPE, { url: AVAILABILITY, method: 'PATCH', params: { updateMask: 'customStatus' }, data: { customStatus } });
  }

  async clearStatus(email: string, text: string): Promise<void> {
    const current = await this.call<{ customStatus?: { text?: string } }>(email, CHAT_SCOPE, { url: AVAILABILITY });
    // Someone who has since set their own status keeps it.
    if (current.customStatus?.text !== text) return;
    await this.call(email, CHAT_SCOPE, { url: AVAILABILITY, method: 'PATCH', params: { updateMask: 'customStatus' }, data: {} });
  }

  async createOutOfOffice(email: string, event: OooEvent): Promise<string> {
    const created = await this.call<{ id: string }>(email, CALENDAR_SCOPE, { url: EVENTS, method: 'POST', data: this.body(event) });
    return created.id;
  }

  async updateOutOfOffice(email: string, id: string, event: OooEvent): Promise<void> {
    await this.call(email, CALENDAR_SCOPE, { url: `${EVENTS}/${encodeURIComponent(id)}`, method: 'PATCH', data: this.body(event) });
  }

  async deleteOutOfOffice(email: string, id: string): Promise<void> {
    try {
      await this.call(email, CALENDAR_SCOPE, { url: `${EVENTS}/${encodeURIComponent(id)}`, method: 'DELETE' });
    } catch (err: any) {
      // Already deleted in Calendar.
      if (err?.status === 404 || err?.status === 410) return;
      throw err;
    }
  }

  private body(event: OooEvent) {
    return {
      eventType: 'outOfOffice',
      summary: 'On leave',
      transparency: 'opaque',
      start: { dateTime: event.start, timeZone: event.timeZone },
      end: { dateTime: event.end, timeZone: event.timeZone },
      outOfOfficeProperties: { autoDeclineMode: DECLINE[event.decline], ...(event.decline === 'none' ? {} : { declineMessage: event.message }) },
    };
  }

  private async call<T = unknown>(email: string, scope: string, opts: { url: string; method?: string; params?: Record<string, string>; data?: unknown }): Promise<T> {
    const jwt = new JWT({ email: this.clientEmail, key: this.privateKey, subject: email, scopes: [scope] });
    try {
      const res = await jwt.request<T>(opts as any);
      return res.data;
    } catch (err: any) {
      const status = err?.response?.status ?? err?.code;
      if (status === 401 || status === 403 || /unauthorized_client/.test(String(err?.message))) {
        throw Object.assign(new Error(`Google refused it (${status === 401 || status === 403 ? status : 'unauthorized_client'}). Check that ${scope} is delegated to ${this.clientEmail}.`), { status });
      }
      throw Object.assign(new Error(err?.message ?? String(err)), { status });
    }
  }
}

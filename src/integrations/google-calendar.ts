import { JWT } from 'google-auth-library';
import { DateTime } from 'luxon';
import type { OooChecker } from '../core/ooo.js';

const SCOPE = 'https://www.googleapis.com/auth/calendar.events.readonly';

/**
 * Looks for "Out of office" events in the user's primary Google Calendar.
 * Requires a service-account key (pasted in dashboard settings) with
 * domain-wide delegation for the calendar.events.readonly scope.
 */
export class GoogleCalendarOoo implements OooChecker {
  private clientEmail: string;
  private privateKey: string;

  constructor(credentialsJson: string) {
    const creds = JSON.parse(credentialsJson);
    this.clientEmail = creds.client_email;
    this.privateKey = creds.private_key;
  }

  async isOoo(email: string, date: string, timezone: string): Promise<boolean> {
    const jwt = new JWT({
      email: this.clientEmail,
      key: this.privateKey,
      subject: email,
      scopes: [SCOPE],
    });
    const dayStart = DateTime.fromISO(date, { zone: timezone }).startOf('day');
    const res = await jwt.request<{ items?: unknown[] }>({
      url: `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(email)}/events`,
      params: {
        eventTypes: 'outOfOffice',
        singleEvents: 'true',
        timeMin: dayStart.toISO()!,
        timeMax: dayStart.endOf('day').toISO()!,
        maxResults: '1',
      },
    });
    return (res.data.items ?? []).length > 0;
  }
}

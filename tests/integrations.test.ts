import { describe, expect, it, spyOn } from 'bun:test';
import { JWT, OAuth2Client } from 'google-auth-library';
import { GoogleCalendarOoo } from '../src/integrations/google-calendar.js';
import { GoogleDirectory } from '../src/integrations/google-directory.js';

const CREDS = JSON.stringify({ client_email: 'bot@proj.iam.gserviceaccount.com', private_key: 'PEM' });

interface Captured {
  email?: string;
  key?: string;
  subject?: string;
  scopes?: string | string[];
  url?: string;
  params?: Record<string, string>;
}

/** Stub JWT#request; records the client's identity and the request it was asked to make. */
async function withRequest<T>(
  respond: () => Promise<{ data: unknown }>,
  body: (calls: Captured[]) => Promise<T>,
): Promise<T> {
  const calls: Captured[] = [];
  const spy = spyOn(OAuth2Client.prototype, 'request').mockImplementation(function (this: JWT, opts: any) {
    calls.push({
      email: this.email,
      key: this.key,
      subject: this.subject,
      scopes: this.scopes,
      url: opts.url,
      params: opts.params,
    });
    return respond() as any;
  });
  try {
    return await body(calls);
  } finally {
    spy.mockRestore();
  }
}

describe('GoogleCalendarOoo', () => {
  it('impersonates the user and asks for out-of-office events spanning the day in their zone', async () => {
    const ooo = new GoogleCalendarOoo(CREDS);
    await withRequest(
      async () => ({ data: { items: [{ id: 'evt' }] } }),
      async (calls) => {
        expect(await ooo.isOoo('alice@org.com', '2026-06-10', 'Asia/Kolkata')).toBe(true);
        expect(calls).toHaveLength(1);
        expect(calls[0]).toEqual({
          email: 'bot@proj.iam.gserviceaccount.com',
          key: 'PEM',
          subject: 'alice@org.com',
          scopes: ['https://www.googleapis.com/auth/calendar.events.readonly'],
          url: 'https://www.googleapis.com/calendar/v3/calendars/alice%40org.com/events',
          params: {
            eventTypes: 'outOfOffice',
            singleEvents: 'true',
            timeMin: '2026-06-10T00:00:00.000+05:30',
            timeMax: '2026-06-10T23:59:59.999+05:30',
            maxResults: '1',
          },
        });
      },
    );
  });

  it('is not OOO when the calendar returns no events or omits items entirely', async () => {
    const ooo = new GoogleCalendarOoo(CREDS);
    await withRequest(
      async () => ({ data: { items: [] } }),
      async () => expect(await ooo.isOoo('a@org.com', '2026-06-10', 'UTC')).toBe(false),
    );
    await withRequest(
      async () => ({ data: {} }),
      async () => expect(await ooo.isOoo('a@org.com', '2026-06-10', 'UTC')).toBe(false),
    );
  });

  it('lets API failures propagate so the caller can treat them as "not OOO"', async () => {
    const ooo = new GoogleCalendarOoo(CREDS);
    await withRequest(
      async () => {
        throw new Error('invalid_grant');
      },
      async () => expect(ooo.isOoo('a@org.com', '2026-06-10', 'UTC')).rejects.toThrow('invalid_grant'),
    );
  });
});

describe('GoogleDirectory', () => {
  it('looks users up as the Workspace admin and maps the Directory fields', async () => {
    const dir = new GoogleDirectory(CREDS, 'admin@org.com');
    await withRequest(
      async () => ({
        data: { id: '1234', primaryEmail: 'alice@org.com', isAdmin: false, isDelegatedAdmin: true, suspended: false },
      }),
      async (calls) => {
        expect(await dir.lookup('users/1234')).toEqual({
          id: '1234',
          email: 'alice@org.com',
          isAdmin: true,
          suspended: false,
        });
        expect(calls[0]).toEqual({
          email: 'bot@proj.iam.gserviceaccount.com',
          key: 'PEM',
          subject: 'admin@org.com',
          scopes: ['https://www.googleapis.com/auth/admin.directory.user.readonly'],
          url: 'https://admin.googleapis.com/admin/directory/v1/users/users%2F1234',
          params: { fields: 'id,primaryEmail,isAdmin,isDelegatedAdmin,suspended' },
        });
      },
    );
  });

  it('reports super admins and suspended accounts, and nulls out missing fields', async () => {
    const dir = new GoogleDirectory(CREDS, 'admin@org.com');
    await withRequest(
      async () => ({ data: { isAdmin: true, suspended: true } }),
      async () =>
        expect(await dir.lookup('bob@org.com')).toEqual({ id: null, email: null, isAdmin: true, suspended: true }),
    );
    await withRequest(
      async () => ({ data: {} }),
      async () =>
        expect(await dir.lookup('bob@org.com')).toEqual({ id: null, email: null, isAdmin: false, suspended: false }),
    );
  });

  it('returns null for an unknown user, whether the 404 is on the response or the error code', async () => {
    const dir = new GoogleDirectory(CREDS, 'admin@org.com');
    await withRequest(
      async () => {
        throw Object.assign(new Error('Not Found'), { response: { status: 404 } });
      },
      async () => expect(await dir.lookup('ghost@org.com')).toBeNull(),
    );
    await withRequest(
      async () => {
        throw Object.assign(new Error('Not Found'), { code: 404 });
      },
      async () => expect(await dir.lookup('ghost@org.com')).toBeNull(),
    );
  });

  it('rethrows every other failure', async () => {
    const dir = new GoogleDirectory(CREDS, 'admin@org.com');
    await withRequest(
      async () => {
        throw Object.assign(new Error('Forbidden'), { response: { status: 403 } });
      },
      async () => expect(dir.lookup('alice@org.com')).rejects.toThrow('Forbidden'),
    );
    await withRequest(
      async () => {
        throw 'network down';
      },
      async () => expect(dir.lookup('alice@org.com')).rejects.toBe('network down'),
    );
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { Settings } from './api';
import { chatAppValues, copyText, nextStep, projectNumberOf, stepDone, timezoneOptions, type SetupProgress } from './setup';

const settings = (over: Partial<Settings['chat']> = {}, setup: Partial<Settings['setup']> = {}): Settings => ({
  chat: { audience: '', serviceAccount: { set: false, email: null, clientId: null }, ...over },
  workspace: { defaultTimezone: 'UTC', calendarOoo: true, workspaceAdminEmail: '' },
  signIn: { tokenSignIn: true, google: { clientId: '', clientSecret: { set: false }, on: false }, saml: { entityId: '', ssoUrl: '', cert: { set: false }, adminAttribute: '', adminGroup: '', on: false } },
  setup: { complete: false, chatConfigured: false, signInConfigured: false, ...setup },
});
const progress = (s: Settings, lastEventAt: string | null = null, standups = 0): SetupProgress => ({
  settings: s,
  health: { audience: s.chat.audience ? 'set' : 'unset', serviceAccount: 'unset', lastEventAt, lastRejectedAt: null },
  standups,
});

describe('setup progress', () => {
  it('reads the project number out of a mixed audience', () => {
    expect(projectNumberOf('')).toBe('');
    expect(projectNumberOf('https://a.example/chat/events 728449131907')).toBe('728449131907');
    expect(projectNumberOf('my-slug')).toBe('');
  });

  it('derives each step from the server state and picks the next one', () => {
    const fresh = progress(settings());
    expect(stepDone(fresh, 'project')).toBe(false);
    expect(nextStep(fresh).id).toBe('project');

    const withProject = progress(settings({ audience: '728449131907' }));
    expect(stepDone(withProject, 'project')).toBe(true);
    expect(nextStep(withProject).id).toBe('service-account');

    const withKey = progress(settings({ audience: '728449131907', serviceAccount: { set: true, email: 'b@x', clientId: '1' } }));
    expect(stepDone(withKey, 'service-account')).toBe(true);
    expect(stepDone(withKey, 'chat-app')).toBe(false);
    expect(nextStep(withKey).id).toBe('chat-app');

    const chatWorks = progress(withKey.settings, '2026-09-16T10:00:00Z');
    expect(stepDone(chatWorks, 'chat-app')).toBe(true);
    expect(stepDone(chatWorks, 'sign-in')).toBe(false);
    expect(nextStep(chatWorks).id).toBe('template');

    const done = progress(settings({ audience: '1', serviceAccount: { set: true, email: null, clientId: null } }, { signInConfigured: true }), 'x', 2);
    expect(stepDone(done, 'sign-in')).toBe(true);
    expect(stepDone(done, 'template')).toBe(true);
    expect(nextStep(done).id).toBe('template');
  });

  it('builds the Chat app values from the origin', () => {
    expect(chatAppValues('https://asyncup.example.com')).toEqual({
      appName: 'AsyncUp',
      avatarUrl: 'https://asyncup.example.com/app/logo-256.png',
      description: 'Async daily standups for your team',
      endpointUrl: 'https://asyncup.example.com/chat/events',
    });
  });

  it('puts the workspace timezone first and falls back when Intl cannot list zones', () => {
    const zones = timezoneOptions('Asia/Kolkata');
    expect(zones[0]).toBe('Asia/Kolkata');
    expect(zones.filter((z) => z === 'Asia/Kolkata')).toHaveLength(1);
    const orig = Intl.supportedValuesOf;
    (Intl as unknown as { supportedValuesOf: unknown }).supportedValuesOf = undefined;
    expect(timezoneOptions('Europe/Berlin')).toEqual(['Europe/Berlin', 'UTC', 'Asia/Kolkata', 'Europe/London', 'America/New_York']);
    Intl.supportedValuesOf = orig;
  });

  it('reports whether the clipboard accepted the text', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    expect(await copyText('abc')).toBe(true);
    expect(writeText).toHaveBeenCalledWith('abc');
    writeText.mockRejectedValueOnce(new Error('denied'));
    expect(await copyText('abc')).toBe(false);
  });
});

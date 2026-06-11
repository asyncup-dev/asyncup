import { describe, expect, it } from 'vitest';
import { SecretBox, generateToken } from '../src/core/crypto.js';
import { makeStack } from './helpers.js';

describe('SecretBox', () => {
  it('round-trips and rejects tampering', () => {
    const box = new SecretBox('some-secret-key');
    const payload = box.encrypt('sk-ant-very-secret');
    expect(payload).not.toContain('very-secret');
    expect(box.decrypt(payload)).toBe('sk-ant-very-secret');

    const other = new SecretBox('different-key');
    expect(() => other.decrypt(payload)).toThrow();
    expect(() => box.decrypt(payload.slice(0, -4) + 'AAAA')).toThrow();
  });

  it('generates url-safe tokens', () => {
    const token = generateToken();
    expect(token.length).toBeGreaterThanOrEqual(30);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(generateToken()).not.toBe(token);
  });
});

describe('SettingsService', () => {
  it('returns defaults when nothing is stored', async () => {
    const { settings } = await makeStack();
    const s = await settings.get();
    expect(s.chatAudience).toBe('');
    expect(s.calendarOoo).toBe(false);
    expect(s.defaultTimezone).toBe('Asia/Kolkata'); // set by the test harness
  });

  it('persists values, encrypting secrets at rest', async () => {
    const { settings, repo } = await makeStack();
    await settings.update({ chatAudience: '12345', llmApiKey: 'sk-secret', calendarOoo: true });

    const s = await settings.get();
    expect(s.chatAudience).toBe('12345');
    expect(s.llmApiKey).toBe('sk-secret');
    expect(s.calendarOoo).toBe(true);

    const rows = await repo.getSettingRows();
    const audience = rows.find((r) => r.key === 'chatAudience')!;
    expect(audience.encrypted).toBe(false);
    expect(audience.value).toBe('12345');
    const key = rows.find((r) => r.key === 'llmApiKey')!;
    expect(key.encrypted).toBe(true);
    expect(key.value).not.toContain('sk-secret');
  });

  it('clears values with empty string and notifies listeners', async () => {
    const { settings } = await makeStack();
    let notified = 0;
    settings.onChange(() => notified++);

    await settings.update({ tickToken: 'abc' });
    expect((await settings.get()).tickToken).toBe('abc');
    await settings.update({ tickToken: '' });
    expect((await settings.get()).tickToken).toBe('');
    expect(notified).toBe(2);
  });
});

import { auth as chatAuth } from '@googleapis/chat';
import { DateTime } from 'luxon';
import type { ChatClientFactory } from '../adapters/gchat/adapter.js';
import type { Repo } from '../db/repo.js';
import type { ChatAdapter } from './adapter.js';
import { badAudience } from './settings-rules.js';
import type { AppSettings } from './settings.js';
import type { Standup } from './types.js';
import type { WebhookNotifier } from './webhooks.js';

/**
 * Live checks behind every "Verify" button in setup and settings. Each
 * returns the same shape so the UI can render them uniformly, and every
 * failure says what to do next.
 */
export interface Verification {
  state: 'pass' | 'fail';
  detail: string;
  checkedAt: string;
  data?: Record<string, unknown>;
}

const pass = (detail: string, now: DateTime, data?: Record<string, unknown>): Verification => ({ state: 'pass', detail, checkedAt: now.toISO()!, ...(data ? { data } : {}) });
const fail = (detail: string, now: DateTime): Verification => ({ state: 'fail', detail, checkedAt: now.toISO()! });

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The row keys /chat/events writes so setup can prove events really arrive. */
export const LAST_EVENT_KEYS = { at: 'lastChatEventAt', rejectedAt: 'lastChatEventRejectedAt', reason: 'lastChatEventReason' } as const;

export async function recordChatEvent(repo: Repo, now: DateTime, ok: boolean, reason = ''): Promise<void> {
  const at = now.toISO()!;
  if (ok) await repo.setSetting(LAST_EVENT_KEYS.at, at, false, at);
  else {
    await repo.setSetting(LAST_EVENT_KEYS.rejectedAt, at, false, at);
    await repo.setSetting(LAST_EVENT_KEYS.reason, reason.slice(0, 200), false, at);
  }
}

export function verifyProject(s: AppSettings, now: DateTime): Verification {
  if (!s.chatAudience) return fail('No project number set yet — paste it from Cloud overview → Project info.', now);
  const err = badAudience(s.chatAudience);
  if (err) return fail(err, now);
  const values = s.chatAudience.split(/[\s,]+/).filter(Boolean);
  return pass(`Audience accepted: ${values.join(', ')}. Google Chat events are verified against it.`, now, { audiences: values });
}

export async function verifyServiceAccount(
  s: AppSettings,
  createClient: ChatClientFactory,
  now: DateTime,
): Promise<Verification> {
  if (!s.serviceAccountJson) return fail('No service-account key stored yet — paste the downloaded JSON file.', now);
  let email = '';
  try {
    email = JSON.parse(s.serviceAccountJson).client_email;
    const auth = new chatAuth.GoogleAuth({
      credentials: JSON.parse(s.serviceAccountJson),
      scopes: ['https://www.googleapis.com/auth/chat.bot'],
    });
    const res = await createClient(auth).spaces.list({ pageSize: 1 });
    const spaces = res.data.spaces?.length ?? 0;
    return pass(
      spaces
        ? `Key verified for ${email} — the app is already in at least one space.`
        : `Key verified for ${email}. Add the app to a space and it will appear here.`,
      now,
      { email, spaces },
    );
  } catch (err) {
    return fail(`Google rejected the key${email ? ` for ${email}` : ''}: ${errText(err)}. Check that the Chat API is enabled and the key is current.`, now);
  }
}

export async function verifyChatEvent(repo: Repo, now: DateTime): Promise<Verification> {
  const rows = new Map((await repo.getSettingRows()).map((r) => [r.key, r.value]));
  const at = rows.get(LAST_EVENT_KEYS.at);
  const rejectedAt = rows.get(LAST_EVENT_KEYS.rejectedAt);
  if (at && (!rejectedAt || rejectedAt < at)) {
    return pass(`Event received and verified at ${at}.`, now, { lastEventAt: at });
  }
  if (rejectedAt) {
    return fail(`An event arrived at ${rejectedAt} but failed verification (${rows.get(LAST_EVENT_KEYS.reason) ?? 'unknown'}). Check the Authentication Audience matches the project number or endpoint URL.`, now);
  }
  return fail('No event received yet. Save the Chat app configuration in Google Cloud, then send AsyncUp any message in Chat.', now);
}

export async function verifyWebhook(standup: Standup, webhooks: WebhookNotifier, now: DateTime): Promise<Verification> {
  if (!standup.webhookUrl) return fail('This standup has no webhook URL.', now);
  const result = await webhooks.test(standup);
  return result.ok
    ? pass(`${standup.webhookUrl} answered ${result.status}.`, now, { status: result.status })
    : fail(`${standup.webhookUrl} did not accept the test event: ${result.error}.`, now);
}

export async function verifySaml(
  s: AppSettings,
  baseUrl: string,
  makeLoginUrl: (config: { idpEntityId: string; idpSsoUrl: string; idpCert: string; baseUrl: string }) => Promise<string>,
  fetchFn: typeof fetch,
  now: DateTime,
): Promise<Verification> {
  if (!s.samlIdpEntityId || !s.samlIdpSsoUrl || !s.samlIdpCert) {
    return fail('SAML needs the IdP entity ID, SSO URL and certificate before it can be tested.', now);
  }
  try {
    await makeLoginUrl({ idpEntityId: s.samlIdpEntityId, idpSsoUrl: s.samlIdpSsoUrl, idpCert: s.samlIdpCert, baseUrl });
  } catch (err) {
    return fail(`Could not build a sign-in request from this configuration: ${errText(err)}.`, now);
  }
  try {
    const res = await fetchFn(s.samlIdpSsoUrl, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(5_000) });
    if (res.status >= 500) return fail(`The IdP SSO URL answered ${res.status}.`, now);
    return pass(`Sign-in request builds and the IdP answers at ${s.samlIdpSsoUrl} (${res.status}).`, now, { status: res.status });
  } catch (err) {
    return fail(`The IdP SSO URL is not reachable from this server: ${errText(err)}.`, now);
  }
}

export async function verifyDm(adapter: ChatAdapter, userName: string, now: DateTime): Promise<Verification> {
  try {
    await adapter.sendDm(userName, '👋 AsyncUp can reach you here. This was a connection test from the setup page — nothing else to do.');
    return pass('Test message sent — check your Google Chat direct messages.', now);
  } catch (err) {
    return fail(`Could not send you a message: ${errText(err)}. Has the app been added for you in Chat?`, now);
  }
}

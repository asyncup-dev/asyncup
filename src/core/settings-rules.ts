import type { AppSettings } from './settings.js';
import { HTTPS_URL_RE, isValidZone, looksLikeEmail } from './validation.js';

/**
 * Rules for editing app settings, shared by the dashboard forms and the
 * JSON API: per-field checks, which fields are secrets or booleans, and the
 * lockout guard that refuses to remove the last working sign-in method.
 */

export function badAudience(v: string): string | null {
  // Accepts the GCP project number and/or the app URL (Chat API "Audience"
  // can be either) — space/comma separated. Reject obvious mistakes like
  // the project ID slug or org ID being pasted as the only value.
  const bad = v.split(/[\s,]+/).filter(Boolean).find((a) => !/^\d+$/.test(a) && !HTTPS_URL_RE.test(a));
  return bad
    ? `"${bad}" isn't a GCP project number or an https app URL. Use the project number (digits) or the Chat app's HTTP endpoint URL — not the project ID slug or org ID.`
    : null;
}

export function badSaKey(v: string): string | null {
  try {
    const parsed = JSON.parse(v);
    if (!parsed.client_email || !parsed.private_key) {
      return 'That JSON is missing client_email / private_key — paste the full service-account key file.';
    }
  } catch {
    return 'The service-account key must be valid JSON — paste the whole downloaded file.';
  }
  return null;
}

export const badOauthId = (v: string): string | null =>
  v && !v.endsWith('.apps.googleusercontent.com')
    ? 'That does not look like an OAuth client ID (expected ….apps.googleusercontent.com).'
    : null;

export const badSamlSsoUrl = (v: string): string | null =>
  v && !HTTPS_URL_RE.test(v) ? 'The IdP SSO URL must be https://.' : null;

export const badSamlCert = (v: string): string | null =>
  v && !v.includes('CERTIFICATE') && !/^[A-Za-z0-9+/=\s]+$/.test(v)
    ? 'The IdP certificate should be the PEM (or base64) X.509 certificate from your IdP.'
    : null;

export const badTimezone = (v: string): string | null =>
  isValidZone(v) ? null : `Invalid IANA timezone: ${v || '(empty)'} — e.g. Asia/Kolkata.`;

export const badAdminEmail = (v: string): string | null =>
  v && !looksLikeEmail(v) ? `"${v}" doesn't look like an email address.` : null;

export const googleSignInOn = (s: AppSettings): boolean => !!(s.oauthClientId && s.oauthClientSecret);
export const samlSignInOn = (s: AppSettings): boolean => !!(s.samlIdpEntityId && s.samlIdpSsoUrl && s.samlIdpCert);

/** Would this change leave the dashboard with no working sign-in path? */
export function locksOut(s: AppSettings, change: Partial<AppSettings>): boolean {
  const after = { ...s, ...change };
  return !after.tokenSignIn && !googleSignInOn(after) && !samlSignInOn(after);
}

export const LOCKOUT_MSG =
  'That would remove the last working sign-in method. Re-enable token sign-in first, or configure the other method.';
export const TOKEN_OFF_MSG =
  'Configure Google or SAML sign-in before turning the token off — otherwise nobody can sign in.';

/** Secrets keep their stored value on an empty save; an explicit clear wipes them. */
export const SECRET_FIELDS = new Set<keyof AppSettings>(['serviceAccountJson', 'oauthClientSecret']);
export const BOOL_FIELDS = new Set<keyof AppSettings>(['calendarOoo', 'tokenSignIn', 'setupComplete']);

export const FIELD_CHECKS: Partial<Record<keyof AppSettings, (v: string) => string | null>> = {
  chatAudience: badAudience,
  serviceAccountJson: badSaKey,
  defaultTimezone: badTimezone,
  workspaceAdminEmail: badAdminEmail,
  oauthClientId: badOauthId,
  samlIdpSsoUrl: badSamlSsoUrl,
  samlIdpCert: badSamlCert,
  samlIdpEntityId: () => null,
  samlAdminAttribute: () => null,
  samlAdminGroup: () => null,
  oauthClientSecret: () => null,
};

export const EDITABLE_FIELDS: (keyof AppSettings)[] = [...BOOL_FIELDS, ...(Object.keys(FIELD_CHECKS) as (keyof AppSettings)[])];

export type FieldChange = { ok: true; change: Partial<AppSettings> } | { ok: false; message: string };

/**
 * Validate one field's new value. Strings are trimmed; `null` clears a
 * secret; an empty string keeps a secret (dashboard boxes submit empty).
 */
export function stageFieldValue(s: AppSettings, requested: string, raw: unknown): FieldChange {
  // Resolve the name from the allowlist so the written property is never the
  // caller's string (and prototype names like "constructor" can't slip through).
  const key = EDITABLE_FIELDS.find((k) => k === requested);
  if (!key) return { ok: false, message: 'Unknown setting.' };
  if (BOOL_FIELDS.has(key)) {
    if (typeof raw !== 'boolean') return { ok: false, message: 'Must be true or false.' };
    if (key === 'tokenSignIn' && !raw && !googleSignInOn(s) && !samlSignInOn(s)) return { ok: false, message: TOKEN_OFF_MSG };
    return { ok: true, change: { [key]: raw } };
  }
  const check = FIELD_CHECKS[key]!;
  if (SECRET_FIELDS.has(key)) {
    if (raw === null) return { ok: true, change: { [key]: '' } };
    if (raw === undefined || String(raw).trim() === '') return { ok: true, change: {} };
  }
  const value = raw === null ? '' : String(raw).trim();
  if (value) {
    const err = check(value);
    if (err) return { ok: false, message: err };
  }
  return { ok: true, change: { [key]: value } };
}

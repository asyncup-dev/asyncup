import { OAuth2Client } from 'google-auth-library';

const CHAT_ISSUER = 'chat@system.gserviceaccount.com';
/** Apps built as Workspace add-ons send standard Google ID tokens instead of Chat's self-signed ones. */
const ADDON_ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];

/** The per-project service account that signs add-on requests. */
export function addonServiceAccount(projectNumber: string): string {
  return `service-${projectNumber}@gcp-sa-gsuiteaddons.iam.gserviceaccount.com`;
}
const CERT_URL = `https://www.googleapis.com/service_accounts/v1/metadata/x509/${CHAT_ISSUER}`;
const CERT_TTL_MS = 60 * 60 * 1000;

/** The x509 metadata endpoint is public — no Google credential is needed (or available) to read it. */
export async function fetchChatCerts(url: string = CERT_URL): Promise<Record<string, string>> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetching Chat signing certs failed: HTTP ${res.status}`);
  return (await res.json()) as Record<string, string>;
}

export type VerifyResult = { ok: true; aud?: string } | { ok: false; reason: string; aud?: string; iss?: string };

interface TokenClaims {
  iss?: string;
  aud?: string;
}

/** Decode (NOT verify) the JWT payload — only for log/diagnostic context. */
export function decodeClaims(token: string): TokenClaims {
  try {
    const segment = token.split('.')[1];
    if (!segment) return {};
    const payload = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    const aud = Array.isArray(payload.aud) ? payload.aud.join(',') : payload.aud;
    return { iss: payload.iss, aud: typeof aud === 'string' ? aud : undefined };
  } catch {
    return {};
  }
}

/**
 * Turn a verification failure into an actionable, token-free reason — so a
 * rejected webhook logs *why* instead of a bare 401.
 */
export function classifyFailure(claims: TokenClaims, audiences: string[], errMessage: string): VerifyResult {
  if (claims.aud && !audiences.includes(claims.aud)) {
    return {
      ok: false,
      reason: `aud mismatch: token aud="${claims.aud}", expected one of [${audiences.join(', ')}]`,
      aud: claims.aud,
      iss: claims.iss,
    };
  }
  if (claims.iss && claims.iss !== CHAT_ISSUER) {
    return { ok: false, reason: `issuer mismatch: got "${claims.iss}", expected ${CHAT_ISSUER}`, iss: claims.iss };
  }
  return { ok: false, reason: `signature or expiry invalid: ${errMessage}`, aud: claims.aud, iss: claims.iss };
}

/**
 * Verifies the Bearer token Google Chat attaches to webhook requests:
 * a JWT signed by chat@system.gserviceaccount.com. The audience is either
 * the app's GCP project number OR the app's HTTP endpoint URL, depending on
 * the Chat API "Audience" configuration — so we accept any of the configured
 * audiences. https://developers.google.com/workspace/chat/verify-requests
 */
export class ChatRequestVerifier {
  private certs: Record<string, string> | null = null;
  private certsFetchedAt = 0;
  private audiences: string[];

  constructor(
    audiences: string | string[],
    /** Overridable for tests. Only its JWT/cert verification is used — it holds no credentials. */
    private client: OAuth2Client = new OAuth2Client(),
    private fetchCerts: (url: string) => Promise<Record<string, string>> = fetchChatCerts,
  ) {
    this.audiences = (Array.isArray(audiences) ? audiences : [audiences]).map((a) => a.trim()).filter(Boolean);
  }

  async verify(authorizationHeader: string | undefined): Promise<VerifyResult> {
    const token = authorizationHeader?.match(/^Bearer (.+)$/)?.[1];
    if (!token) return { ok: false, reason: 'missing or malformed Authorization header' };

    const claims = decodeClaims(token);
    if (claims.iss && ADDON_ISSUERS.includes(claims.iss)) return this.verifyAddonToken(token, claims);
    const certs = await this.getCerts();
    let lastError = 'unknown error';
    for (const audience of this.audiences) {
      try {
        await this.client.verifySignedJwtWithCertsAsync(token, certs, audience, [CHAT_ISSUER]);
        return { ok: true, aud: claims.aud };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }
    return classifyFailure(claims, this.audiences, lastError);
  }

  /**
   * Add-on tokens: audience is the app's events URL, signed with Google's
   * public certs, and the email claim names the project's add-on service
   * account — which is derived from the project number in the audience list.
   * https://developers.google.com/workspace/add-ons/chat/convert
   */
  private async verifyAddonToken(token: string, claims: TokenClaims): Promise<VerifyResult> {
    const context = { aud: claims.aud, iss: claims.iss };
    const projectNumber = this.audiences.find((a) => /^\d+$/.test(a));
    const urls = this.audiences.filter((a) => !/^\d+$/.test(a));
    if (!projectNumber || urls.length === 0) {
      return {
        ok: false,
        reason: 'add-on tokens need both the project number and the /chat/events URL in the audience list',
        ...context,
      };
    }
    try {
      const payload = (await this.client.verifyIdToken({ idToken: token, audience: urls })).getPayload();
      const expected = addonServiceAccount(projectNumber);
      if (payload?.email !== expected || !payload.email_verified) {
        return { ok: false, reason: `add-on service account mismatch: token email="${payload?.email ?? ''}", expected ${expected}`, ...context };
      }
      return { ok: true, aud: claims.aud };
    } catch (err) {
      return { ok: false, reason: `signature or expiry invalid: ${err instanceof Error ? err.message : String(err)}`, ...context };
    }
  }

  private async getCerts(): Promise<Record<string, string>> {
    if (!this.certs || Date.now() - this.certsFetchedAt > CERT_TTL_MS) {
      this.certs = await this.fetchCerts(CERT_URL);
      this.certsFetchedAt = Date.now();
    }
    return this.certs;
  }
}

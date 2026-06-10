import { OAuth2Client } from 'google-auth-library';

const CHAT_ISSUER = 'chat@system.gserviceaccount.com';
const CERT_URL = `https://www.googleapis.com/service_accounts/v1/metadata/x509/${CHAT_ISSUER}`;
const CERT_TTL_MS = 60 * 60 * 1000;

/**
 * Verifies the Bearer token Google Chat attaches to webhook requests:
 * a JWT signed by chat@system.gserviceaccount.com whose audience is the
 * app's GCP project number.
 * https://developers.google.com/workspace/chat/verify-requests
 */
export class ChatRequestVerifier {
  private client = new OAuth2Client();
  private certs: Record<string, string> | null = null;
  private certsFetchedAt = 0;

  constructor(private audience: string) {}

  async verify(authorizationHeader: string | undefined): Promise<boolean> {
    const token = authorizationHeader?.match(/^Bearer (.+)$/)?.[1];
    if (!token) return false;
    try {
      await this.client.verifySignedJwtWithCertsAsync(token, await this.getCerts(), this.audience, [
        CHAT_ISSUER,
      ]);
      return true;
    } catch {
      return false;
    }
  }

  private async getCerts(): Promise<Record<string, string>> {
    if (!this.certs || Date.now() - this.certsFetchedAt > CERT_TTL_MS) {
      const res = await this.client.request<Record<string, string>>({ url: CERT_URL });
      this.certs = res.data;
      this.certsFetchedAt = Date.now();
    }
    return this.certs;
  }
}

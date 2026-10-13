import { JWT } from 'google-auth-library';
import { DirectoryAccessError, type DirectoryUser, type UserDirectory } from '../core/directory.js';

const SCOPE = 'https://www.googleapis.com/auth/admin.directory.user.readonly';

/**
 * Admin SDK Directory lookups, called as the service account itself: give it
 * an admin role with Users › Read, as for group rosters. A Workspace admin
 * email switches to domain-wide delegation, impersonating that admin.
 */
export class GoogleDirectory implements UserDirectory {
  private clientEmail: string;
  private privateKey: string;

  constructor(
    credentialsJson: string,
    private adminEmail = '',
  ) {
    const creds = JSON.parse(credentialsJson);
    this.clientEmail = creds.client_email;
    this.privateKey = creds.private_key;
  }

  async lookup(userKey: string): Promise<DirectoryUser | null> {
    const jwt = new JWT({
      email: this.clientEmail,
      key: this.privateKey,
      ...(this.adminEmail ? { subject: this.adminEmail } : {}),
      scopes: [SCOPE],
    });
    try {
      const res = await jwt.request<{
        id?: string;
        primaryEmail?: string;
        isAdmin?: boolean;
        isDelegatedAdmin?: boolean;
        suspended?: boolean;
      }>({
        url: `https://admin.googleapis.com/admin/directory/v1/users/${encodeURIComponent(userKey)}`,
        params: { fields: 'id,primaryEmail,isAdmin,isDelegatedAdmin,suspended' },
      });
      return {
        id: res.data.id ?? null,
        email: res.data.primaryEmail ?? null,
        isAdmin: !!(res.data.isAdmin || res.data.isDelegatedAdmin),
        suspended: !!res.data.suspended,
      };
    } catch (err: any) {
      const status = err?.response?.status ?? err?.code;
      if (status === 404) return null;
      if (status === 403 && !this.adminEmail) {
        throw new DirectoryAccessError(`AsyncUp can't read users. In the Admin console, give ${this.clientEmail} an admin role with Users › Read, and enable the Admin SDK API in its Google Cloud project.`);
      }
      throw err;
    }
  }
}

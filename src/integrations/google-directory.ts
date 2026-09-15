import { JWT } from 'google-auth-library';
import type { DirectoryUser, UserDirectory } from '../core/directory.js';

const SCOPE = 'https://www.googleapis.com/auth/admin.directory.user.readonly';

/**
 * Admin SDK Directory lookups. Requires the service-account key with
 * domain-wide delegation for admin.directory.user.readonly, impersonating a
 * Workspace admin (the "Workspace admin email" dashboard setting) — Directory
 * reads are only permitted to admin subjects.
 */
export class GoogleDirectory implements UserDirectory {
  private clientEmail: string;
  private privateKey: string;

  constructor(
    credentialsJson: string,
    private adminEmail: string,
  ) {
    const creds = JSON.parse(credentialsJson);
    this.clientEmail = creds.client_email;
    this.privateKey = creds.private_key;
  }

  async lookup(userKey: string): Promise<DirectoryUser | null> {
    const jwt = new JWT({
      email: this.clientEmail,
      key: this.privateKey,
      subject: this.adminEmail,
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
      if (err?.response?.status === 404 || err?.code === 404) return null;
      throw err;
    }
  }
}

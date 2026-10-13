import { JWT } from 'google-auth-library';
import { chatUserName } from '../core/directory.js';
import { GroupAccessError, type GroupDirectory, type GroupListing } from '../core/groups.js';

const SCOPES = ['https://www.googleapis.com/auth/admin.directory.group.readonly', 'https://www.googleapis.com/auth/admin.directory.user.readonly'];
const DIRECTORY = 'https://admin.googleapis.com/admin/directory/v1';

/**
 * Group members through the Admin SDK, called as the service account itself.
 * Google recommends an admin role on the service account over domain-wide
 * delegation: give it a custom role with Groups › Read and Users › Read, and
 * enable the Admin SDK API in its project. No user is impersonated.
 */
export class GoogleGroupDirectory implements GroupDirectory {
  private clientEmail: string;
  private privateKey: string;

  constructor(credentialsJson: string) {
    const creds = JSON.parse(credentialsJson);
    this.clientEmail = creds.client_email;
    this.privateKey = creds.private_key;
  }

  async listMembers(group: string): Promise<GroupListing> {
    const jwt = new JWT({ email: this.clientEmail, key: this.privateKey, scopes: SCOPES });
    const refused = (err: any): never => {
      const status = err?.response?.status ?? err?.code;
      if (status === 404) throw new GroupAccessError(`There is no Google Group ${group}.`);
      if (status === 403) {
        throw new GroupAccessError(
          `AsyncUp can't read ${group}. In the Admin console, give ${this.clientEmail} an admin role with Groups › Read and Users › Read, and enable the Admin SDK API in its Google Cloud project.`,
        );
      }
      throw err;
    };

    const rows: { id: string; email: string; type: string; status?: string }[] = [];
    let pageToken: string | undefined;
    do {
      const res = await jwt
        .request<{ members?: { id: string; email: string; type: string; status?: string }[]; nextPageToken?: string }>({
          url: `${DIRECTORY}/groups/${encodeURIComponent(group)}/members`,
          params: { includeDerivedMembership: true, maxResults: 200, ...(pageToken ? { pageToken } : {}) },
        })
        .catch(refused);
      rows.push(...(res.data.members ?? []));
      pageToken = res.data.nextPageToken;
    } while (pageToken);

    const listing: GroupListing = { members: [], skipped: [] };
    const seen = new Set<string>();
    for (const m of rows) {
      // Nested groups come back flattened alongside their own entry, which needs no row.
      if (m.type === 'GROUP' || seen.has(m.id)) continue;
      seen.add(m.id);
      if (m.type !== 'USER') {
        listing.skipped.push({ email: m.email, reason: 'outside your Workspace' });
        continue;
      }
      if (m.status && m.status !== 'ACTIVE') {
        listing.skipped.push({ email: m.email, reason: 'not active' });
        continue;
      }
      const user = await jwt
        .request<{ name?: { fullName?: string }; suspended?: boolean }>({ url: `${DIRECTORY}/users/${m.id}`, params: { fields: 'name/fullName,suspended' } })
        .catch((err: any) => {
          if ((err?.response?.status ?? err?.code) === 404) return null;
          return refused(err);
        });
      if (!user) listing.skipped.push({ email: m.email, reason: 'no longer in the directory' });
      else if (user.data.suspended) listing.skipped.push({ email: m.email, reason: 'suspended' });
      else listing.members.push({ userName: chatUserName(m.id), displayName: user.data.name?.fullName || m.email, email: m.email });
    }
    return listing;
  }
}

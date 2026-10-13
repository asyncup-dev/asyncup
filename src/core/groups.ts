/** A person in a Google Group, as a Chat user the bot can prompt. */
export interface GroupMember {
  userName: string;
  displayName: string;
  email: string;
}

export interface GroupListing {
  members: GroupMember[];
  /** Members who can't be on a standup, with why: outside the Workspace, suspended, not active. */
  skipped: { email: string; reason: string }[];
}

/** Reads a Google Group's members, nested groups included. */
export interface GroupDirectory {
  listMembers(group: string): Promise<GroupListing>;
}

/** The group can't be read: it doesn't exist, or the service account lacks the role. The message says which. */
export class GroupAccessError extends Error {
  // Explicit so Bun's function coverage can see it being called.
  constructor(message: string) {
    super(message);
  }
}

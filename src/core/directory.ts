/**
 * Workspace user directory. Callers treat lookup failures as "unknown user"
 * — directory access is an optional integration, never a hard dependency.
 */
export interface DirectoryUser {
  /** Google user id — the digits in Chat's "users/<id>" resource names. */
  id: string | null;
  email: string | null;
  /** Google Workspace super admin or delegated admin. */
  isAdmin: boolean;
  suspended: boolean;
}

export interface UserDirectory {
  /** userKey: a Google user id (the digits of "users/<id>") or an email. */
  lookup(userKey: string): Promise<DirectoryUser | null>;
}

/** "users/1234" → "1234"; anything else passes through (emails, plain ids). */
export function directoryKey(chatUserName: string): string {
  return chatUserName.replace(/^users\//, '');
}

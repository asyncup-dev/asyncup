/**
 * Answers "is this person out of office on this date?" — implemented by
 * platform integrations (Google Calendar today). Failures should throw;
 * callers treat errors as "not OOO".
 */
export interface OooChecker {
  isOoo(email: string, date: string, timezone: string): Promise<boolean>;
}

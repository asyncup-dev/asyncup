import { signWebhookBody } from './crypto.js';
import type { RunSummary, Standup, Submission } from './types.js';

export type WebhookEvent =
  | {
      event: 'submission';
      standup: { id: number; name: string };
      date: string;
      user: string;
      answers: { question: string; answer: string }[];
      mood: string | null;
      late: boolean;
      edited: boolean;
    }
  | {
      event: 'wrap_up';
      standup: { id: number; name: string };
      date: string;
      summary: RunSummary;
    };

/**
 * Fire-and-forget JSON POSTs to a standup's configured webhook URL — the
 * cheap integration path (Sheets via Apps Script, Zapier/n8n, your own
 * service). Failures are logged, never propagated: a dead webhook must not
 * break submissions or wrap-ups.
 */
export class WebhookNotifier {
  constructor(
    private log: (msg: string) => void = (msg) => console.log(`[webhook] ${msg}`),
    private fetchFn: typeof fetch = fetch,
    private timeoutMs = 5_000,
    /** Per-standup signing secret; empty string disables signing. */
    private secretFor: (standupId: number) => string = () => '',
  ) {}

  async submission(standup: Standup, date: string, submission: Submission, edited: boolean): Promise<void> {
    await this.send(standup, {
      event: 'submission',
      standup: { id: standup.id, name: standup.name },
      date,
      user: submission.displayName,
      answers: submission.answers,
      mood: submission.mood,
      late: submission.late,
      edited,
    });
  }

  async wrapUp(standup: Standup, date: string, summary: RunSummary): Promise<void> {
    await this.send(standup, {
      event: 'wrap_up',
      standup: { id: standup.id, name: standup.name },
      date,
      summary,
    });
  }

  /** A signed test event, reporting the outcome instead of swallowing it. */
  async test(standup: Standup): Promise<{ ok: true; status: number } | { ok: false; error: string }> {
    const body = JSON.stringify({ event: 'test', standup: { id: standup.id, name: standup.name } });
    const secret = this.secretFor(standup.id);
    try {
      const res = await this.fetchFn(standup.webhookUrl!, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'asyncup-webhook',
          ...(secret ? { 'x-asyncup-signature': `sha256=${signWebhookBody(secret, body)}` } : {}),
        },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      return res.ok ? { ok: true, status: res.status } : { ok: false, error: `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async send(standup: Standup, payload: WebhookEvent): Promise<void> {
    if (!standup.webhookUrl) return;
    try {
      const body = JSON.stringify(payload);
      const secret = this.secretFor(standup.id);
      const res = await this.fetchFn(standup.webhookUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'asyncup-webhook',
          ...(secret ? { 'x-asyncup-signature': `sha256=${signWebhookBody(secret, body)}` } : {}),
        },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) this.log(`${payload.event} → ${standup.webhookUrl} answered ${res.status}`);
    } catch (err) {
      this.log(`${payload.event} → ${standup.webhookUrl} failed: ${err}`);
    }
  }
}

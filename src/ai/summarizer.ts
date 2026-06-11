import type { LlmComplete } from './llm.js';
import { MOOD_LABEL, type Run, type Standup, type Submission, type WeeklyDigest } from '../core/types.js';

const DAILY_SYSTEM = `You summarize a team's async daily standup for a busy lead.
Write 3-5 short bullet points in plain text (no markdown headers): main themes,
notable progress, risks, and any blockers that need attention. Mention people by
name only when it adds clarity. Be concrete and terse — no filler, no preamble.`;

const WEEKLY_SYSTEM = `You write a short "week in review" for a team based on their
daily standups. Plain text, max 6 bullet points: what moved forward, recurring
themes, unresolved blockers, and anything a team lead should follow up on next
week. Terse and concrete — no filler, no preamble.`;

function submissionToText(s: Submission): string {
  const answers = s.answers.map((a) => `  ${a.question} ${a.answer}`).join('\n');
  const mood = s.mood ? ` (mood: ${MOOD_LABEL[s.mood]})` : '';
  return `${s.displayName}${mood}:\n${answers}`;
}

export class AiSummarizer {
  constructor(private complete: LlmComplete) {}

  async dailySummary(standup: Standup, run: Run, submissions: Submission[]): Promise<string> {
    const prompt =
      `Standup "${standup.name}" for ${run.date}. Submissions:\n\n` +
      submissions.map(submissionToText).join('\n\n');
    return this.complete(DAILY_SYSTEM, prompt);
  }

  async weeklySummary(
    standup: Standup,
    digest: WeeklyDigest,
    submissions: { submission: Submission; runDate: string }[],
  ): Promise<string> {
    const prompt =
      `Standup "${standup.name}", week ${digest.weekStart} to ${digest.weekEnd}. ` +
      `Participation ${digest.participationPct}%. Submissions by day:\n\n` +
      submissions.map(({ runDate, submission }) => `[${runDate}] ${submissionToText(submission)}`).join('\n\n');
    return this.complete(WEEKLY_SYSTEM, prompt);
  }
}

import type { Repo } from '../db/repo.js';
import type { Standup } from './types.js';

function csvField(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Long-format CSV: one row per answered question per submission. */
export async function buildCsv(repo: Repo, standup: Standup, fromDate: string, toDate: string): Promise<string> {
  const rows = [['date', 'standup', 'person', 'late', 'edited', 'mood', 'question', 'answer']];
  for (const { submission, runDate } of await repo.listSubmissionsBetween(standup.id, fromDate, toDate)) {
    for (const answer of submission.answers) {
      rows.push([
        runDate,
        standup.name,
        submission.displayName,
        submission.late ? 'yes' : 'no',
        submission.editedAt ? 'yes' : 'no',
        submission.mood ?? '',
        answer.question,
        answer.answer,
      ]);
    }
  }
  return rows.map((row) => row.map(csvField).join(',')).join('\n') + '\n';
}

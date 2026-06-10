import { DateTime } from 'luxon';
import {
  hasBlockers,
  MOOD_EMOJI,
  MOOD_LABEL,
  MOODS,
  type Run,
  type RunSummary,
  type Standup,
  type Submission,
} from '../../core/types.js';

export const OPEN_DIALOG_FN = 'openStandupDialog';
export const SUBMIT_DIALOG_FN = 'submitStandup';

function humanDate(isoDate: string): string {
  return DateTime.fromISO(isoDate).toFormat('ccc, dd LLL yyyy');
}

function fillButton(runId: number, label: string) {
  return {
    buttonList: {
      buttons: [
        {
          text: label,
          onClick: {
            action: {
              function: OPEN_DIALOG_FN,
              interaction: 'OPEN_DIALOG',
              parameters: [{ key: 'runId', value: String(runId) }],
            },
          },
        },
      ],
    },
  };
}

/** DM card asking the participant to fill in today's standup. */
export function promptMessage(standup: Standup, run: Run) {
  return {
    cardsV2: [
      {
        cardId: `standup-prompt-${run.id}`,
        card: {
          header: { title: `📋 ${standup.name}`, subtitle: humanDate(run.date) },
          sections: [
            {
              widgets: [
                {
                  textParagraph: {
                    text: `Good morning! Time for your async standup — it takes a minute. Due by <b>${standup.deadlineTime} ${standup.timezone}</b>.`,
                  },
                },
                fillButton(run.id, 'Fill standup'),
              ],
            },
          ],
        },
      },
    ],
  };
}

/** DM card nudging a participant who has not submitted yet. */
export function reminderMessage(standup: Standup, run: Run) {
  return {
    cardsV2: [
      {
        cardId: `standup-reminder-${run.id}`,
        card: {
          sections: [
            {
              widgets: [
                {
                  textParagraph: {
                    text: `⏰ Reminder: your <b>${standup.name}</b> for ${humanDate(run.date)} is still open — it closes at <b>${standup.deadlineTime} ${standup.timezone}</b>.`,
                  },
                },
                fillButton(run.id, 'Fill standup now'),
              ],
            },
          ],
        },
      },
    ],
  };
}

/** Modal dialog with the four standup questions. */
export function standupDialog(runId: number) {
  return {
    actionResponse: {
      type: 'DIALOG',
      dialogAction: {
        dialog: {
          body: {
            sections: [
              {
                widgets: [
                  {
                    textInput: {
                      name: 'yesterday',
                      label: 'What did you do yesterday?',
                      type: 'MULTIPLE_LINE',
                    },
                  },
                  {
                    textInput: {
                      name: 'today',
                      label: 'What will you do today?',
                      type: 'MULTIPLE_LINE',
                    },
                  },
                  {
                    textInput: {
                      name: 'blockers',
                      label: 'Any blockers?',
                      type: 'MULTIPLE_LINE',
                      hintText: 'Write "none" if you have no blockers',
                    },
                  },
                  {
                    selectionInput: {
                      name: 'mood',
                      label: 'How is your mood today?',
                      type: 'DROPDOWN',
                      items: MOODS.map((m) => ({ text: MOOD_LABEL[m], value: m, selected: false })),
                    },
                  },
                  {
                    buttonList: {
                      buttons: [
                        {
                          text: 'Submit',
                          onClick: {
                            action: {
                              function: SUBMIT_DIALOG_FN,
                              parameters: [{ key: 'runId', value: String(runId) }],
                            },
                          },
                        },
                      ],
                    },
                  },
                ],
              },
            ],
          },
        },
      },
    },
  };
}

/** Plain text that opens the day's thread in the report space. */
export function threadParentText(standup: Standup, run: Run): string {
  return `📅 *${standup.name}* — ${humanDate(run.date)}`;
}

/** One participant's answers, posted as a reply in the day's thread. */
export function submissionMessage(submission: Submission) {
  const blockers = hasBlockers(submission.blockers)
    ? `⚠️ ${submission.blockers}`
    : '✅ None';
  return {
    cardsV2: [
      {
        cardId: `submission-${submission.id}`,
        card: {
          header: {
            title: `${MOOD_EMOJI[submission.mood]} ${submission.displayName}`,
            subtitle: submission.late ? 'Submitted late' : undefined,
          },
          sections: [
            {
              widgets: [
                { decoratedText: { topLabel: 'Yesterday', text: submission.yesterday, wrapText: true } },
                { decoratedText: { topLabel: 'Today', text: submission.today, wrapText: true } },
                { decoratedText: { topLabel: 'Blockers', text: blockers, wrapText: true } },
              ],
            },
          ],
        },
      },
    ],
  };
}

/** End-of-run report text: count + names of missing mandatory participants. */
export function summaryText(summary: RunSummary): string {
  const lines = [
    `📊 *${summary.standupName}* — ${humanDate(summary.date)} wrap-up`,
    summary.mandatoryTotal === 0
      ? 'No mandatory participants configured.'
      : `✅ *${summary.mandatorySubmitted}/${summary.mandatoryTotal}* mandatory submitted`,
  ];
  if (summary.missingMandatory.length > 0) {
    lines.push(`❌ Missing: ${summary.missingMandatory.join(', ')}`);
  } else if (summary.mandatoryTotal > 0) {
    lines.push('🎉 Everyone submitted!');
  }
  if (summary.optionalSubmitted > 0) lines.push(`➕ ${summary.optionalSubmitted} optional submitted`);
  if (summary.lateCount > 0) lines.push(`⏰ ${summary.lateCount} late`);
  return lines.join('\n');
}

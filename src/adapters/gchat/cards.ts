import { DateTime } from 'luxon';
import { moodEmoji as moodEmojiFor } from '../../core/insights.js';
import {
  isBlockerQuestion,
  isRealBlocker,
  MOOD_EMOJI,
  MOOD_LABEL,
  MOODS,
  type Blocker,
  type Run,
  type RunSummary,
  type Standup,
  type Submission,
  type Poll,
} from '../../core/types.js';

export const OPEN_DIALOG_FN = 'openStandupDialog';
export const SUBMIT_DIALOG_FN = 'submitStandup';
export const SKIP_TODAY_FN = 'skipToday';
export const ACK_BLOCKER_FN = 'ackBlocker';
export const RESOLVE_BLOCKER_FN = 'resolveBlocker';
export const OPEN_BLOCKER_UPDATE_FN = 'openBlockerUpdate';
export const SUBMIT_BLOCKER_UPDATE_FN = 'submitBlockerUpdate';
export const VOTE_POLL_FN = 'votePoll';

function humanDate(isoDate: string): string {
  return DateTime.fromISO(isoDate).toFormat('ccc, dd LLL yyyy');
}

type Param = { key: string; value: string };

/**
 * Apps built as Workspace add-ons must address clicks to their events URL and
 * carry the action name as a parameter; the interaction-event format treats
 * `function` as an opaque string, so the same shape serves both.
 */
export function clickAction(fn: string, parameters: Param[], endpoint: string | null, interaction?: 'OPEN_DIALOG') {
  return {
    function: endpoint ?? fn,
    ...(interaction ? { interaction } : {}),
    parameters: endpoint ? [{ key: 'fn', value: fn }, ...parameters] : parameters,
  };
}

function promptButtons(runId: number, fillLabel: string, endpoint: string | null) {
  const param = [{ key: 'runId', value: String(runId) }];
  return {
    buttonList: {
      buttons: [
        { text: fillLabel, onClick: { action: clickAction(OPEN_DIALOG_FN, param, endpoint, 'OPEN_DIALOG') } },
        { text: '🏖️ Skip today', onClick: { action: clickAction(SKIP_TODAY_FN, param, endpoint) } },
      ],
    },
  };
}

/** DM card asking the participant to fill in today's standup. */
export function promptMessage(standup: Standup, run: Run, endpoint: string | null = null) {
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
                    text: `Good morning! Time for your async standup — it takes a minute. Due by <b>${standup.deadlineTime} ${standup.timezone}</b>. You can re-open the form to edit until the deadline.`,
                  },
                },
                promptButtons(run.id, 'Fill standup', endpoint),
              ],
            },
          ],
        },
      },
    ],
  };
}

/** DM card nudging a participant who has not submitted yet. */
export function reminderMessage(standup: Standup, run: Run, endpoint: string | null = null) {
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
                promptButtons(run.id, 'Fill standup now', endpoint),
              ],
            },
          ],
        },
      },
    ],
  };
}

/**
 * Modal dialog built from the standup's question list.
 * Inputs are named q0..qN; prefill values align with the questions array.
 */
export function standupDialog(
  runId: number,
  questions: string[],
  moodEnabled: boolean,
  prefill: string[],
  endpoint: string | null = null,
) {
  const widgets: any[] = questions.map((question, i) => ({
    textInput: {
      name: `q${i}`,
      label: question,
      type: 'MULTIPLE_LINE',
      value: prefill[i] || undefined,
      hintText: isBlockerQuestion(question) ? 'Write "none" if you have no blockers' : undefined,
    },
  }));

  if (moodEnabled) {
    widgets.push({
      selectionInput: {
        name: 'mood',
        label: 'How is your mood today?',
        type: 'DROPDOWN',
        items: MOODS.map((m) => ({ text: MOOD_LABEL[m], value: m, selected: false })),
      },
    });
  }

  widgets.push({
    buttonList: {
      buttons: [
        { text: 'Submit', onClick: { action: clickAction(SUBMIT_DIALOG_FN, [{ key: 'runId', value: String(runId) }], endpoint) } },
      ],
    },
  });

  return {
    actionResponse: {
      type: 'DIALOG',
      dialogAction: { dialog: { body: { sections: [{ widgets }] } } },
    },
  };
}

/** Interactive DM card for someone tagged on (or nudged about) a blocker. */
export function blockerCard(standup: Standup, blocker: Blocker, note: string, endpoint: string | null = null) {
  const param = [{ key: 'blockerId', value: String(blocker.id) }];
  return {
    cardsV2: [
      {
        cardId: `blocker-${blocker.id}`,
        card: {
          header: { title: `⚠️ Blocker #${blocker.id} — ${standup.name}`, subtitle: note },
          sections: [
            {
              widgets: [
                {
                  decoratedText: {
                    topLabel: `Reported by ${blocker.displayName} on ${blocker.openedDate}`,
                    text: blocker.text,
                    wrapText: true,
                  },
                },
                {
                  buttonList: {
                    buttons: [
                      { text: '✋ Acknowledge', onClick: { action: clickAction(ACK_BLOCKER_FN, param, endpoint) } },
                      {
                        text: '📝 Add update',
                        onClick: {
                          action: clickAction(OPEN_BLOCKER_UPDATE_FN, param, endpoint, 'OPEN_DIALOG'),
                        },
                      },
                      { text: '✅ Resolve', onClick: { action: clickAction(RESOLVE_BLOCKER_FN, param, endpoint) } },
                    ],
                  },
                },
              ],
            },
          ],
        },
      },
    ],
  };
}

/** Modal dialog for posting a blocker update. */
export function blockerUpdateDialog(blockerId: number, endpoint: string | null = null) {
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
                      name: 'update',
                      label: 'What is the latest on this blocker?',
                      type: 'MULTIPLE_LINE',
                    },
                  },
                  {
                    buttonList: {
                      buttons: [
                        {
                          text: 'Post update',
                          onClick: {
                            action: clickAction(SUBMIT_BLOCKER_UPDATE_FN, [{ key: 'blockerId', value: String(blockerId) }], endpoint),
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

/** Interactive poll card — one vote button per option, live tallies. */
export function pollMessage(poll: Poll, tallies: number[], closed = false, endpoint: string | null = null) {
  const total = tallies.reduce((a, b) => a + b, 0);
  return {
    cardsV2: [
      {
        cardId: `poll-${poll.id}`,
        card: {
          header: {
            title: `📊 ${poll.question}`,
            subtitle: `Poll #${poll.id} by ${poll.createdDisplay}${closed ? ' — closed' : ''}`,
          },
          sections: [
            {
              widgets: [
                ...poll.options.map((option, i) => ({
                  decoratedText: {
                    text: option,
                    bottomLabel: `${tallies[i] ?? 0} vote${tallies[i] === 1 ? '' : 's'}`,
                    wrapText: true,
                    ...(closed
                      ? {}
                      : {
                          button: {
                            text: 'Vote',
                            onClick: {
                              action: clickAction(
                                VOTE_POLL_FN,
                                [
                                  { key: 'pollId', value: String(poll.id) },
                                  { key: 'optionIndex', value: String(i) },
                                ],
                                endpoint,
                              ),
                            },
                          },
                        }),
                  },
                })),
                {
                  textParagraph: {
                    text: closed
                      ? `<i>${total} vote${total === 1 ? '' : 's'} — final.</i>`
                      : `<i>${total} vote${total === 1 ? '' : 's'} so far. Vote again to change yours. Close with</i> <b>poll ${poll.id} close</b>.`,
                  },
                },
              ],
            },
          ],
        },
      },
    ],
  };
}

/** Plain text that opens the day's thread in the report space. */
export function threadParentText(standup: Standup, run: Run): string {
  return `📅 *${standup.name}* — ${humanDate(run.date)}`;
}

/** One participant's answers, posted (or updated) as a reply in the day's thread. */
export function submissionMessage(submission: Submission, anonymousMood = false) {
  const flags = [
    submission.late ? 'Submitted late' : null,
    submission.editedAt ? 'edited' : null,
  ].filter(Boolean);
  const showMood = submission.mood && !anonymousMood;

  return {
    cardsV2: [
      {
        cardId: `submission-${submission.id}`,
        card: {
          header: {
            title: `${showMood ? MOOD_EMOJI[submission.mood!] : '📝'} ${submission.displayName}`,
            subtitle: flags.length ? flags.join(' · ') : undefined,
          },
          sections: [
            {
              widgets: submission.answers.map((a) => ({
                decoratedText: {
                  topLabel: a.question,
                  text:
                    isBlockerQuestion(a.question) && !isRealBlocker(a.answer)
                      ? '✅ None'
                      : isBlockerQuestion(a.question)
                        ? `⚠️ ${a.answer}`
                        : a.answer,
                  wrapText: true,
                },
              })),
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
      ? 'No mandatory participants expected today.'
      : `✅ *${summary.mandatorySubmitted}/${summary.mandatoryTotal}* mandatory submitted`,
  ];
  if (summary.missingMandatory.length > 0) {
    lines.push(`❌ Missing: ${summary.missingMandatory.join(', ')}`);
  } else if (summary.mandatoryTotal > 0) {
    lines.push('🎉 Everyone submitted!');
  }
  if (summary.teamMood !== null) lines.push(`💭 Team mood today: ${moodEmojiFor(summary.teamMood)} ${summary.teamMood}/5`);
  if (summary.away.length > 0) lines.push(`🏖️ Away: ${summary.away.join(', ')}`);
  if (summary.optionalSubmitted > 0) lines.push(`➕ ${summary.optionalSubmitted} optional submitted`);
  if (summary.lateCount > 0) lines.push(`⏰ ${summary.lateCount} late`);
  if (summary.openBlockers > 0) {
    lines.push(`⚠️ ${summary.openBlockers} open blocker${summary.openBlockers === 1 ? '' : 's'}`);
  }
  return lines.join('\n');
}

import type { PromptState } from '../../core/adapter.js';
import { describeDates, type TimeOffRequest } from '../../core/schedule.js';
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
export const UNSKIP_FN = 'unskipToday';
export const OPEN_TAG_FN = 'openTagBlocker';
export const SUBMIT_TAG_FN = 'submitTagBlocker';
export const ACK_BLOCKER_FN = 'ackBlocker';
export const RESOLVE_BLOCKER_FN = 'resolveBlocker';
export const OPEN_BLOCKER_UPDATE_FN = 'openBlockerUpdate';
export const SUBMIT_BLOCKER_UPDATE_FN = 'submitBlockerUpdate';
export const VOTE_POLL_FN = 'votePoll';
export const APPROVE_REQUEST_FN = 'approveTimeOff';
export const DECLINE_REQUEST_FN = 'declineTimeOff';
export const SUBMIT_DECLINE_FN = 'submitDeclineTimeOff';

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

/** The prompt card's text and buttons for where the person stands on the run. */
function promptBody(standup: Standup, run: Run, state: PromptState, endpoint: string | null) {
  const param = [{ key: 'runId', value: String(run.id) }];
  const due = `<b>${standup.deadlineTime} ${standup.timezone}</b>`;
  if (state.kind === 'submitted') {
    const at = DateTime.fromISO(state.at).setZone(standup.timezone).toFormat('HH:mm');
    return [
      { textParagraph: { text: `✅ Submitted at <b>${at}</b>${state.late ? ' (late)' : ''}. You can edit your answers until ${due}.` } },
      { buttonList: { buttons: [{ text: 'Edit answers', onClick: { action: clickAction(OPEN_DIALOG_FN, param, endpoint, 'OPEN_DIALOG') } }] } },
    ];
  }
  if (state.kind === 'skipped') {
    return [
      { textParagraph: { text: `🏖️ You skipped today, so you won’t be counted as missing. Changed your mind? Undo it before ${due}.` } },
      { buttonList: { buttons: [{ text: '↩️ Undo skip', onClick: { action: clickAction(UNSKIP_FN, param, endpoint) } }] } },
    ];
  }
  return [
    {
      textParagraph: {
        text: `Good morning! Time for your async standup — it takes a minute. Due by ${due}. You can re-open the form to edit until the deadline.`,
      },
    },
    promptButtons(run.id, 'Fill standup', endpoint),
  ];
}

/** DM card asking the participant to fill in today's standup; later rewritten to show they submitted or skipped. */
export function promptMessage(standup: Standup, run: Run, endpoint: string | null = null, state: PromptState = { kind: 'open' }) {
  return {
    cardsV2: [
      {
        cardId: `standup-prompt-${run.id}`,
        card: {
          header: { title: `📋 ${standup.name}`, subtitle: humanDate(run.date) },
          sections: [{ widgets: promptBody(standup, run, state, endpoint) }],
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

/** Pick people in the Workspace to tag on a blocker; they get the blocker card. */
export function tagBlockerDialog(blocker: Blocker, endpoint: string | null = null) {
  return {
    actionResponse: {
      type: 'DIALOG',
      dialogAction: {
        dialog: {
          body: {
            sections: [
              {
                header: `Blocker #${blocker.id}`,
                widgets: [
                  { textParagraph: { text: blocker.text } },
                  {
                    selectionInput: {
                      name: 'people',
                      label: 'Who can help?',
                      type: 'MULTI_SELECT',
                      multiSelectMaxSelectedItems: 10,
                      multiSelectMinQueryLength: 1,
                      platformDataSource: { commonDataSource: 'USER' },
                    },
                  },
                  {
                    buttonList: {
                      buttons: [{ text: 'Tag', onClick: { action: clickAction(SUBMIT_TAG_FN, [{ key: 'blockerId', value: String(blocker.id) }], endpoint) } }],
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

/**
 * Interactive DM card for a blocker: for someone tagged on (or nudged about)
 * it, or, with `owner`, for the person who raised it, who can't acknowledge
 * their own blocker but can pull people in.
 */
export function blockerCard(standup: Standup, blocker: Blocker, note: string, endpoint: string | null = null, owner = false) {
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
                      ...(owner ? [] : [{ text: '✋ Acknowledge', onClick: { action: clickAction(ACK_BLOCKER_FN, param, endpoint) } }]),
                      { text: '👥 Tag people', onClick: { action: clickAction(OPEN_TAG_FN, param, endpoint, 'OPEN_DIALOG') } },
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

/** DM card for a manager: a time-off (or extra working day) request with Approve / Decline. */
export function timeOffRequestCard(request: TimeOffRequest, endpoint: string | null = null) {
  const params = [{ key: 'requestIds', value: request.ids.join(',') }];
  const when = describeDates(request.dates);
  const days = request.dates.length;
  return {
    cardsV2: [
      {
        cardId: `time-off-${request.ids[0]}`,
        card: {
          header: {
            title: `${request.working ? 'Working day' : 'Time-off'} request · ${request.standup.name}`,
            subtitle: `${request.person.displayName} · ${when} · ${days} day${days === 1 ? '' : 's'} ${request.working ? 'working' : 'off'}`,
          },
          sections: [
            {
              widgets: [
                {
                  textParagraph: {
                    text: `${request.reason ? `“${request.reason}” ` : ''}Approve and ${request.person.displayName} is ${request.working ? 'prompted as usual' : 'marked away for those runs — no prompt, not counted as missing'}. Decline and they are asked to talk to you. Unanswered by the run's deadline, it lapses and they count as expected.`,
                  },
                },
                {
                  buttonList: {
                    buttons: [
                      { text: 'Approve', onClick: { action: clickAction(APPROVE_REQUEST_FN, params, endpoint) } },
                      { text: 'Decline', onClick: { action: clickAction(DECLINE_REQUEST_FN, params, endpoint, 'OPEN_DIALOG') } },
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

/** Dialog asking the manager for a one-line reason before declining. */
export function declineDialog(requestIds: string, endpoint: string | null = null) {
  return {
    actionResponse: {
      type: 'DIALOG',
      dialogAction: {
        dialog: {
          body: {
            sections: [
              {
                widgets: [
                  { textInput: { name: 'note', label: 'Why not? (sent to the person)', type: 'MULTIPLE_LINE' } },
                  {
                    buttonList: {
                      buttons: [{ text: 'Decline request', onClick: { action: clickAction(SUBMIT_DECLINE_FN, [{ key: 'requestIds', value: requestIds }], endpoint) } }],
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

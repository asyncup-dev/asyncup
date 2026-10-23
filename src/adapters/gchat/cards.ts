import type { PromptState } from '../../core/adapter.js';
import { dayLabel, untilLabel, type EditRequestView } from '../../core/edit-requests.js';
import { toCardHtml } from '../../core/format.js';
import { POLL_LIMITS, type PollAnswer, type PollCardState, type PollCounts, type PollView } from '../../core/question-polls.js';
import { describeDates, type TimeOffRequest } from '../../core/schedule.js';
import { DateTime } from 'luxon';
import { LIMITS } from '../../core/validation.js';
import {
  isBlockerQuestion,
  isRealBlocker,
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
export const OPEN_SKIP_FN = 'openSkipDialog';
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
export const OPEN_EDIT_REQUEST_FN = 'openEditRequest';
export const SUBMIT_EDIT_REQUEST_FN = 'submitEditRequest';
export const APPROVE_EDIT_FN = 'approveEdit';
export const DECLINE_EDIT_FN = 'declineEdit';
export const SUBMIT_EDIT_DECLINE_FN = 'submitDeclineEdit';
export const OPEN_POLL_FORM_FN = 'openPollForm';
export const SUBMIT_POLL_FORM_FN = 'submitPollForm';

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

/** User text inside card HTML. */
function html(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** The thread reply announcing a skip; angle brackets are swapped so a reason cannot mention anyone. */
export function skipText(displayName: string, note: string): string {
  return `🏖️ *${displayName}* is skipping today: ${note.replace(/</g, '‹').replace(/>/g, '›')}`;
}

function promptButtons(runId: number, fillLabel: string, endpoint: string | null) {
  const param = [{ key: 'runId', value: String(runId) }];
  return {
    buttonList: {
      buttons: [
        { text: fillLabel, onClick: { action: clickAction(OPEN_DIALOG_FN, param, endpoint, 'OPEN_DIALOG') } },
        { text: '🏖️ Skip today', onClick: { action: clickAction(OPEN_SKIP_FN, param, endpoint, 'OPEN_DIALOG') } },
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
    const done = `✅ Submitted at <b>${at}</b>${state.late ? ' (late)' : ''}.`;
    const button = (text: string, fn: string) => ({ buttonList: { buttons: [{ text, onClick: { action: clickAction(fn, param, endpoint, 'OPEN_DIALOG') } }] } });
    const line = (text: string) => ({ textParagraph: { text: `${done} ${text}` } });
    if (!state.closed) return [line(`You can edit your answers until ${due}.`), button('Edit answers', OPEN_DIALOG_FN)];
    const edit = state.edit;
    if (!edit) return [line('The deadline has passed. Need to change something? Ask a manager.'), button('Ask to edit', OPEN_EDIT_REQUEST_FN)];
    if (edit.status === 'approved') return [line(`${html(edit.by!)} approved your request: you can edit your answers until <b>${edit.until}</b>.`), button('Edit answers', OPEN_DIALOG_FN)];
    if (edit.status === 'pending') return [line('Your request to edit is waiting for a manager.')];
    if (edit.status === 'declined') return [line(`${html(edit.by!)} declined your request to edit.`)];
    return [line('Your request to edit lapsed.')];
  }
  if (state.kind === 'removed') {
    return [{ textParagraph: { text: 'You’re no longer on this standup, so there’s nothing to answer today.' } }];
  }
  if (state.kind === 'skipped') {
    return [
      { textParagraph: { text: `🏖️ You skipped today${state.note ? `: <i>${html(state.note)}</i>` : ''}. You won’t be counted as missing. Changed your mind? Undo it before ${due}.` } },
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

const FORMAT_HINT = 'Formatting: *bold* _italic_ ~strike~ __underline__ `code`, and - for a list.';

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
  again: { error?: string; notice?: string; mood?: string; moodComment?: string } = {},
) {
  const widgets: any[] = [
    ...(again.error ? [errorLine(again.error)] : []),
    ...(again.notice ? [{ textParagraph: { text: `<b>${html(again.notice)}</b>` } }] : []),
    ...questions.map((question, i) => ({
      textInput: {
        name: `q${i}`,
        label: `${question} (required)`,
        type: 'MULTIPLE_LINE',
        value: prefill[i] || undefined,
        hintText: isBlockerQuestion(question) ? `Write "none" if you have no blockers. ${FORMAT_HINT}` : FORMAT_HINT,
      },
    })),
  ];

  if (moodEnabled) {
    widgets.push({
      selectionInput: {
        name: 'mood',
        label: 'How is your mood today? (required)',
        type: 'DROPDOWN',
        items: MOODS.map((m) => ({ text: MOOD_LABEL[m], value: m, selected: m === again.mood })),
      },
    });
    widgets.push({
      textInput: {
        name: 'moodComment',
        label: 'Want to say why? (optional)',
        type: 'SINGLE_LINE',
        value: again.moodComment || undefined,
        hintText: 'Only people allowed to read mood comments see this. It is never posted in the space.',
      },
    });
  }

  // Required answers are checked on submit, as Google's dialog guide does; Chat failed to open dialogs with requiredWidgets.
  widgets.push({
    buttonList: {
      buttons: [
        // Once typos have been pointed out, the next submit goes through as typed.
        { text: 'Submit', onClick: { action: clickAction(SUBMIT_DIALOG_FN, [{ key: 'runId', value: String(runId) }, ...(again.notice ? [{ key: 'spellingShown', value: '1' }] : [])], endpoint) } },
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

/**
 * Chat can't hold Submit until fields are filled (that is Developer Preview),
 * so a missing answer redraws the dialog with this line and the values kept.
 */
function errorLine(message: string) {
  return { textParagraph: { text: `<font color="#d93025"><b>⚠️ ${html(message)}</b></font>` } };
}

/** Asks for a one-line reason before a skip; the reason goes to the day's thread. */
export function skipDialog(runId: number, endpoint: string | null = null, again: { error?: string; reason?: string } = {}) {
  return {
    actionResponse: {
      type: 'DIALOG',
      dialogAction: {
        dialog: {
          body: {
            sections: [
              {
                widgets: [
                  ...(again.error ? [errorLine(again.error)] : []),
                  {
                    textInput: {
                      name: 'reason',
                      label: 'Why are you skipping today? (required)',
                      value: again.reason || undefined,
                      type: 'SINGLE_LINE',
                      hintText: `One line, up to ${LIMITS.skipNoteMax} characters. Your team sees it in today’s thread.`,
                    },
                  },
                  {
                    buttonList: {
                      buttons: [{ text: 'Skip today', onClick: { action: clickAction(SKIP_TODAY_FN, [{ key: 'runId', value: String(runId) }], endpoint) } }],
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
                  { textParagraph: { text: toCardHtml(blocker.text) } },
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
                    text: toCardHtml(blocker.text),
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
/** Mood is personal, so it never appears here. */
export function submissionMessage(submission: Submission) {
  const approved = submission.editApprovedBy ? `${submission.late ? 'edited' : 'Edited'} after the deadline · approved by ${submission.editApprovedBy}` : null;
  const flags = [
    submission.late ? 'Submitted late' : null,
    approved ?? (submission.editedAt ? 'edited' : null),
  ].filter(Boolean);

  return {
    cardsV2: [
      {
        cardId: `submission-${submission.id}`,
        card: {
          header: {
            title: `📝 ${submission.displayName}`,
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
                        ? `⚠️ ${toCardHtml(a.answer)}`
                        : toCardHtml(a.answer),
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
export function declineDialog(requestIds: string, endpoint: string | null = null, target = { fn: SUBMIT_DECLINE_FN, key: 'requestIds' }) {
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
                      buttons: [{ text: 'Decline request', onClick: { action: clickAction(target.fn, [{ key: target.key, value: requestIds }], endpoint) } }],
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

/** Asks why before someone's request to edit goes to their managers. */
export function editRequestDialog(standup: Standup, run: Run, endpoint: string | null = null, again: { error?: string; reason?: string } = {}) {
  return {
    actionResponse: {
      type: 'DIALOG',
      dialogAction: {
        dialog: {
          body: {
            sections: [
              {
                widgets: [
                  ...(again.error ? [errorLine(again.error)] : []),
                  { textParagraph: { text: `<b>Ask to edit · ${html(standup.name)} · ${dayLabel(run.date)}</b><br>Your managers decide. If they approve, you can edit until ${untilLabel(standup)}.` } },
                  {
                    textInput: {
                      name: 'reason',
                      label: 'Why? (optional)',
                      type: 'SINGLE_LINE',
                      value: again.reason || undefined,
                      hintText: `Sent to your managers with the request. Up to ${LIMITS.textMax} characters.`,
                    },
                  },
                  { buttonList: { buttons: [{ text: 'Send request', onClick: { action: clickAction(SUBMIT_EDIT_REQUEST_FN, [{ key: 'runId', value: String(run.id) }], endpoint) } }] } },
                ],
              },
            ],
          },
        },
      },
    },
  };
}

/** DM card for a manager: someone asks to edit their answers after the deadline; redrawn once decided or lapsed. */
export function editRequestCard(request: EditRequestView, endpoint: string | null = null) {
  const zone = request.standup.timezone;
  const time = (iso: string | null) => DateTime.fromISO(iso!).setZone(zone).toFormat('HH:mm');
  const name = request.person.displayName;
  const reason = request.reason ? `“${html(request.reason)}” ` : '';
  const params = [{ key: 'editRequestId', value: String(request.id) }];
  const outcome: Record<EditRequestView['status'], string> = {
    pending: `${reason}Approve and ${name} can edit their answers until ${request.until}. Decline and ${name} is told, with your note. Unanswered by then, it lapses.`,
    approved: `${reason}✅ Approved by ${request.decidedBy} at ${time(request.decidedAt)}. ${name} can edit until ${request.until}.`,
    declined: `${reason}❌ Declined by ${request.decidedBy} at ${time(request.decidedAt)}.${request.note ? ` “${html(request.note)}”` : ''}`,
    lapsed: `${reason}⌛ Lapsed: not decided by ${request.until}.`,
  };
  return {
    cardsV2: [
      {
        cardId: `edit-request-${request.id}`,
        card: {
          header: { title: `Edit request · ${request.standup.name}`, subtitle: `${name} · ${dayLabel(request.date)} · answered at ${time(request.answeredAt)}` },
          sections: [
            {
              widgets: [
                { textParagraph: { text: outcome[request.status] } },
                ...(request.status === 'pending'
                  ? [
                      {
                        buttonList: {
                          buttons: [
                            { text: 'Approve', onClick: { action: clickAction(APPROVE_EDIT_FN, params, endpoint) } },
                            { text: 'Decline', onClick: { action: clickAction(DECLINE_EDIT_FN, params, endpoint, 'OPEN_DIALOG') } },
                          ],
                        },
                      },
                    ]
                  : []),
              ],
            },
          ],
        },
      },
    ],
  };
}

/** DM card telling someone their edit was approved, with the way back into the form. */
export function editApprovedCard(request: EditRequestView, endpoint: string | null = null) {
  return {
    cardsV2: [
      {
        cardId: `edit-approved-${request.id}`,
        card: {
          header: { title: `📋 ${request.standup.name}`, subtitle: humanDate(request.date) },
          sections: [
            {
              widgets: [
                { textParagraph: { text: `✅ ${html(request.decidedBy!)} approved your request. Edit your answers before <b>${request.until}</b>.` } },
                { buttonList: { buttons: [{ text: 'Edit answers', onClick: { action: clickAction(OPEN_DIALOG_FN, [{ key: 'runId', value: String(request.runId) }], endpoint, 'OPEN_DIALOG') } }] } },
              ],
            },
          ],
        },
      },
    ],
  };
}

const pollParam = (poll: PollView) => [{ key: 'pollId', value: String(poll.id) }];

/** DM card for a poll: to answer, as a reminder, once answered, and once closed. */
export function pollCardMessage(poll: PollView, state: PollCardState, endpoint: string | null = null) {
  const time = (iso: string) => DateTime.fromISO(iso).setZone(poll.zone).toFormat('HH:mm');
  const respond = (text: string) => ({ buttonList: { buttons: [{ text, onClick: { action: clickAction(OPEN_POLL_FORM_FN, pollParam(poll), endpoint, 'OPEN_DIALOG') } }] } });
  const count = `${poll.questions.length} question${poll.questions.length === 1 ? '' : 's'} · closes <b>${poll.closesLabel}</b>`;
  const privacy = poll.anonymous ? 'Anonymous: nobody sees who answered what.' : `Named: ${html(poll.from)} sees who answered what.`;
  const widgets: any[] = [];
  if (state.kind === 'open') {
    if (poll.intro) widgets.push({ textParagraph: { text: html(poll.intro) } });
    widgets.push({ textParagraph: { text: `${count}<br>${privacy}` } }, respond('Respond'));
  } else if (state.kind === 'reminder') {
    widgets.push({ textParagraph: { text: `You haven’t answered yet. It closes at <b>${poll.closesTime}</b>.` } }, respond('Respond'));
  } else if (state.kind === 'answered') {
    widgets.push({ textParagraph: { text: `✅ Answered at <b>${time(state.at)}</b>. You can change your answers until <b>${poll.closesTime}</b>.` } }, respond('Change answers'));
  } else {
    widgets.push({ textParagraph: { text: `🔒 Closed at ${poll.closesTime}.${state.answeredAt ? ` You answered at ${time(state.answeredAt)}.` : ''}` } });
  }
  return {
    cardsV2: [
      {
        cardId: `question-poll-${poll.id}`,
        card: {
          header: { title: `${state.kind === 'reminder' ? '⏰' : '📋'} ${poll.title}`, subtitle: `From ${poll.from} · ${poll.standupName}` },
          sections: [{ widgets }],
        },
      },
    ],
  };
}

/** The card that starts the poll's thread in the standup's space. */
export function pollSummaryMessage(poll: PollView, counts: PollCounts, closed: boolean) {
  const text = closed
    ? `🔒 Closed: ${counts.answered} of ${counts.asked} answered. ${poll.results === 'everyone' ? 'Results are in the thread.' : 'Results are with the standup’s managers.'}`
    : `${counts.answered} of ${counts.asked} answered · closes ${poll.closesLabel}<br>${poll.results === 'everyone' ? 'Everyone sees the results after it closes.' : 'Results go to the standup’s managers.'}`;
  return {
    cardsV2: [
      {
        cardId: `question-poll-summary-${poll.id}`,
        card: {
          header: { title: `📋 ${poll.title} · poll`, subtitle: `Sent by ${poll.from} to the people on ${poll.standupName}` },
          sections: [{ widgets: [{ textParagraph: { text } }] }],
        },
      },
    ],
  };
}

/** The form behind Respond: one input per question, named q0..qN, filled in with earlier answers. */
export function pollFormDialog(poll: PollView, answers: PollAnswer[] | null, endpoint: string | null = null, error?: string) {
  const label = (i: number) => `${poll.questions[i]!.text}${poll.questions[i]!.required ? ' (required)' : ''}`;
  const picked = (i: number) => {
    const a = answers?.[i];
    return Array.isArray(a) ? a : [];
  };
  const widgets: any[] = [
    ...(error ? [errorLine(error)] : []),
    { textParagraph: { text: `<b>${html(poll.title)}</b>${poll.intro ? `<br>${html(poll.intro)}` : ''}<br>Closes ${poll.closesLabel}. ${poll.anonymous ? 'Anonymous: nobody sees who answered what.' : `Named: ${html(poll.from)} sees who answered what.`}` } },
    ...poll.questions.map((q, i) => {
      const name = `q${i}`;
      if (q.type === 'short' || q.type === 'long') {
        const a = answers?.[i];
        return {
          textInput: {
            name,
            label: label(i),
            type: q.type === 'long' ? 'MULTIPLE_LINE' : 'SINGLE_LINE',
            value: typeof a === 'string' && a ? a : undefined,
            hintText: `Up to ${(q.type === 'long' ? POLL_LIMITS.long : POLL_LIMITS.short).toLocaleString('en-GB')} characters.`,
          },
        };
      }
      const items = q.options.map((text, n) => ({ text, value: String(n), selected: picked(i).includes(n) }));
      const type = q.type === 'dropdown' ? 'DROPDOWN' : q.type === 'single' ? 'RADIO_BUTTON' : 'CHECK_BOX';
      // A dropdown always shows a choice, so an unanswered one starts on a blank entry.
      return { selectionInput: { name, label: label(i), type, items: q.type === 'dropdown' ? [{ text: 'Choose one', value: '', selected: picked(i).length === 0 }, ...items] : items } };
    }),
    { buttonList: { buttons: [{ text: 'Submit', onClick: { action: clickAction(SUBMIT_POLL_FORM_FN, pollParam(poll), endpoint) } }] } },
  ];
  return { actionResponse: { type: 'DIALOG', dialogAction: { dialog: { body: { sections: [{ widgets }] } } } } };
}

import { DateTime } from 'luxon';
import type { ChatAdapter } from './adapter.js';
import type { OooChecker } from './ooo.js';
import type { Repo } from '../db/repo.js';
import type { StandupService } from './standup-service.js';
import type { AiSummarizer } from '../ai/summarizer.js';
import { buildWeeklyDigest, digestText, lastConfiguredWeekday } from './insights.js';
import { standupDays, type Run, type Standup, type Weekday } from './types.js';

const WEEKDAY_BY_LUXON: Record<number, Weekday> = {
  1: 'mon',
  2: 'tue',
  3: 'wed',
  4: 'thu',
  5: 'fri',
  6: 'sat',
  7: 'sun',
};

function timeOn(date: string, time: string, zone: string): DateTime {
  return DateTime.fromISO(`${date}T${time}`, { zone });
}

/**
 * Drives the standup lifecycle off a periodic tick (call every ~minute).
 * All state lives in the DB (prompted_at / reminded_at / run status), so
 * ticks are idempotent and the process can restart at any point.
 */
export class Scheduler {
  constructor(
    private repo: Repo,
    private adapter: ChatAdapter,
    private service: StandupService,
    private now: () => DateTime = () => DateTime.utc(),
    private log: (msg: string) => void = (msg) => console.log(`[scheduler] ${msg}`),
    private ai: AiSummarizer | null = null,
    private ooo: OooChecker | null = null,
  ) {}

  start(intervalMs = 60_000): NodeJS.Timeout {
    const timer = setInterval(() => {
      this.tick().catch((err) => this.log(`tick failed: ${err}`));
    }, intervalMs);
    timer.unref();
    return timer;
  }

  async tick(): Promise<void> {
    const now = this.now();
    for (const standup of await this.repo.listActiveStandups()) {
      try {
        await this.tickStandup(standup, now);
      } catch (err) {
        this.log(`standup ${standup.id} (${standup.name}): ${err}`);
      }
    }
  }

  private async tickStandup(standup: Standup, now: DateTime): Promise<void> {
    const zone = standup.timezone;
    const localNow = now.setZone(zone);
    const today = localNow.toISODate()!;

    // Runs left open from previous days (e.g. downtime past the deadline):
    // close them so the report still goes out.
    for (const stale of await this.repo.listOpenRuns(standup.id)) {
      if (stale.date < today) await this.closeRun(standup, stale);
    }

    if (!standupDays(standup).includes(WEEKDAY_BY_LUXON[localNow.weekday]!)) return;

    const promptAt = timeOn(today, standup.promptTime, zone);
    const deadlineAt = timeOn(today, standup.deadlineTime, zone);
    const remindAt = deadlineAt.minus({ minutes: standup.reminderMinutesBefore });

    let run = await this.repo.getRun(standup.id, today);
    if (!run && now >= promptAt) {
      const roster = await this.repo.listParticipants(standup.id);
      if (roster.filter((p) => !p.onVacation).length === 0) return;
      run = await this.repo.createRun(standup.id, today, `standup-${standup.id}-${today}`);
      this.log(`opened run ${run.id} for "${standup.name}" ${today}`);
      await this.applyCalendarOoo(standup, run);
      try {
        await this.adapter.postThreadParent(standup, run);
      } catch (err) {
        // Replies fall back to creating the thread, so the run can proceed.
        this.log(`postThreadParent failed for run ${run.id}: ${err}`);
      }
    }
    if (!run || run.status !== 'open') return;

    const submitted = new Set((await this.repo.listSubmissions(run.id)).map((s) => s.userName));
    const participants = await this.repo.listRunParticipants(run.id);
    const skipPrompt = (p: (typeof participants)[number]) =>
      p.onVacation || p.skippedAt !== null || submitted.has(p.userName);

    for (const rp of participants) {
      if (rp.promptedAt || skipPrompt(rp)) continue;
      // Prompts go out at promptTime in the participant's own timezone.
      const pPromptAt = timeOn(today, standup.promptTime, rp.timezone ?? zone);
      if (now < pPromptAt) continue;
      try {
        await this.adapter.sendStandupPrompt(rp.userName, standup, run);
        await this.repo.markPrompted(run.id, rp.userName, now.toISO()!);
      } catch (err) {
        this.log(`prompt to ${rp.userName} failed: ${err}`);
      }
    }

    if (now >= remindAt && now < deadlineAt) {
      for (const rp of participants) {
        if (rp.remindedAt || !rp.promptedAt || skipPrompt(rp)) continue;
        try {
          await this.adapter.sendReminder(rp.userName, standup, run);
          await this.repo.markReminded(run.id, rp.userName, now.toISO()!);
        } catch (err) {
          this.log(`reminder to ${rp.userName} failed: ${err}`);
        }
      }
    }

    if (now >= deadlineAt) await this.closeRun(standup, run);
  }

  /** Marks participants with a calendar OOO event today as away for this run only. */
  private async applyCalendarOoo(standup: Standup, run: Run): Promise<void> {
    if (!this.ooo) return;
    for (const rp of await this.repo.listRunParticipants(run.id)) {
      if (rp.onVacation) continue;
      const email = await this.repo.getUserEmail(rp.userName);
      if (!email) continue;
      try {
        if (await this.ooo.isOoo(email, run.date, standup.timezone)) {
          await this.repo.markRunVacation(run.id, rp.userName);
          this.log(`calendar OOO: ${rp.displayName} is away for run ${run.id}`);
        }
      } catch (err) {
        this.log(`OOO check failed for ${email}: ${err}`);
      }
    }
  }

  private async closeRun(standup: Standup, run: Run): Promise<void> {
    await this.repo.closeRun(run.id);
    this.log(`closed run ${run.id} for "${standup.name}" ${run.date}`);
    try {
      await this.adapter.postSummary(standup, run, await this.service.buildSummary(run.id));
    } catch (err) {
      this.log(`postSummary failed for run ${run.id}: ${err}`);
    }

    if (standup.escalateUserName) {
      try {
        await this.escalateStaleBlockers(standup, run);
      } catch (err) {
        this.log(`blocker escalation failed for run ${run.id}: ${err}`);
      }
    }

    try {
      await this.nudgeUnackedBlockerTags(standup, run);
    } catch (err) {
      this.log(`blocker nudges failed for run ${run.id}: ${err}`);
    }

    if (standup.aiEnabled && this.ai) {
      try {
        const submissions = await this.repo.listSubmissions(run.id);
        if (submissions.length > 0) {
          const text = await this.ai.dailySummary(standup, run, submissions);
          await this.adapter.postText(standup.spaceName, `🤖 *AI summary*\n${text}`, run.threadKey);
        }
      } catch (err) {
        this.log(`AI summary failed for run ${run.id}: ${err}`);
      }
    }

    if (standup.digestEnabled) {
      const weekday = DateTime.fromISO(run.date).weekday;
      if (weekday === lastConfiguredWeekday(standup)) {
        try {
          const digest = await buildWeeklyDigest(this.repo, standup, run.date);
          let text = digestText(digest);
          if (standup.aiEnabled && this.ai) {
            const submissions = await this.repo.listSubmissionsBetween(standup.id, digest.weekStart, digest.weekEnd);
            if (submissions.length > 0) {
              text += `\n\n🤖 *AI week in review*\n${await this.ai.weeklySummary(standup, digest, submissions)}`;
            }
          }
          await this.adapter.postText(standup.spaceName, text, `digest-${standup.id}-${digest.weekStart}`);
          this.log(`posted weekly digest for "${standup.name}" (${digest.weekStart})`);
        } catch (err) {
          this.log(`weekly digest failed for "${standup.name}": ${err}`);
        }
      }
    }
  }

  /** One DM per day per unacknowledged tag on an open blocker — stops on ack. */
  private async nudgeUnackedBlockerTags(standup: Standup, run: Run): Promise<void> {
    const localDate = (iso: string) => DateTime.fromISO(iso).setZone(standup.timezone).toISODate();
    for (const { tag, blocker } of await this.repo.listUnackedTags(standup.id)) {
      // Tagged today → they already got the card; nudged today → done for today.
      if (localDate(tag.taggedAt) === run.date) continue;
      if (tag.lastNudgedAt && localDate(tag.lastNudgedAt) === run.date) continue;
      try {
        await this.adapter.sendBlockerCard(
          tag.userName,
          standup,
          blocker,
          `Reminder: ${tag.taggedBy} tagged you on this blocker — please acknowledge.`,
        );
        await this.repo.markTagNudged(blocker.id, tag.userName, this.now().toISO()!);
      } catch (err) {
        this.log(`blocker nudge to ${tag.userName} failed: ${err}`);
      }
    }
  }

  private async escalateStaleBlockers(standup: Standup, run: Run): Promise<void> {
    const today = DateTime.fromISO(run.date);
    const stale = (await this.repo.listOpenBlockers(standup.id)).filter((b) => {
      if (b.escalatedAt) return false;
      const age = Math.floor(today.diff(DateTime.fromISO(b.openedDate), 'days').days);
      return age >= standup.escalateAfterDays;
    });
    if (stale.length === 0) return;

    const lines = stale.map((b) => {
      const age = Math.floor(today.diff(DateTime.fromISO(b.openedDate), 'days').days);
      return `⚠️ ${b.displayName}: ${b.text} (open ${age}d)`;
    });
    await this.adapter.sendDm(
      standup.escalateUserName!,
      `🚨 *${standup.name}*: ${stale.length} blocker${stale.length === 1 ? '' : 's'} open for ${standup.escalateAfterDays}+ days:\n${lines.join('\n')}\nBlockers auto-resolve when the person submits a blocker-free standup.`,
    );
    const at = this.now().toISO()!;
    for (const b of stale) await this.repo.markBlockerEscalated(b.id, at);
    this.log(`escalated ${stale.length} blocker(s) for "${standup.name}" to ${standup.escalateDisplayName}`);
  }
}

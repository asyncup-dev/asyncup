import { DateTime } from 'luxon';
import type { ChatAdapter } from './adapter.js';
import type { Repo } from '../db/repo.js';
import type { StandupService } from './standup-service.js';
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
    for (const standup of this.repo.listActiveStandups()) {
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
    for (const stale of this.repo.listOpenRuns(standup.id)) {
      if (stale.date < today) await this.closeRun(standup, stale);
    }

    if (!standupDays(standup).includes(WEEKDAY_BY_LUXON[localNow.weekday]!)) return;

    const promptAt = timeOn(today, standup.promptTime, zone);
    const deadlineAt = timeOn(today, standup.deadlineTime, zone);
    const remindAt = deadlineAt.minus({ minutes: standup.reminderMinutesBefore });

    let run = this.repo.getRun(standup.id, today);
    if (!run && now >= promptAt) {
      if (this.repo.listParticipants(standup.id).length === 0) return;
      run = this.repo.createRun(standup.id, today, `standup-${standup.id}-${today}`);
      this.log(`opened run ${run.id} for "${standup.name}" ${today}`);
      try {
        await this.adapter.postThreadParent(standup, run);
      } catch (err) {
        // Replies fall back to creating the thread, so the run can proceed.
        this.log(`postThreadParent failed for run ${run.id}: ${err}`);
      }
    }
    if (!run || run.status !== 'open') return;

    const submitted = new Set(this.repo.listSubmissions(run.id).map((s) => s.userName));
    const participants = this.repo.listRunParticipants(run.id);

    for (const rp of participants) {
      if (rp.promptedAt || submitted.has(rp.userName)) continue;
      // Prompts go out at promptTime in the participant's own timezone.
      const pPromptAt = timeOn(today, standup.promptTime, rp.timezone ?? zone);
      if (now < pPromptAt) continue;
      try {
        await this.adapter.sendStandupPrompt(rp.userName, standup, run);
        this.repo.markPrompted(run.id, rp.userName, now.toISO()!);
      } catch (err) {
        this.log(`prompt to ${rp.userName} failed: ${err}`);
      }
    }

    if (now >= remindAt && now < deadlineAt) {
      for (const rp of participants) {
        if (rp.remindedAt || !rp.promptedAt || submitted.has(rp.userName)) continue;
        try {
          await this.adapter.sendReminder(rp.userName, standup, run);
          this.repo.markReminded(run.id, rp.userName, now.toISO()!);
        } catch (err) {
          this.log(`reminder to ${rp.userName} failed: ${err}`);
        }
      }
    }

    if (now >= deadlineAt) await this.closeRun(standup, run);
  }

  private async closeRun(standup: Standup, run: Run): Promise<void> {
    this.repo.closeRun(run.id);
    this.log(`closed run ${run.id} for "${standup.name}" ${run.date}`);
    try {
      await this.adapter.postSummary(standup, run, this.service.buildSummary(run.id));
    } catch (err) {
      this.log(`postSummary failed for run ${run.id}: ${err}`);
    }
  }
}

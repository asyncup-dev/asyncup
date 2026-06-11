import { DateTime } from 'luxon';
import type { Repo } from '../db/repo.js';
import { MOOD_SCORE, standupDays, WEEKDAYS, type Standup, type WeeklyDigest } from './types.js';

interface RangeStats {
  runCount: number;
  expected: number;
  submitted: number;
  moodSum: number;
  moodCount: number;
}

export function rangeStats(repo: Repo, standupId: number, fromDate: string, toDate: string): RangeStats {
  const stats: RangeStats = { runCount: 0, expected: 0, submitted: 0, moodSum: 0, moodCount: 0 };
  for (const run of repo.listRunsBetween(standupId, fromDate, toDate)) {
    stats.runCount++;
    const submissions = repo.listSubmissions(run.id);
    const submittedBy = new Set(submissions.map((s) => s.userName));
    for (const p of repo.listRunParticipants(run.id)) {
      if (!p.mandatory) continue;
      if (submittedBy.has(p.userName)) {
        stats.expected++;
        stats.submitted++;
      } else if (!p.skippedAt && !p.onVacation) {
        stats.expected++;
      }
    }
    for (const s of submissions) {
      if (s.mood) {
        stats.moodSum += MOOD_SCORE[s.mood];
        stats.moodCount++;
      }
    }
  }
  return stats;
}

function participationPct(stats: RangeStats): number {
  return stats.expected === 0 ? 100 : Math.round((stats.submitted / stats.expected) * 100);
}

function avgMood(stats: RangeStats): number | null {
  return stats.moodCount === 0 ? null : Math.round((stats.moodSum / stats.moodCount) * 10) / 10;
}

export function moodEmoji(score: number): string {
  if (score >= 4.5) return '😄';
  if (score >= 3.5) return '🙂';
  if (score >= 2.5) return '😐';
  if (score >= 1.5) return '😕';
  return '😫';
}

/** The last configured weekday of the standup's week (ISO: mon=1 … sun=7). */
export function lastConfiguredWeekday(standup: Standup): number {
  const configured = standupDays(standup).map((d) => WEEKDAYS.indexOf(d) + 1);
  return Math.max(...configured);
}

export function buildWeeklyDigest(repo: Repo, standup: Standup, runDate: string): WeeklyDigest {
  const date = DateTime.fromISO(runDate);
  const weekStart = date.startOf('week').toISODate()!;
  const weekEnd = date.endOf('week').toISODate()!;
  const prevStart = date.minus({ weeks: 1 }).startOf('week').toISODate()!;
  const prevEnd = date.minus({ weeks: 1 }).endOf('week').toISODate()!;

  const current = rangeStats(repo, standup.id, weekStart, weekEnd);
  const previous = rangeStats(repo, standup.id, prevStart, prevEnd);

  return {
    standupName: standup.name,
    weekStart,
    weekEnd,
    runCount: current.runCount,
    participationPct: participationPct(current),
    prevParticipationPct: previous.runCount > 0 ? participationPct(previous) : null,
    avgMood: avgMood(current),
    prevAvgMood: previous.runCount > 0 ? avgMood(previous) : null,
    blockersOpened: repo.countBlockersOpenedBetween(standup.id, weekStart, weekEnd),
    blockersResolved: repo.countBlockersResolvedBetween(standup.id, weekStart, weekEnd),
    openBlockers: repo.listOpenBlockers(standup.id).map((b) => ({
      displayName: b.displayName,
      text: b.text,
      ageDays: Math.max(0, Math.floor(DateTime.fromISO(runDate).diff(DateTime.fromISO(b.openedDate), 'days').days)),
    })),
  };
}

export function digestText(digest: WeeklyDigest): string {
  const lines = [`📈 *${digest.standupName}* — weekly digest (${digest.weekStart} → ${digest.weekEnd})`];

  let participation = `Participation: *${digest.participationPct}%*`;
  if (digest.prevParticipationPct !== null) {
    const delta = digest.participationPct - digest.prevParticipationPct;
    participation += delta === 0 ? ' (=)' : ` (${delta > 0 ? '+' : ''}${delta} vs last week)`;
  }
  lines.push(participation);

  if (digest.avgMood !== null) {
    let mood = `Mood: ${moodEmoji(digest.avgMood)} *${digest.avgMood}/5*`;
    if (digest.prevAvgMood !== null) {
      const delta = Math.round((digest.avgMood - digest.prevAvgMood) * 10) / 10;
      mood += delta === 0 ? ' (=)' : ` (${delta > 0 ? '+' : ''}${delta} vs last week)`;
    }
    lines.push(mood);
  }

  lines.push(`Blockers: ${digest.blockersOpened} opened · ${digest.blockersResolved} resolved`);
  if (digest.openBlockers.length > 0) {
    lines.push('*Still open:*');
    for (const b of digest.openBlockers.slice(0, 10)) {
      lines.push(`  ⚠️ ${b.displayName}: ${b.text} (${b.ageDays}d)`);
    }
  }
  return lines.join('\n');
}

export function trendsText(repo: Repo, standup: Standup, now: DateTime, weeks = 4): string {
  const lines = [`📈 *${standup.name}* — last ${weeks} weeks`];
  const local = now.setZone(standup.timezone);
  for (let i = weeks - 1; i >= 0; i--) {
    const start = local.minus({ weeks: i }).startOf('week');
    const end = local.minus({ weeks: i }).endOf('week');
    const stats = rangeStats(repo, standup.id, start.toISODate()!, end.toISODate()!);
    if (stats.runCount === 0) {
      lines.push(`${start.toFormat('dd LLL')}–${end.toFormat('dd LLL')} ▸ no runs`);
      continue;
    }
    const mood = avgMood(stats);
    lines.push(
      `${start.toFormat('dd LLL')}–${end.toFormat('dd LLL')} ▸ ` +
        `participation ${participationPct(stats)}%` +
        (mood !== null ? ` · mood ${moodEmoji(mood)} ${mood}/5` : ''),
    );
  }
  const open = repo.listOpenBlockers(standup.id).length;
  if (open > 0) lines.push(`⚠️ ${open} open blocker${open === 1 ? '' : 's'} — try \`blockers\``);
  return lines.join('\n');
}

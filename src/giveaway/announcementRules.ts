import type { AnnouncementSettings } from '../db/schema.js';

export type ResolvedAnnouncements = {
  enabled: boolean;
  started: boolean;
  closed: boolean;
  extended: boolean;
  milestones: { enabled: boolean; every: number };
  capacity: { enabled: boolean; percents: number[] };
  countdown: { enabled: boolean; hours: number[] };
};

export const DEFAULT_ANNOUNCEMENTS: ResolvedAnnouncements = {
  enabled: true,
  started: true,
  closed: true,
  extended: true,
  milestones: { enabled: true, every: 100 },
  capacity: { enabled: true, percents: [50, 75, 90, 95, 99] },
  // 14 days, 3 days, 24 hours, 5 hours
  countdown: { enabled: true, hours: [336, 72, 24, 5] },
};

/** Fills in defaults (and reads the old v1 shape) so the rest of the code sees one complete shape. */
export function resolveAnnouncements(raw: AnnouncementSettings | null | undefined): ResolvedAnnouncements {
  const r = raw ?? {};
  const d = DEFAULT_ANNOUNCEMENTS;
  return {
    enabled: r.enabled ?? d.enabled,
    started: r.started ?? d.started,
    closed: r.closed ?? d.closed,
    extended: r.extended ?? d.extended,
    milestones: r.milestones ?? (r.milestoneEvery ? { enabled: true, every: r.milestoneEvery } : d.milestones),
    capacity: r.capacity ?? d.capacity,
    countdown: r.countdown ?? (r.countdownHours ? { enabled: true, hours: r.countdownHours } : d.countdown),
  };
}

/**
 * Countdown points already reached, smallest first. If the bot was offline and several
 * passed, only the first (closest to the end) is worth posting; the rest are just marked.
 */
export function crossedCountdowns(hours: number[], msLeft: number): number[] {
  if (msLeft <= 0) return [];
  return [...new Set(hours)].filter(h => msLeft <= h * 3_600_000).sort((a, b) => a - b);
}

/** The highest milestone reached (e.g. 200 when every=100 and count=234), or null. */
export function reachedMilestone(every: number, count: number): number | null {
  if (every <= 0 || count < every) return null;
  return Math.floor(count / every) * every;
}

/** Capacity percentages reached, highest first. */
export function crossedCapacity(percents: number[], count: number, max: number | null): number[] {
  if (!max || max <= 0) return [];
  const pct = (count / max) * 100;
  return [...new Set(percents)].filter(p => pct >= p).sort((a, b) => b - a);
}

/** "14 days", "3 days", "24 hours", "5 hours", "30 minutes" */
export function formatDuration(hours: number): string {
  if (hours >= 48 && hours % 24 === 0) return `${hours / 24} days`;
  if (hours >= 1) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const minutes = Math.round(hours * 60);
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

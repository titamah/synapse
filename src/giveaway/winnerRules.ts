import crypto from 'crypto';
import type { WinnerStatus } from '../db/schema.js';

export const DEFAULT_WINNER_MESSAGE =
  '🎉 Congrats {name}! You won **{giveaway}**!\nPress **Accept** by {deadline} to claim your prize.';

/** Statuses that hold a winner slot. Declined and expired ones free it up for a redraw. */
export const ACTIVE_WINNER_STATUSES: WinnerStatus[] = ['pending', 'notified', 'unreachable', 'accepted'];

export function openSlots(winnerCount: number, statuses: WinnerStatus[]) {
  return Math.max(0, winnerCount - statuses.filter(s => ACTIVE_WINNER_STATUSES.includes(s)).length);
}

/**
 * Picks one item at random, weighted: an entrant with 3 entries is 3× as likely as one with 1.
 * Uses a cryptographically secure random number by default.
 */
export function weightedPick<T extends { weight: number }>(pool: T[], random: () => number = secureRandom): T | null {
  const eligible = pool.filter(p => p.weight > 0);
  const total = eligible.reduce((sum, p) => sum + p.weight, 0);
  if (!total) return null;
  let ticket = random() * total;
  for (const p of eligible) {
    ticket -= p.weight;
    if (ticket < 0) return p;
  }
  return eligible[eligible.length - 1]!;
}

function secureRandom() {
  // randomInt allows a range up to 2^48 - 1; 2^47 buckets is plenty of precision.
  return crypto.randomInt(0, 2 ** 47) / 2 ** 47;
}

/** Fills {name}, {giveaway} and {deadline} in the winner DM. Unknown placeholders are left as typed. */
export function renderWinnerMessage(template: string | null | undefined, vars: { name: string; giveaway: string; deadline: string }) {
  return (template?.trim() || DEFAULT_WINNER_MESSAGE).replace(/\{(name|giveaway|deadline)\}/g, (_, k: keyof typeof vars) => vars[k]);
}

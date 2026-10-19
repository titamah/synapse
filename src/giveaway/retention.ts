import type { Client } from 'discord.js';
import { and, eq, inArray, isNotNull, isNull, like, lt } from 'drizzle-orm';
import { db } from '../db/client.js';
import { activities, auditLog, entrants, giveaways, overrides, settings, webhookEvents, winners, type GiveawayStats } from '../db/schema.js';
import { describeRule } from './labels.js';
import { audit, computePeople, getRules, statusOf, type Giveaway } from './service.js';

const DAY = 24 * 60 * 60 * 1000;
/** Personal data is deleted this long after a giveaway ends. */
export const RETENTION_DAYS = 90;
/** Who won is kept this long after the end, then anonymized. */
const WINNER_DAYS = 365;
/** Stats are refreshed this often until personal data is deleted (late disqualifications, winner checks…). */
const STATS_REFRESH_MS = DAY;

/** When a giveaway really ended: closed early, or its end time. */
export const endedAt = (g: Giveaway) => (g.closedAt && g.closedAt < g.endsAt ? g.closedAt : g.endsAt);
export const deletesAt = (g: Giveaway) => new Date(endedAt(g).getTime() + RETENTION_DAYS * DAY);

/** The numbers worth keeping after personal data is gone. */
export async function takeStats(g: Giveaway): Promise<GiveawayStats> {
  const rules = await getRules(g.id);
  const people = await computePeople(g);
  const eligible = people.filter(p => p.result.eligible);
  const byPlatform: GiveawayStats['byPlatform'] = {};
  for (const p of people) {
    for (const platform of new Set(p.activities.filter(a => !a.removedAt).map(a => a.platform))) byPlatform[platform] = (byPlatform[platform] ?? 0) + 1;
  }
  return {
    takenAt: new Date().toISOString(),
    entrants: people.length,
    eligible: eligible.length,
    entries: eligible.reduce((s, p) => s + p.result.entries.total, 0),
    byRule: rules.map(r => {
      const met = people.filter(p => p.result.requirements.some(q => q.ruleId === r.id && q.met));
      const bonus = eligible.map(p => p.result.breakdown.find(b => b.ruleId === r.id)).filter(b => !!b);
      return {
        ruleId: r.id,
        description: describeRule(r),
        people: r.type === 'required' ? met.length : bonus.length,
        actions: r.type === 'required' ? met.length : bonus.reduce((s, b) => s + b.count, 0),
        entries: bonus.reduce((s, b) => s + b.entries, 0),
      };
    }),
    byPlatform,
  };
}

export async function saveStats(g: Giveaway) {
  const stats = await takeStats(g);
  await db.update(giveaways).set({ stats }).where(eq(giveaways.id, g.id));
  return stats;
}

/**
 * Deletes a giveaway's personal data: people (and their accounts and answers), activity,
 * overrides and per-person audit entries. Keeps the setup, the stats snapshot, the winners
 * (who won, for a year) and the admin change history.
 */
export async function deletePersonalData(g: Giveaway) {
  await saveStats(g);
  await db.transaction(async tx => {
    // Who won stays on the winner row (`person`), even though the entrant row goes.
    const won = await tx.select().from(winners).where(and(eq(winners.giveawayId, g.id), isNull(winners.person), isNotNull(winners.entrantId)));
    for (const w of won) {
      const e = await tx.query.entrants.findFirst({ where: eq(entrants.id, w.entrantId!) });
      if (e) await tx.update(winners).set({ person: { discordId: e.discordId, discordUsername: e.discordUsername, igUsername: e.igUsername } }).where(eq(winners.id, w.id));
    }
    await tx.delete(overrides).where(eq(overrides.giveawayId, g.id));
    await tx.delete(activities).where(eq(activities.giveawayId, g.id));
    await tx.delete(entrants).where(eq(entrants.giveawayId, g.id));
    // Entrants' own actions (entries, edits, conflicts); admin and system history stays.
    await tx.delete(auditLog).where(and(eq(auditLog.giveawayId, g.id), like(auditLog.action, 'entry.%')));
    await tx.delete(settings).where(inArray(settings.key, [`ig_sync:${g.id}`]));
    await tx.update(giveaways).set({ personalDataDeletedAt: new Date() }).where(eq(giveaways.id, g.id));
  });
  await audit(g.id, 'system', 'giveaway.personal_data_deleted', { retentionDays: RETENTION_DAYS });
}

/**
 * Hourly: keep stats snapshots fresh, warn 7 days before deletion, delete personal data 90 days
 * after the end, anonymize winners after a year, and drop raw webhook payloads older than 90 days.
 */
export async function runRetention(client: Client | undefined, now = new Date()) {
  const closed = (await db.query.giveaways.findMany({ where: isNull(giveaways.personalDataDeletedAt) })).filter(g => statusOf(g) === 'closed');
  for (const g of closed) {
    try {
      const due = deletesAt(g);
      if (now >= due) {
        await deletePersonalData(g);
        console.log(`Deleted personal data for "${g.name}" (${RETENTION_DAYS} days after it ended)`);
        continue;
      }
      if (!g.stats || now.getTime() - new Date(g.stats.takenAt).getTime() > STATS_REFRESH_MS) await saveStats(g);
      // The 7-day heads-up is a flag (retention_upcoming, src/flags).
    } catch (err) {
      console.error(`Retention for "${g.name}" failed:`, (err as Error).message);
    }
  }

  // Winners: who won is kept for a year after the giveaway ended, then anonymized.
  const old = await db.query.giveaways.findMany({ where: lt(giveaways.endsAt, new Date(now.getTime() - WINNER_DAYS * DAY)) });
  const expired = old.filter(g => now.getTime() - endedAt(g).getTime() > WINNER_DAYS * DAY && g.personalDataDeletedAt).map(g => g.id);
  if (expired.length) {
    await db
      .update(winners)
      .set({ person: null, dmChannelId: null, dmMessageId: null, anonymizedAt: now })
      .where(and(inArray(winners.giveawayId, expired), isNull(winners.anonymizedAt)));
  }

  await db.delete(webhookEvents).where(lt(webhookEvents.receivedAt, new Date(now.getTime() - RETENTION_DAYS * DAY)));
}

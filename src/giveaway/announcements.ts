import type { Client, EmbedBuilder, MessageCreateOptions } from 'discord.js';
import { and, eq, gt, isNull, or } from 'drizzle-orm';
import { db } from '../db/client.js';
import { announcementsSent, bonuses, giveaways } from '../db/schema.js';
import { adminChannel } from '../discord/channels.js';
import { crossedCapacity, crossedCountdowns, reachedMilestone, resolveAnnouncements } from './announcementRules.js';
import {
  capacityEmbed,
  closedEmbed,
  countdownEmbed,
  extendRow,
  extendedEmbed,
  milestoneEmbed,
  startedEmbed,
} from './embeds.js';
import { entrantCount, statusOf, type Giveaway } from './service.js';

/** Starts and closes older than this aren't announced (e.g. right after a long outage or first deploy). */
const STALE_MS = 2 * 60 * 60 * 1000;

/**
 * Posts an update to #community-updates exactly once. The key is claimed in the database first,
 * so restarts and overlapping runs never double-post; `alsoMark` marks skipped keys as handled
 * (e.g. the 3-day countdown when the 24-hour one is the one worth posting).
 */
export async function postOnce(client: Client, g: Giveaway, key: string, message: MessageCreateOptions, alsoMark: string[] = []) {
  const claimed = await db
    .insert(announcementsSent)
    .values({ giveawayId: g.id, kind: key.split(':')[0]!, key })
    .onConflictDoNothing()
    .returning();
  if (!claimed.length) return false;
  if (alsoMark.length) {
    await db
      .insert(announcementsSent)
      .values(alsoMark.map(k => ({ giveawayId: g.id, kind: k.split(':')[0]!, key: k })))
      .onConflictDoNothing();
  }

  try {
    const channel = await adminChannel(client);
    if (!channel) throw new Error('#community-updates not found');
    await channel.send(message);
    return true;
  } catch (err) {
    // Release the claim so the next run retries.
    await db.delete(announcementsSent).where(and(eq(announcementsSent.giveawayId, g.id), eq(announcementsSent.key, key)));
    console.error(`Update "${key}" for "${g.name}" failed:`, (err as Error).message);
    return false;
  }
}

const withExtend = (g: Giveaway, embed: EmbedBuilder): MessageCreateOptions => ({ embeds: [embed], components: [extendRow(g)] });

async function entryCount(giveawayId: number, entrants: number) {
  const bonusRows = await db
    .select({ id: bonuses.id })
    .from(bonuses)
    .where(and(eq(bonuses.giveawayId, giveawayId), isNull(bonuses.revokedAt)));
  return entrants + bonusRows.length;
}

/** Checks one giveaway and posts whatever updates are due. */
async function announceFor(client: Client, g: Giveaway, now: Date) {
  const s = resolveAnnouncements(g.announcements);
  if (g.testMode || !s.enabled) return;
  const status = statusOf(g, now);
  const end = g.endsAt.toISOString();

  if (status === 'open') {
    if (s.started && g.startsAt && now.getTime() - g.startsAt.getTime() < STALE_MS) {
      await postOnce(client, g, 'started', { embeds: [startedEmbed(g)] });
    }

    const entrants = await entrantCount(g.id);

    if (s.countdown.enabled) {
      // Keys include the end time, so extending re-arms the countdown.
      const crossed = crossedCountdowns(s.countdown.hours, g.endsAt.getTime() - now.getTime());
      if (crossed.length) {
        const [closest, ...rest] = crossed;
        await postOnce(client, g, `countdown:${closest}:${end}`, withExtend(g, countdownEmbed(g, closest)), rest.map(h => `countdown:${h}:${end}`));
      }
    }

    if (s.milestones.enabled) {
      const reached = reachedMilestone(s.milestones.every, entrants);
      if (reached) await postOnce(client, g, `milestone:${reached}`, { embeds: [milestoneEmbed(g, reached)] });
    }

    if (s.capacity.enabled && g.maxParticipants) {
      // Keys include the cap, so raising it re-arms the alerts.
      const [highest, ...rest] = crossedCapacity(s.capacity.percents, entrants, g.maxParticipants);
      if (highest !== undefined) {
        const message = highest >= 99 ? withExtend(g, capacityEmbed(g, highest, entrants)) : { embeds: [capacityEmbed(g, highest, entrants)] };
        await postOnce(client, g, `capacity:${highest}:${g.maxParticipants}`, message, rest.map(p => `capacity:${p}:${g.maxParticipants}`));
      }
    }
  }

  if (status === 'closed' && s.closed) {
    const closedAt = g.closedAt ?? g.endsAt;
    if (now.getTime() - closedAt.getTime() < STALE_MS) {
      const entrants = await entrantCount(g.id);
      await postOnce(client, g, `closed:${closedAt.toISOString()}`, { embeds: [closedEmbed(g, { entrants, entries: await entryCount(g.id, entrants) })] });
    }
  }
}

/** Every minute: the open giveaway, plus any that started or closed recently. */
export async function runAnnouncements(client: Client) {
  if (!client.isReady()) return;
  const now = new Date();
  const recent = new Date(now.getTime() - STALE_MS);
  const candidates = await db.query.giveaways.findMany({
    where: and(eq(giveaways.testMode, false), or(gt(giveaways.endsAt, recent), gt(giveaways.closedAt, recent))),
  });
  for (const g of candidates) {
    try {
      await announceFor(client, g, now);
    } catch (err) {
      console.error(`Updates for "${g.name}" failed:`, (err as Error).message);
    }
  }
}

/** Posted right away when an admin extends the end time or the cap (dashboard or [Extend] button). */
export async function announceExtended(client: Client | undefined, g: Giveaway, change: { endsAt?: Date; maxParticipants?: number }) {
  if (!client?.isReady() || g.testMode) return;
  const s = resolveAnnouncements(g.announcements);
  if (!s.enabled || !s.extended) return;
  const key = `extended:${(change.endsAt ?? g.endsAt).toISOString()}:${change.maxParticipants ?? g.maxParticipants ?? ''}`;
  await postOnce(client, g, key, { embeds: [extendedEmbed(g, change)] });
}

/** /admin giveaway timer: a live countdown posted to #community-updates on demand. */
export async function postTimer(client: Client, g: Giveaway) {
  const channel = await adminChannel(client);
  if (!channel) throw new Error('#community-updates not found');
  return channel.send(withExtend(g, countdownEmbed(g)));
}


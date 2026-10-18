import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type Client,
  type MessageCreateOptions,
} from 'discord.js';
import { and, asc, eq, gt, inArray, isNotNull, lte, or } from 'drizzle-orm';
import { db } from '../db/client.js';
import { giveaways, winners, type WinnerStatus } from '../db/schema.js';
import { adminChannel } from '../discord/channels.js';
import { postOnce } from './announcements.js';
import { audit, computePeople, getGiveaway, getRules, setEntrantRevoked, statusOf, type Entrant, type Giveaway, type PersonReport } from './service.js';
import { ruleLabel } from './labels.js';
import { openSlots, renderWinnerMessage, weightedPick } from './winnerRules.js';

export type Winner = typeof winners.$inferSelect;

export const WINNER_BUTTON = /^winner:(notify|mark-accepted|mark-declined|accept|decline|decline-confirm|check-yes|check-no):(\d+)(?::(\d+))?$/;

const GOLD = 0xffcc00;
const GREEN = 0x2ecc71;
const RED = 0xe74c3c;
const ts = (d: Date, style: 'F' | 'R' = 'F') => `<t:${Math.floor(d.getTime() / 1000)}:${style}>`;

// ---------------------------------------------------------------------------
// Data

export async function listWinners(giveawayId: number) {
  return db.select().from(winners).where(eq(winners.giveawayId, giveawayId)).orderBy(asc(winners.id));
}

export async function getWinner(id: number) {
  return db.query.winners.findFirst({ where: eq(winners.id, id) });
}

async function entrantFor(w: Winner): Promise<Entrant> {
  return (await db.query.entrants.findFirst({ where: (e, { eq: eq_ }) => eq_(e.id, w.entrantId!) }))!;
}

/** Who can still win: eligible (every requirement met, per the rules), never picked before. Weighted by entries. */
export async function eligiblePool(g: Giveaway, client?: Client) {
  const already = new Set((await listWinners(g.id)).map(w => w.entrantId));
  return (await computePeople(g, client))
    .filter(p => p.result.eligible && p.result.entries.total > 0 && !already.has(p.id))
    .map(p => ({ person: p, weight: p.result.entries.total }));
}

// ---------------------------------------------------------------------------
// #community-updates messages

function winnerEmbed(g: Giveaway, title: string, lines: string[], color = GOLD) {
  return new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription(lines.join('\n'))
    .setFooter({ text: `Giveaway #${g.id} · ${g.name ?? 'Giveaway'}` })
    .setTimestamp(new Date());
}

const who = (e: Entrant) =>
  e.discordId ? `<@${e.discordId}>${e.igUsername ? ` (IG @${e.igUsername})` : ''}` : `IG @${e.igUsername} (Instagram only)`;

function button(id: string, label: string, style: ButtonStyle) {
  return new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
}

const reportRow = (w: Winner) =>
  new ActionRowBuilder<ButtonBuilder>().addComponents(
    button(`winner:mark-accepted:${w.id}`, 'Accepted', ButtonStyle.Success),
    button(`winner:mark-declined:${w.id}`, 'Declined', ButtonStyle.Danger),
  );

async function postAdmin(client: Client, message: MessageCreateOptions) {
  const channel = await adminChannel(client);
  if (!channel) throw new Error('#community-updates not found');
  await channel.send(message);
}

// ---------------------------------------------------------------------------
// Flow

/** The "what happens next" post for a winner who's ready to be contacted. */
async function postReadyToNotify(client: Client, g: Giveaway, w: Winner, entrant: Entrant, intro: string[]) {
  if (w.notifyAt) {
    await postAdmin(client, {
      embeds: [winnerEmbed(g, `🏆 Winner selected for ${g.name}`, [...intro, `They'll be notified by DM ${ts(w.notifyAt, 'R')}.`])],
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(button(`winner:notify:${w.id}`, 'Notify now', ButtonStyle.Primary))],
    });
  } else {
    await postAdmin(client, { embeds: [winnerEmbed(g, `🏆 Winner selected for ${g.name}`, [...intro, 'Reach out to them, then report what they said:'])], components: [reportRow(w)] });
  }
}

const notifyTime = (g: Giveaway) => (g.winnerNotify === 'auto' ? new Date(Date.now() + g.notifyDelayMinutes * 60_000) : null);

/**
 * Records a winner (drawn or picked by an admin). If the giveaway has manual winner checks
 * (e.g. "follows @BostonBlerds"), the winner waits in "checking" until admins confirm them all;
 * otherwise they go straight to being notified (after the delay) or reported (manual notify).
 */
export async function selectWinner(client: Client | undefined, g: Giveaway, person: PersonReport, selectedBy: string) {
  const entries = person.result.entries.total;
  const rules = await getRules(g.id);
  const checks = person.result.winnerChecks.map(ruleId => ({ ruleId, label: ruleLabel(rules.find(r => r.id === ruleId)!), confirmed: null }));
  const [w] = await db
    .insert(winners)
    .values({ giveawayId: g.id, entrantId: person.id, person: { discordId: person.discordId, discordUsername: person.discordUsername, igUsername: person.igUsername }, selectedBy, entriesAtDraw: entries, checks, status: checks.length ? 'checking' : 'pending', notifyAt: checks.length ? null : notifyTime(g) })
    .onConflictDoNothing()
    .returning();
  if (!w) return null;
  await audit(g.id, selectedBy, 'winner.selected', { winnerId: w.id, entrantId: person.id, discordUsername: person.discordUsername, entries, checks: checks.length });

  if (client?.isReady()) {
    const how = selectedBy === 'auto' ? 'Drawn at random' : `Picked by ${selectedBy.replace(/^admin:/, '')}`;
    const intro = [`${who(person)} · ${entries} entr${entries === 1 ? 'y' : 'ies'} · ${how}.`];
    if (checks.length) {
      await postAdmin(client, {
        embeds: [winnerEmbed(g, `🔎 Check the winner for ${g.name}`, [...intro, 'Confirm before they are contacted:', ...checks.map(c => `• ${c.label}`)])],
        components: checks.slice(0, 5).map(c =>
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            button(`winner:check-yes:${w.id}:${c.ruleId}`, `✓ ${c.label}`.slice(0, 80), ButtonStyle.Success),
            button(`winner:check-no:${w.id}:${c.ruleId}`, '✗ Not met', ButtonStyle.Danger),
          ),
        ),
      });
    } else {
      await postReadyToNotify(client, g, w, person, intro);
    }
  }
  return w;
}

/**
 * An admin confirms (or rejects) one winner check. All confirmed → the winner moves on to being
 * notified. Any rejected → disqualified and the slot is refilled.
 */
export async function confirmWinnerCheck(client: Client | undefined, winnerId: number, ruleId: number, confirmed: boolean, by: string) {
  const w = await getWinner(winnerId);
  if (!w || w.status !== 'checking') return { ok: false as const, error: 'This winner is not waiting on checks.' };
  const check = w.checks.find(c => c.ruleId === ruleId);
  if (!check) return { ok: false as const, error: 'No such check for this winner.' };

  const checks = w.checks.map(c => (c.ruleId === ruleId ? { ...c, confirmed, by, at: new Date().toISOString() } : c));
  const g = (await getGiveaway(w.giveawayId))!;
  await audit(g.id, by, 'winner.check', { winnerId, ruleId, label: check.label, confirmed });

  if (!confirmed) {
    await db.update(winners).set({ checks }).where(eq(winners.id, w.id));
    return resolveWinner(client, winnerId, 'declined', by, `Didn't meet: ${check.label}`);
  }
  const allDone = checks.every(c => c.confirmed === true);
  const [updated] = await db
    .update(winners)
    .set({ checks, ...(allDone ? { status: 'pending' as const, notifyAt: notifyTime(g) } : {}) })
    .where(eq(winners.id, w.id))
    .returning();
  if (allDone && client?.isReady()) await postReadyToNotify(client, g, updated!, await entrantFor(updated!), [`${who(await entrantFor(updated!))}: all checks confirmed.`]);
  return { ok: true as const, winner: updated! };
}

/** Draws one winner at random, weighted by entries. Returns null if nobody is left to draw. */
export async function drawWinner(client: Client | undefined, g: Giveaway, selectedBy = 'auto') {
  const pick = weightedPick(await eligiblePool(g, client));
  if (!pick) return null;
  return selectWinner(client, g, pick.person, selectedBy);
}

/** Sends the winner their DM with Accept/Decline. If their DMs are closed, admins take over. */
export async function notifyWinner(client: Client, winnerId: number, by = 'auto') {
  const w = await getWinner(winnerId);
  if (!w || w.status !== 'pending') return { ok: false as const, error: 'This winner was already notified or resolved.' };
  const g = (await getGiveaway(w.giveawayId))!;
  const entrant = await entrantFor(w);
  const deadline = new Date(Date.now() + g.claimHours * 3_600_000);

  // Instagram-only winners have no Discord account to DM.
  if (!entrant.discordId) {
    await db.update(winners).set({ status: 'unreachable', notifiedAt: new Date() }).where(eq(winners.id, w.id));
    await audit(g.id, by, 'winner.unreachable', { winnerId: w.id, reason: 'instagram-only' });
    await postAdmin(client, {
      embeds: [winnerEmbed(g, `📸 Instagram-only winner`, [`${who(entrant)} entered through Instagram, so the bot can't DM them.`, 'Reach out on Instagram, then report what they said:'])],
      components: [reportRow({ ...w, status: 'unreachable' })],
    });
    return { ok: false as const, error: 'Instagram-only winner: admins were asked to reach out on Instagram.' };
  }

  try {
    const user = await client.users.fetch(entrant.discordId);
    const text = renderWinnerMessage(g.winnerMessage, { name: user.displayName, giveaway: g.name ?? 'the giveaway', deadline: ts(deadline) });
    const dm = await user.send({
      embeds: [new EmbedBuilder().setColor(GOLD).setTitle(`🏆 ${g.name}`).setDescription(text).setFooter({ text: 'Boston Blerds' })],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          button(`winner:accept:${w.id}`, 'Accept', ButtonStyle.Success),
          button(`winner:decline:${w.id}`, 'Decline', ButtonStyle.Secondary),
        ),
      ],
    });
    await db
      .update(winners)
      .set({ status: 'notified', notifiedAt: new Date(), claimDeadline: deadline, dmChannelId: dm.channelId, dmMessageId: dm.id })
      .where(eq(winners.id, w.id));
    await audit(g.id, by, 'winner.notified', { winnerId: w.id, deadline });
    await postAdmin(client, { embeds: [winnerEmbed(g, `📨 Winner notified`, [`${who(entrant)} has until ${ts(deadline)} (${ts(deadline, 'R')}) to accept.`])] });
    return { ok: true as const };
  } catch (err) {
    await db.update(winners).set({ status: 'unreachable', notifiedAt: new Date() }).where(eq(winners.id, w.id));
    await audit(g.id, by, 'winner.unreachable', { winnerId: w.id, error: (err as Error).message });
    await postAdmin(client, {
      embeds: [winnerEmbed(g, `⚠️ Couldn't DM the winner`, [`${who(entrant)} has DMs closed (or left the server).`, 'Reach out manually, then report what they said:'], RED)],
      components: [reportRow({ ...w, status: 'unreachable' })],
    });
    return { ok: false as const, error: "Couldn't DM them; admins were asked to reach out manually." };
  }
}

const ALLOWED: Record<'accepted' | 'declined' | 'expired', WinnerStatus[]> = {
  accepted: ['pending', 'notified', 'unreachable'],
  declined: ['checking', 'pending', 'notified', 'unreachable'],
  expired: ['notified'],
};

/**
 * Accepted, declined or ran out of time. Declined/expired winners keep their place in the
 * history but are disqualified, and the slot is refilled (auto draw or a prompt to admins).
 */
export async function resolveWinner(client: Client | undefined, winnerId: number, outcome: 'accepted' | 'declined' | 'expired', by: string, reason?: string) {
  const w = await getWinner(winnerId);
  if (!w || !ALLOWED[outcome].includes(w.status)) return { ok: false as const, error: 'This winner was already resolved.' };
  const [updated] = await db
    .update(winners)
    .set({ status: outcome, respondedAt: new Date(), outcomeBy: by })
    .where(and(eq(winners.id, w.id), inArray(winners.status, ALLOWED[outcome])))
    .returning();
  if (!updated) return { ok: false as const, error: 'This winner was already resolved.' };

  const g = (await getGiveaway(w.giveawayId))!;
  const entrant = await entrantFor(w);
  await audit(g.id, by, `winner.${outcome}`, { winnerId: w.id, entrantId: entrant.id });
  if (outcome !== 'accepted') {
    await setEntrantRevoked(g.id, entrant.id, by, reason ?? (outcome === 'declined' ? 'Declined the prize' : "Didn't claim the prize in time"));
  }

  if (client?.isReady()) {
    // Take the buttons off their DM so it can't be pressed again.
    if (w.dmChannelId && w.dmMessageId) {
      try {
        const channel = await client.channels.fetch(w.dmChannelId);
        if (channel?.isTextBased()) await (await channel.messages.fetch(w.dmMessageId)).edit({ components: [] });
      } catch {
        /* DM gone or closed; nothing to clean up */
      }
    }
    const titles = { accepted: '✅ Winner accepted!', declined: '❌ Winner declined', expired: '⌛ Winner didn\'t claim in time' };
    const lines =
      outcome === 'accepted'
        ? [`${who(entrant)} accepted their prize for **${g.name}**. 🎉`]
        : [`${who(entrant)} ${reason ?? (outcome === 'declined' ? 'declined' : "didn't accept in time")}. Their entries are disqualified.`];
    await postAdmin(client, { embeds: [winnerEmbed(g, titles[outcome], lines, outcome === 'accepted' ? GREEN : RED)] });
    if (outcome !== 'accepted') await fillOpenSlots(client, g);
  }
  return { ok: true as const, winner: updated };
}

/** Draws (auto) or asks admins to pick (manual) for any open winner slots on a closed giveaway. */
export async function fillOpenSlots(client: Client, g: Giveaway) {
  if (statusOf(g) !== 'closed') return;
  const all = await listWinners(g.id);
  const slots = openSlots(g.winnerCount, all.map(w => w.status));
  if (!slots) return;
  const round = all.length; // changes every time someone is picked, so each need is announced once

  if (g.winnerSelect === 'auto') {
    for (let i = 0; i < slots; i++) {
      const w = await drawWinner(client, g);
      if (!w) {
        await postOnce(client, g, `winner-pool-empty:${round}`, {
          embeds: [winnerEmbed(g, `⚠️ No one left to draw for ${g.name}`, ['Every eligible entrant has already been picked or disqualified.'], RED)],
        });
        return;
      }
    }
  } else {
    await postOnce(client, g, `winner-pick:${round}`, {
      embeds: [winnerEmbed(g, `🏆 Time to pick a winner for ${g.name}`, [`${slots} winner${slots === 1 ? '' : 's'} needed. Pick from the dashboard (or draw at random there).`])],
    });
  }
}

let running = false;

/**
 * Every minute, for giveaways that closed in the last 30 days: expire winners whose claim window
 * passed, send DMs that are due, and fill open winner slots. Only giveaways that already have
 * winners, or closed in the last 2 hours, are touched (so old giveaways stay quiet).
 */
export async function runWinnerJobs(client: Client) {
  if (running || !client.isReady()) return;
  running = true;
  try {
    const now = new Date();
    const monthAgo = new Date(now.getTime() - 30 * 24 * 3_600_000);
    const twoHoursAgo = new Date(now.getTime() - 2 * 3_600_000);

    // 1. Claim windows that passed.
    const overdue = await db.select().from(winners).where(and(eq(winners.status, 'notified'), lte(winners.claimDeadline, now)));
    for (const w of overdue) await resolveWinner(client, w.id, 'expired', 'system');

    // 2. DMs that are due.
    const due = await db.select().from(winners).where(and(eq(winners.status, 'pending'), isNotNull(winners.notifyAt), lte(winners.notifyAt, now)));
    for (const w of due) await notifyWinner(client, w.id);

    // 3. Open slots on recently closed giveaways.
    const recent = await db.query.giveaways.findMany({
      where: or(and(isNotNull(giveaways.closedAt), gt(giveaways.closedAt, monthAgo)), and(lte(giveaways.endsAt, now), gt(giveaways.endsAt, monthAgo))),
    });
    for (const g of recent) {
      if (statusOf(g, now) !== 'closed') continue;
      const closedAt = g.closedAt ?? g.endsAt;
      const hasWinners = (await listWinners(g.id)).length > 0;
      if (hasWinners || closedAt > twoHoursAgo) await fillOpenSlots(client, g);
    }
  } catch (err) {
    console.error('Winner jobs failed:', (err as Error).message);
  } finally {
    running = false;
  }
}

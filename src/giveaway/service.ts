import type { Client } from 'discord.js';
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lte, ne, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  activities,
  auditLog,
  entrants,
  giveawayRules,
  giveaways,
  overrides,
  settings,
  type FormField,
  type Platform,
  type RuleAction,
} from '../db/schema.js';
import { serverMemberIds } from '../discord/members.js';
import { evaluatePerson, type EngineOverride, type EngineResult, type EngineRule } from './engine.js';

export type Giveaway = typeof giveaways.$inferSelect;
export type Entrant = typeof entrants.$inferSelect;
export type Activity = typeof activities.$inferSelect;
export type Override = typeof overrides.$inferSelect;
export type GiveawayStatus = 'scheduled' | 'open' | 'closed';

/** Our own Instagram account: never earns entries, and tagging it doesn't count as tagging a friend. */
export const OWN_IG_HANDLE = 'bostonblerds';

// ---------------------------------------------------------------------------
// Helpers

/** Strips "@", instagram.com URLs and whitespace; returns null if it can't be a valid IG username. */
export function normalizeIg(raw: string): string | null {
  let value = raw.trim().toLowerCase();
  const urlMatch = value.match(/instagram\.com\/([^/?#\s]+)/);
  if (urlMatch) value = urlMatch[1]!;
  value = value.replace(/^@+/, '').replace(/\/+$/, '');
  if (!/^[a-z0-9._]{1,30}$/.test(value)) return null;
  if (value.endsWith('.') || value.includes('..')) return null;
  return value;
}

export function slugify(name: string) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

/** Status is derived from the dates and closed_at, never stored, so it can't drift. */
export function statusOf(g: Giveaway, now = new Date()): GiveawayStatus {
  if (g.closedAt || now >= g.endsAt) return 'closed';
  if (!g.startsAt || now < g.startsAt) return 'scheduled';
  return 'open';
}

export async function audit(giveawayId: number | null, actorId: string, action: string, details: Record<string, unknown> = {}) {
  await db.insert(auditLog).values({ giveawayId, actorId, action, details });
}

/** Is a form field the Instagram username field? (v2 "account" field, or the v1 name.) */
export const isInstagramField = (f: FormField) => f.type === 'ig_username' || (f.type === 'account' && !!f.platforms?.includes('instagram'));

export const hasRule = (rules: EngineRule[], platform: Platform, action?: RuleAction) =>
  rules.some(r => r.platform === platform && (!action || r.action === action));

/** Does this giveaway take entries through /giveaway enter (a Discord "enter" rule, required or bonus)? */
export const takesDiscordEntries = (rules: EngineRule[]) => hasRule(rules, 'discord', 'enter');

/** When the giveaway's first Instagram post went up (Story mentions count from then). */
/** The Instagram posts whose comments count: the posts on the giveaway's comment rules. */
export async function giveawayPosts(g: Giveaway): Promise<{ id: string; permalink: string; postedAt: Date }[]> {
  const seen = new Map<string, { id: string; permalink: string; postedAt: Date }>();
  for (const r of await getRules(g.id)) {
    const p = r.platform === 'instagram' && r.action === 'comment' ? r.options.post : undefined;
    if (p && !seen.has(p.id)) seen.set(p.id, { id: p.id, permalink: p.permalink, postedAt: new Date(p.postedAt) });
  }
  return [...seen.values()];
}

/** Does this giveaway read anything from Instagram (comments on its posts, or tagged posts)? */
export async function readsInstagram(g: Giveaway) {
  return (await getRules(g.id)).some(r => r.platform === 'instagram' && (r.action === 'tag' || (r.action === 'comment' && !!r.options.post)));
}

/** Channels (names) where /giveaway enter works: one per enter rule. */
export const enterChannels = (g: Giveaway) => g.platformSettings.discord?.channels ?? [];

// ---------------------------------------------------------------------------
// Giveaways

export async function getGiveaway(id: number) {
  return db.query.giveaways.findFirst({ where: eq(giveaways.id, id) });
}

export async function listGiveaways() {
  return db.select().from(giveaways).orderBy(desc(giveaways.startsAt));
}

export async function getRules(giveawayId: number): Promise<(EngineRule & { giveawayId: number })[]> {
  return db
    .select()
    .from(giveawayRules)
    .where(eq(giveawayRules.giveawayId, giveawayId))
    .orderBy(asc(giveawayRules.position), asc(giveawayRules.id));
}

/**
 * People counted against the cap and for milestones: those who entered on Discord when the
 * giveaway takes Discord entries, otherwise everyone with activity. Disqualified people don't count.
 */
export async function participantCount(giveawayId: number, rules?: EngineRule[]) {
  const r = rules ?? (await getRules(giveawayId));
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(entrants)
    .where(and(eq(entrants.giveawayId, giveawayId), isNull(entrants.revokedAt), takesDiscordEntries(r) ? isNotNull(entrants.discordId) : undefined));
  return row!.n;
}

/** The one giveaway open right now, if any. Closes it first if its participant cap was reached. */
export async function getOpenGiveaway(now = new Date()): Promise<Giveaway | null> {
  const g = await db.query.giveaways.findFirst({
    where: and(isNull(giveaways.closedAt), isNotNull(giveaways.startsAt), lte(giveaways.startsAt, now), gt(giveaways.endsAt, now)),
    orderBy: asc(giveaways.startsAt),
  });
  if (!g) return null;
  if (g.maxParticipants && (await participantCount(g.id)) >= g.maxParticipants) {
    await closeGiveaway(g.id, 'system', 'cap');
    return null;
  }
  return g;
}

export async function closeGiveaway(id: number, actorId: string, reason: 'cap' | 'early') {
  const rows = await db
    .update(giveaways)
    .set({ closedAt: new Date(), closeReason: reason, updatedAt: new Date() })
    .where(and(eq(giveaways.id, id), isNull(giveaways.closedAt)))
    .returning();
  if (rows.length) await audit(id, actorId, 'giveaway.closed', { reason });
  return rows[0];
}

export type ExtendResult =
  | { ok: true; giveaway: Giveaway; change: { endsAt?: Date; maxParticipants?: number } }
  | { ok: false; error: string };

/**
 * Adds time and/or spots. Extending a giveaway that already ended (by time or by filling up)
 * reopens it; one an admin closed early stays closed.
 */
export async function extendGiveaway(g: Giveaway, add: { hours?: number; spots?: number }, actorId: string): Promise<ExtendResult> {
  if (!add.hours && !add.spots) return { ok: false, error: 'Add hours or spots.' };
  if (g.closeReason === 'early') return { ok: false, error: 'This giveaway was closed early by an admin. Change it from the dashboard.' };
  if (add.spots && !g.maxParticipants) return { ok: false, error: "This giveaway has no participant cap, so there's nothing to add spots to." };

  const change: { endsAt?: Date; maxParticipants?: number } = {};
  if (add.hours) change.endsAt = new Date(Math.max(g.endsAt.getTime(), Date.now()) + add.hours * 3_600_000);
  if (add.spots) change.maxParticipants = g.maxParticipants! + add.spots;

  if (change.endsAt && g.startsAt) {
    const overlap = await findOverlap(g.startsAt, change.endsAt, g.id);
    if (overlap) return { ok: false, error: `That would overlap with "${overlap.name}".` };
  }

  // Reopen if it closed because time ran out or it filled up, and the extension fixes that.
  const reopen = g.closeReason === 'cap' ? !!change.maxParticipants : !!change.endsAt && !g.closedAt;
  const [updated] = await db
    .update(giveaways)
    .set({ ...change, ...(reopen && g.closedAt ? { closedAt: null, closeReason: null } : {}), updatedAt: new Date() })
    .where(eq(giveaways.id, g.id))
    .returning();
  await audit(g.id, actorId, 'giveaway.extended', { ...add, ...change });
  return { ok: true, giveaway: updated!, change };
}

/** Another not-closed giveaway whose dates overlap [start, end). Only one may run at a time. */
export async function findOverlap(start: Date, end: Date, excludeId?: number) {
  return db.query.giveaways.findFirst({
    where: and(
      isNull(giveaways.closedAt),
      isNotNull(giveaways.startsAt),
      sql`${giveaways.startsAt} < ${end} AND ${giveaways.endsAt} > ${start}`,
      excludeId ? ne(giveaways.id, excludeId) : undefined,
    ),
  });
}

/**
 * Permanently deletes a giveaway and everything under it: people, activity, overrides, rules,
 * winners, sent announcements, audit history and sync status. Leaves one summary row in the
 * general audit log. Callers must check it isn't open.
 */
export async function deleteGiveaway(g: Giveaway, actorId: string) {
  const [count] = await db.select({ n: sql<number>`count(*)::int` }).from(entrants).where(eq(entrants.giveawayId, g.id));
  const entrantTotal = count!.n;

  await db.transaction(async tx => {
    // People take their overrides and winner rows with them; activity, rules and announcements go with the giveaway.
    await tx.delete(entrants).where(eq(entrants.giveawayId, g.id));
    await tx.delete(auditLog).where(eq(auditLog.giveawayId, g.id));
    await tx.delete(settings).where(inArray(settings.key, [`ig_sync:${g.id}`, `ig_final_sync:${g.id}`]));
    await tx.delete(giveaways).where(eq(giveaways.id, g.id));
    await tx.insert(auditLog).values({
      giveawayId: null,
      actorId,
      action: 'giveaway.deleted',
      details: { id: g.id, name: g.name, slug: g.slug, startsAt: g.startsAt, endsAt: g.endsAt, entrants: entrantTotal },
    });
  });
  return { entrants: entrantTotal };
}

// ---------------------------------------------------------------------------
// People and the Discord entry form

export async function getEntrantByDiscord(giveawayId: number, discordId: string) {
  return db.query.entrants.findFirst({ where: and(eq(entrants.giveawayId, giveawayId), eq(entrants.discordId, discordId)) });
}

export async function getEntrantByIg(giveawayId: number, igUsername: string) {
  return db.query.entrants.findFirst({ where: and(eq(entrants.giveawayId, giveawayId), eq(entrants.igUsername, igUsername)) });
}

export type EntryResult =
  | { status: 'closed' | 'full' }
  | { status: 'invalid'; field: FormField }
  | { status: 'revoked'; entrant: Entrant }
  | { status: 'conflict'; igUsername: string; claimedBy: string | null }
  | { status: 'created' | 'updated' | 'unchanged'; entrant: Entrant };

/**
 * Saves or updates someone's entry from the Discord form and records the Discord "enter"
 * activity. Enforces: one entry per Discord account, one Discord account per IG username,
 * required fields, and the participant cap. Someone already active on Instagram with the same
 * username gets linked rather than duplicated.
 */
export async function submitEntry(input: {
  giveaway: Giveaway;
  discordId: string;
  discordUsername: string;
  /** The channel (name) they entered in. */
  channel: string;
  values: Record<string, string>;
}): Promise<EntryResult> {
  const g = input.giveaway;
  const rules = await getRules(g.id);
  if (statusOf(g) !== 'open' || !takesDiscordEntries(rules)) return { status: 'closed' };

  let igUsername: string | null = null;
  const answers: Record<string, string> = {};
  for (const field of g.formFields) {
    const value = (input.values[field.id] ?? '').trim();
    if (!value) {
      if (field.required) return { status: 'invalid', field };
      continue;
    }
    if (isInstagramField(field)) {
      igUsername = normalizeIg(value);
      if (!igUsername) return { status: 'invalid', field };
    } else if (field.type === 'select' && field.options && !field.options.includes(value)) {
      return { status: 'invalid', field };
    } else {
      answers[field.id] = value.slice(0, 1000);
    }
  }

  let existing = await getEntrantByDiscord(g.id, input.discordId);
  if (existing?.revokedAt) return { status: 'revoked', entrant: existing };

  if (igUsername) {
    let owner = await getEntrantByIg(g.id, igUsername);
    // Someone already active on Instagram (no Discord yet) is now entering with that username: link them.
    if (owner && owner.discordId === null) {
      if (owner.revokedAt) return { status: 'revoked', entrant: owner };
      owner = await linkInstagramEntrant(g, owner, existing, input.discordId, input.discordUsername);
      existing = owner;
    }
    if (owner && owner.discordId !== input.discordId) {
      await audit(g.id, input.discordId, 'entry.ig_conflict', {
        igUsername,
        claimedByDiscordId: owner.discordId,
        attemptedByUsername: input.discordUsername,
      });
      return { status: 'conflict', igUsername, claimedBy: owner.discordId };
    }
  }

  // One "enter" per channel: entering again in the same channel just updates the answers.
  const sourceRef = `${input.discordId}:${input.channel}`;
  const entered = existing
    ? await db.query.activities.findMany({ where: and(eq(activities.giveawayId, g.id), eq(activities.platform, 'discord'), eq(activities.action, 'enter'), eq(activities.discordId, input.discordId)) })
    : [];
  const hasEntered = entered.length > 0;
  const enteredHere = entered.some(a => a.sourceRef === sourceRef);
  if (existing && enteredHere && existing.igUsername === igUsername && JSON.stringify(existing.answers) === JSON.stringify(answers)) {
    return { status: 'unchanged', entrant: existing };
  }

  if (!hasEntered && g.maxParticipants && (await participantCount(g.id, rules)) >= g.maxParticipants) {
    await closeGiveaway(g.id, 'system', 'cap');
    return { status: 'full' };
  }

  let entrant: Entrant;
  try {
    if (existing) {
      [entrant] = (await db
        .update(entrants)
        .set({ igUsername, answers, discordUsername: input.discordUsername, updatedAt: new Date() })
        .where(eq(entrants.id, existing.id))
        .returning()) as [Entrant];
      await audit(g.id, input.discordId, hasEntered ? 'entry.updated' : 'entry.created', {
        from: { igUsername: existing.igUsername, answers: existing.answers },
        to: { igUsername, answers },
      });
    } else {
      [entrant] = (await db
        .insert(entrants)
        .values({ giveawayId: g.id, discordId: input.discordId, discordUsername: input.discordUsername, igUsername, answers })
        .returning()) as [Entrant];
      await audit(g.id, input.discordId, 'entry.created', { igUsername, answers, discordUsername: input.discordUsername });
    }
  } catch (err) {
    // Lost a race with someone claiming the same IG username.
    if ((err as { code?: string }).code === '23505') return { status: 'conflict', igUsername: igUsername ?? '', claimedBy: (igUsername && (await getEntrantByIg(g.id, igUsername))?.discordId) || null };
    throw err;
  }

  await db
    .insert(activities)
    .values({ giveawayId: g.id, platform: 'discord', action: 'enter', discordId: input.discordId, sourceRef, at: new Date(), details: { channel: input.channel } })
    .onConflictDoNothing();

  // The entry that fills the last spot closes the giveaway.
  if (!hasEntered && g.maxParticipants && (await participantCount(g.id, rules)) >= g.maxParticipants) {
    await closeGiveaway(g.id, 'system', 'cap');
  }
  return { status: hasEntered ? 'updated' : 'created', entrant };
}

/**
 * Links an Instagram-only person to the Discord account that just entered with the same IG
 * username. If that Discord account already had its own row, the two are merged into one.
 */
async function linkInstagramEntrant(g: Giveaway, igEntrant: Entrant, discordEntrant: Entrant | undefined, discordId: string, discordUsername: string) {
  return db.transaction(async tx => {
    if (discordEntrant && discordEntrant.id !== igEntrant.id) {
      await tx.update(overrides).set({ entrantId: igEntrant.id }).where(eq(overrides.entrantId, discordEntrant.id));
      await tx.delete(entrants).where(eq(entrants.id, discordEntrant.id));
    }
    const [linked] = await tx
      .update(entrants)
      .set({ discordId, discordUsername, updatedAt: new Date() })
      .where(eq(entrants.id, igEntrant.id))
      .returning();
    await tx.insert(auditLog).values({ giveawayId: g.id, actorId: discordId, action: 'entry.linked_discord', details: { igUsername: igEntrant.igUsername, discordUsername } });
    return linked!;
  });
}

export async function setEntrantRevoked(giveawayId: number, entrantId: number, actorId: string, reason: string | null) {
  const revoking = reason !== null;
  const rows = await db
    .update(entrants)
    .set(revoking ? { revokedAt: new Date(), revokedBy: actorId, revokedReason: reason } : { revokedAt: null, revokedBy: null, revokedReason: null })
    .where(and(eq(entrants.giveawayId, giveawayId), eq(entrants.id, entrantId)))
    .returning();
  if (rows.length) await audit(giveawayId, actorId, revoking ? 'entry.disqualified' : 'entry.restored', { entrantId, reason });
  return rows[0];
}

// ---------------------------------------------------------------------------
// Activity log

export type RecordResult = 'recorded' | 'duplicate' | 'own-account' | 'before-start' | 'full';

/**
 * Records one Instagram action in the activity log (safe to repeat; deduplicated by sourceRef)
 * and makes sure the person exists. Whether it counts is decided later by the engine.
 */
export async function recordInstagramActivity(input: {
  giveaway: Giveaway;
  action: 'comment' | 'story' | 'tag';
  igUsername: string;
  at: Date;
  sourceRef: string;
  details?: Record<string, unknown>;
}): Promise<RecordResult> {
  if (input.igUsername === OWN_IG_HANDLE) return 'own-account';
  const g = input.giveaway;
  // Older comments on a giveaway post can never count (no rule reaches before the start), so they
  // aren't recorded: otherwise everyone who ever commented would show up as a person.
  if (input.at < (g.startsAt ?? g.createdAt)) return 'before-start';

  const inserted = await db
    .insert(activities)
    .values({ giveawayId: g.id, platform: 'instagram', action: input.action, igUsername: input.igUsername, sourceRef: input.sourceRef, at: input.at, details: input.details ?? {} })
    .onConflictDoNothing()
    .returning();
  if (!inserted.length) {
    // Seen before: if it had been marked removed (e.g. hidden, then unhidden), it counts again.
    await db
      .update(activities)
      .set({ removedAt: null, removedReason: null })
      .where(and(eq(activities.giveawayId, g.id), eq(activities.platform, 'instagram'), eq(activities.action, input.action), eq(activities.sourceRef, input.sourceRef), isNotNull(activities.removedAt)));
    return 'duplicate';
  }

  if (!(await getEntrantByIg(g.id, input.igUsername))) {
    const rules = await getRules(g.id);
    // A giveaway that doesn't take Discord entries is capped on these people; others only on Discord entries.
    if (!takesDiscordEntries(rules) && g.maxParticipants && (await participantCount(g.id, rules)) >= g.maxParticipants) return 'full';
    const created = await db.insert(entrants).values({ giveawayId: g.id, igUsername: input.igUsername }).onConflictDoNothing().returning();
    if (created.length) {
      await audit(g.id, 'system:instagram', 'person.created', { igUsername: input.igUsername, via: input.action });
      if (!takesDiscordEntries(rules) && g.maxParticipants && (await participantCount(g.id, rules)) >= g.maxParticipants) await closeGiveaway(g.id, 'system', 'cap');
    }
  }
  return 'recorded';
}

/**
 * After a complete read from Instagram: marks recorded actions that are no longer there
 * (deleted or hidden) as removed. `scope` limits it to one post's comments, for example.
 */
export async function markMissingRemoved(giveawayId: number, action: 'comment' | 'tag', stillThere: Set<string>, reason: string, scope?: (a: Activity) => boolean) {
  const recorded = await db
    .select()
    .from(activities)
    .where(and(eq(activities.giveawayId, giveawayId), eq(activities.platform, 'instagram'), eq(activities.action, action), isNull(activities.removedAt)));
  const gone = recorded.filter(a => (!scope || scope(a)) && !stillThere.has(a.sourceRef));
  if (gone.length) {
    await db
      .update(activities)
      .set({ removedAt: new Date(), removedReason: reason })
      .where(inArray(activities.id, gone.map(a => a.id)));
    await audit(giveawayId, 'system:instagram', 'activity.removed', { action, count: gone.length, reason });
  }
  return gone.length;
}

// ---------------------------------------------------------------------------
// Overrides (admin decisions about one person)

export async function addOverride(
  giveawayId: number,
  entrantId: number,
  input: { kind: 'requirement_met'; ruleId: number; reason?: string } | { kind: 'manual_entry'; label: string; weight: number; reason?: string },
  actorId: string,
) {
  const entrant = await db.query.entrants.findFirst({ where: and(eq(entrants.id, entrantId), eq(entrants.giveawayId, giveawayId)) });
  if (!entrant) return null;
  const [row] = await db
    .insert(overrides)
    .values({
      giveawayId,
      entrantId,
      kind: input.kind,
      ruleId: input.kind === 'requirement_met' ? input.ruleId : null,
      label: input.kind === 'manual_entry' ? input.label : null,
      weight: input.kind === 'manual_entry' ? input.weight : 1,
      reason: input.reason ?? null,
      createdBy: actorId,
    })
    .returning();
  await audit(giveawayId, actorId, `override.${input.kind}`, { entrantId, ...input });
  return row!;
}

export async function revokeOverride(giveawayId: number, overrideId: number, actorId: string) {
  const rows = await db
    .update(overrides)
    .set({ revokedAt: new Date(), revokedBy: actorId })
    .where(and(eq(overrides.giveawayId, giveawayId), eq(overrides.id, overrideId), isNull(overrides.revokedAt)))
    .returning();
  if (rows.length) await audit(giveawayId, actorId, 'override.revoked', { overrideId });
  return rows[0];
}

// ---------------------------------------------------------------------------
// Calculating people (eligibility and entries)

export type PersonReport = Entrant & {
  accounts: { instagram: string | null };
  result: EngineResult;
  activities: Activity[];
  overrides: Override[];
  /** In the Discord server: true/false, or null if unknown (no Discord account, or bot offline). */
  inServer: boolean | null;
};

/**
 * Everyone with activity in a giveaway, with eligibility and entries calculated from the
 * activity log, the rules and overrides. Nothing here is stored, so it always reflects the
 * current rules. `rulesOverride` lets a caller preview a rule change (dry run).
 */
export async function computePeople(g: Giveaway, client?: Client, rulesOverride?: EngineRule[]): Promise<PersonReport[]> {
  const rules = rulesOverride ?? (await getRules(g.id));
  const people = await db.select().from(entrants).where(eq(entrants.giveawayId, g.id)).orderBy(asc(entrants.createdAt));
  const acts = await db.select().from(activities).where(and(eq(activities.giveawayId, g.id), isNull(activities.removedAt)));
  const allActs = await db.select().from(activities).where(eq(activities.giveawayId, g.id));
  const ovs = await db.select().from(overrides).where(and(eq(overrides.giveawayId, g.id), isNull(overrides.revokedAt)));
  const members = await serverMemberIds(client).catch(() => null);
  const window = { start: g.startsAt ?? g.createdAt, end: g.closedAt ?? g.endsAt, baseWeight: g.baseWeight };

  return people.map(p => {
    const mine = (a: Activity) => (p.discordId && a.discordId === p.discordId) || (p.igUsername && a.igUsername === p.igUsername);
    const myActs = acts.filter(mine);
    const myOverrides = ovs.filter(o => o.entrantId === p.id);
    const inServer = p.discordId && members ? members.has(p.discordId) : null;
    const result = evaluatePerson({
      giveaway: window,
      rules,
      person: { discordId: p.discordId, disqualified: !!p.revokedAt },
      activities: myActs.map(a => ({ id: a.id, platform: a.platform, action: a.action, at: a.at, details: a.details as { taggedFriend?: boolean; caption?: string } })),
      overrides: myOverrides.map<EngineOverride>(o =>
        o.kind === 'requirement_met' ? { kind: 'requirement_met', ruleId: o.ruleId! } : { kind: 'manual_entry', weight: o.weight, label: o.label },
      ),
      isMember: inServer,
    });
    return { ...p, accounts: { instagram: p.igUsername }, result, activities: allActs.filter(mine), overrides: myOverrides, inServer };
  });
}

export async function auditRows(giveawayId: number, limit = 500) {
  return db.select().from(auditLog).where(eq(auditLog.giveawayId, giveawayId)).orderBy(desc(auditLog.createdAt)).limit(limit);
}

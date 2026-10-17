import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lte, ne, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { auditLog, bonuses, entrants, giveawayRules, giveaways, settings, type FormField, type RuleAction } from '../db/schema.js';
import { chooseRule, type Rule } from './rules.js';

export type Giveaway = typeof giveaways.$inferSelect;
export type Entrant = typeof entrants.$inferSelect;
export type Bonus = typeof bonuses.$inferSelect;
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

// ---------------------------------------------------------------------------
// Giveaways

export async function getGiveaway(id: number) {
  return db.query.giveaways.findFirst({ where: eq(giveaways.id, id) });
}

export async function listGiveaways() {
  return db.select().from(giveaways).orderBy(desc(giveaways.startsAt));
}

export async function getRules(giveawayId: number): Promise<Rule[]> {
  return db
    .select()
    .from(giveawayRules)
    .where(eq(giveawayRules.giveawayId, giveawayId))
    .orderBy(asc(giveawayRules.position), asc(giveawayRules.id));
}

export async function entrantCount(giveawayId: number) {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(entrants)
    .where(and(eq(entrants.giveawayId, giveawayId), isNull(entrants.revokedAt)));
  return row!.n;
}

/** The one giveaway open right now, if any. Closes it first if its participant cap was reached. */
export async function getOpenGiveaway(now = new Date()): Promise<Giveaway | null> {
  const g = await db.query.giveaways.findFirst({
    where: and(isNull(giveaways.closedAt), isNotNull(giveaways.startsAt), lte(giveaways.startsAt, now), gt(giveaways.endsAt, now)),
    orderBy: asc(giveaways.startsAt),
  });
  if (!g) return null;
  if (g.maxParticipants && (await entrantCount(g.id)) >= g.maxParticipants) {
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
 * Permanently deletes a giveaway and everything under it: entrants, bonus entries, rules,
 * sent announcements, audit history and sync status. Leaves one summary row in the
 * general audit log. Callers must check it isn't open.
 */
export async function deleteGiveaway(g: Giveaway, actorId: string) {
  const count = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(entrants)
    .where(eq(entrants.giveawayId, g.id));
  const entrantTotal = count[0]!.n;

  await db.transaction(async tx => {
    await tx.delete(bonuses).where(eq(bonuses.giveawayId, g.id));
    await tx.delete(entrants).where(eq(entrants.giveawayId, g.id));
    await tx.delete(auditLog).where(eq(auditLog.giveawayId, g.id));
    await tx.delete(settings).where(inArray(settings.key, [`ig_sync:${g.id}`, `ig_final_sync:${g.id}`]));
    // Rules and sent announcements go with the giveaway (ON DELETE CASCADE).
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

export async function setGiveawayPost(giveawayId: number, mediaId: string | null, postedAt: Date | null, permalink: string | null) {
  await db
    .update(giveaways)
    .set({ igMediaId: mediaId, igPostedAt: postedAt, igPermalink: permalink, updatedAt: new Date() })
    .where(eq(giveaways.id, giveawayId));
}

// ---------------------------------------------------------------------------
// Entries

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
  | { status: 'conflict'; igUsername: string }
  | { status: 'created' | 'updated' | 'unchanged'; entrant: Entrant };

/**
 * Saves or updates someone's entry from the entry form. Enforces: one entry per Discord
 * account, one Discord account per IG username, required fields, and the participant cap.
 */
export async function submitEntry(input: {
  giveaway: Giveaway;
  discordId: string;
  discordUsername: string;
  values: Record<string, string>;
}): Promise<EntryResult> {
  const g = input.giveaway;
  if (statusOf(g) !== 'open' || g.entryMethod === 'instagram') return { status: 'closed' };

  let igUsername: string | null = null;
  const answers: Record<string, string> = {};
  for (const field of g.formFields) {
    const value = (input.values[field.id] ?? '').trim();
    if (!value) {
      if (field.required) return { status: 'invalid', field };
      continue;
    }
    if (field.type === 'ig_username') {
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
    // "Either" giveaways: someone who already entered through Instagram is now linking Discord.
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
      return { status: 'conflict', igUsername };
    }
  }

  if (existing && existing.igUsername === igUsername && JSON.stringify(existing.answers) === JSON.stringify(answers)) {
    return { status: 'unchanged', entrant: existing };
  }

  if (!existing && g.maxParticipants && (await entrantCount(g.id)) >= g.maxParticipants) {
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
      await audit(g.id, input.discordId, 'entry.updated', {
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
    if ((err as { code?: string }).code === '23505') return { status: 'conflict', igUsername: igUsername ?? '' };
    throw err;
  }

  // The entry that fills the last spot closes the giveaway.
  if (!existing && g.maxParticipants && (await entrantCount(g.id)) >= g.maxParticipants) {
    await closeGiveaway(g.id, 'system', 'cap');
  }
  return { status: existing ? 'updated' : 'created', entrant };
}

/**
 * Links an Instagram-only entrant to the Discord account that just entered with the same IG
 * username. If that Discord account already had its own entry, the two are merged into one.
 */
async function linkInstagramEntrant(g: Giveaway, igEntrant: Entrant, discordEntrant: Entrant | undefined, discordId: string, discordUsername: string) {
  return db.transaction(async tx => {
    if (discordEntrant && discordEntrant.id !== igEntrant.id) {
      await tx.update(bonuses).set({ entrantId: igEntrant.id }).where(eq(bonuses.entrantId, discordEntrant.id));
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
// Bonus entries

export type AwardResult = 'awarded' | 'no-rule' | 'duplicate' | 'own-account' | 'full' | 'disqualified';

/**
 * Records an Instagram action and awards an entry if a rule has room for it.
 * Safe to call repeatedly for the same comment or Story (deduplicated by sourceRef).
 */
export async function awardAction(input: {
  giveaway: Giveaway;
  action: RuleAction;
  igUsername: string;
  at: Date;
  sourceRef: string;
  source: 'ig_api' | 'ig_webhook';
  taggedFriend?: boolean;
  caption?: string;
}): Promise<AwardResult> {
  if (input.igUsername === OWN_IG_HANDLE) return 'own-account';
  // Re-read so a giveaway closed or edited moments ago is respected.
  const g = (await getGiveaway(input.giveaway.id)) ?? input.giveaway;

  const already = await db.query.bonuses.findFirst({
    where: and(eq(bonuses.giveawayId, g.id), eq(bonuses.action, input.action), eq(bonuses.sourceRef, input.sourceRef)),
  });
  if (already) return 'duplicate';

  // Instagram-entry giveaways: a new person's first counted action enters them, if there's room.
  const person = await getEntrantByIg(g.id, input.igUsername);
  if (person?.revokedAt) return 'disqualified';
  const createsEntrant = !person && g.entryMethod !== 'discord';
  if (createsEntrant && g.maxParticipants && (await entrantCount(g.id)) >= g.maxParticipants) return 'full';

  const prior = await db
    .select({ ruleId: bonuses.ruleId, at: bonuses.createdAt })
    .from(bonuses)
    .where(and(eq(bonuses.giveawayId, g.id), eq(bonuses.igUsername, input.igUsername), isNull(bonuses.revokedAt)));

  const rule = chooseRule(
    await getRules(g.id),
    {
      action: input.action,
      at: input.at,
      ...(input.taggedFriend !== undefined ? { taggedFriend: input.taggedFriend } : {}),
      ...(input.caption !== undefined ? { caption: input.caption } : {}),
    },
    { start: g.startsAt ?? g.createdAt, end: g.closedAt ?? g.endsAt },
    prior,
  );
  if (!rule) return 'no-rule';

  const inserted = await db
    .insert(bonuses)
    .values({
      giveawayId: g.id,
      action: input.action,
      ruleId: rule.id,
      igUsername: input.igUsername,
      source: input.source,
      sourceRef: input.sourceRef,
      createdBy: 'system:instagram',
      createdAt: input.at,
    })
    .onConflictDoNothing()
    .returning();
  if (!inserted.length) return 'duplicate';

  await audit(g.id, 'system:instagram', 'bonus.awarded', { igUsername: input.igUsername, action: input.action, ruleId: rule.id });

  if (createsEntrant) {
    const created = await db.insert(entrants).values({ giveawayId: g.id, igUsername: input.igUsername }).onConflictDoNothing().returning();
    if (created.length) {
      await audit(g.id, 'system:instagram', 'entry.created', { igUsername: input.igUsername, via: input.action });
      if (g.maxParticipants && (await entrantCount(g.id)) >= g.maxParticipants) await closeGiveaway(g.id, 'system', 'cap');
    }
  }
  return 'awarded';
}

export async function addManualBonus(giveawayId: number, entrantId: number, label: string, actorId: string) {
  const entrant = await db.query.entrants.findFirst({ where: and(eq(entrants.id, entrantId), eq(entrants.giveawayId, giveawayId)) });
  if (!entrant) return null;
  const [bonus] = await db
    .insert(bonuses)
    .values({ giveawayId, action: 'manual', entrantId, igUsername: entrant.igUsername, label, source: 'admin', createdBy: actorId })
    .returning();
  await audit(giveawayId, actorId, 'bonus.manual_added', { entrantId, label });
  return bonus;
}

/** Entries currently counted for one action (e.g. comments), with the Instagram ID they came from. */
export async function countedBonuses(giveawayId: number, action: RuleAction) {
  return db
    .select({ id: bonuses.id, sourceRef: bonuses.sourceRef })
    .from(bonuses)
    .where(and(eq(bonuses.giveawayId, giveawayId), eq(bonuses.action, action), isNull(bonuses.revokedAt)));
}

export async function revokeBonus(giveawayId: number, bonusId: number, actorId: string, reason: string) {
  const rows = await db
    .update(bonuses)
    .set({ revokedAt: new Date(), revokedBy: actorId, revokedReason: reason })
    .where(and(eq(bonuses.giveawayId, giveawayId), eq(bonuses.id, bonusId), isNull(bonuses.revokedAt)))
    .returning();
  if (rows.length) await audit(giveawayId, actorId, 'bonus.revoked', { bonusId, reason });
  return rows[0];
}

// ---------------------------------------------------------------------------
// Reporting

export type EntrantReport = Entrant & {
  bonuses: Bonus[];
  /** Base entry (1, Discord entrants only) plus active bonuses; 0 if disqualified. */
  totalEntries: number;
};

/** Everyone in a giveaway with their active bonus entries, plus IG bonuses not matched to anyone yet. */
export async function entrantReport(giveawayId: number) {
  const people = await db.select().from(entrants).where(eq(entrants.giveawayId, giveawayId)).orderBy(asc(entrants.createdAt));
  const active = await db
    .select()
    .from(bonuses)
    .where(and(eq(bonuses.giveawayId, giveawayId), isNull(bonuses.revokedAt)))
    .orderBy(asc(bonuses.createdAt));

  const byEntrant = new Map<number, Bonus[]>();
  const byIg = new Map(people.filter(p => p.igUsername).map(p => [p.igUsername!, p.id]));
  const unmatched: Bonus[] = [];
  for (const b of active) {
    const owner = b.entrantId ?? (b.igUsername ? byIg.get(b.igUsername) : undefined);
    if (owner === undefined) unmatched.push(b);
    else byEntrant.set(owner, [...(byEntrant.get(owner) ?? []), b]);
  }

  const report: EntrantReport[] = people.map(p => {
    const list = byEntrant.get(p.id) ?? [];
    // A Discord entry is worth 1 base entry; Instagram-only entrants count their actions.
    return { ...p, bonuses: list, totalEntries: p.revokedAt ? 0 : (p.discordId ? 1 : 0) + list.length };
  });
  return { entrants: report, unmatched };
}

export async function auditRows(giveawayId: number, limit = 500) {
  return db.select().from(auditLog).where(eq(auditLog.giveawayId, giveawayId)).orderBy(desc(auditLog.createdAt)).limit(limit);
}

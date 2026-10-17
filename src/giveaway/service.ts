import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { auditLog, bonuses, entrants, giveaways } from '../db/schema.js';

export const GIVEAWAY = {
  slug: 'gta6-2026',
  title: 'GTA VI Giveaway',
  // 10:30 PM Eastern on Nov 20, 2026 (EST, after daylight saving ends).
  closesAt: new Date('2026-11-20T22:30:00-05:00'),
  igHandle: 'BostonBlerds',
  // The giveaway post is the first @BostonBlerds post whose caption contains this.
  igHashtag: '#BBxGTAVI',
} as const;

export const BONUS_TYPES = ['COMMENT', 'STORY', 'IRL'] as const;
export type BonusType = (typeof BONUS_TYPES)[number];

type Giveaway = typeof giveaways.$inferSelect;
type Entrant = typeof entrants.$inferSelect;

let cached: Giveaway | undefined;

export async function getGiveaway(): Promise<Giveaway> {
  if (cached) return cached;
  const [row] = await db
    .insert(giveaways)
    .values({ slug: GIVEAWAY.slug, closesAt: GIVEAWAY.closesAt })
    .onConflictDoUpdate({ target: giveaways.slug, set: { closesAt: GIVEAWAY.closesAt } })
    .returning();
  cached = row!;
  return cached;
}

export async function setGiveawayPost(mediaId: string, postedAt: Date) {
  const g = await getGiveaway();
  const [row] = await db
    .update(giveaways)
    .set({ igMediaId: mediaId, igPostedAt: postedAt })
    .where(eq(giveaways.id, g.id))
    .returning();
  cached = row!;
}

export function isClosed(now = new Date()) {
  return now >= GIVEAWAY.closesAt;
}

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

export async function audit(actorId: string, action: string, details: Record<string, unknown> = {}) {
  const g = await getGiveaway();
  await db.insert(auditLog).values({ giveawayId: g.id, actorId, action, details });
}

export async function getEntrantByDiscord(discordId: string): Promise<Entrant | undefined> {
  const g = await getGiveaway();
  return db.query.entrants.findFirst({
    where: and(eq(entrants.giveawayId, g.id), eq(entrants.discordId, discordId)),
  });
}

export async function getEntrantByIg(igUsername: string): Promise<Entrant | undefined> {
  const g = await getGiveaway();
  return db.query.entrants.findFirst({
    where: and(eq(entrants.giveawayId, g.id), eq(entrants.igUsername, igUsername)),
  });
}

export type EntryResult =
  | { status: 'invalid' | 'closed' }
  | { status: 'revoked'; entrant: Entrant }
  | { status: 'conflict'; igUsername: string }
  | { status: 'created' | 'updated' | 'unchanged'; entrant: Entrant };

export async function submitEntry(input: {
  discordId: string;
  discordUsername: string;
  rawIg: string;
}): Promise<EntryResult> {
  if (isClosed()) return { status: 'closed' };
  const igUsername = normalizeIg(input.rawIg);
  if (!igUsername) return { status: 'invalid' };

  const g = await getGiveaway();
  const existing = await getEntrantByDiscord(input.discordId);
  if (existing?.revokedAt) return { status: 'revoked', entrant: existing };

  const owner = await getEntrantByIg(igUsername);
  if (owner && owner.discordId !== input.discordId) {
    await audit(input.discordId, 'entry.ig_conflict', {
      igUsername,
      claimedByDiscordId: owner.discordId,
      attemptedByUsername: input.discordUsername,
    });
    return { status: 'conflict', igUsername };
  }

  if (existing && existing.igUsername === igUsername) {
    return { status: 'unchanged', entrant: existing };
  }

  let entrant: Entrant;
  try {
    if (existing) {
      [entrant] = (await db
        .update(entrants)
        .set({ igUsername, discordUsername: input.discordUsername, updatedAt: new Date() })
        .where(eq(entrants.id, existing.id))
        .returning()) as [Entrant];
      await audit(input.discordId, 'entry.updated', { from: existing.igUsername, to: igUsername });
    } else {
      [entrant] = (await db
        .insert(entrants)
        .values({ giveawayId: g.id, discordId: input.discordId, discordUsername: input.discordUsername, igUsername })
        .returning()) as [Entrant];
      await audit(input.discordId, 'entry.created', { igUsername, discordUsername: input.discordUsername });
    }
  } catch (err) {
    // Lost a race with someone claiming the same IG username.
    if ((err as { code?: string }).code === '23505') return { status: 'conflict', igUsername };
    throw err;
  }

  return { status: existing ? 'updated' : 'created', entrant };
}

export async function addBonus(input: {
  igUsername: string;
  type: BonusType;
  source: (typeof bonuses.$inferInsert)['source'];
  actorId: string;
  sourceRef?: string;
}): Promise<{ status: 'added' | 'reactivated' | 'exists'; matched: boolean }> {
  const g = await getGiveaway();
  const existing = await db.query.bonuses.findFirst({
    where: and(eq(bonuses.giveawayId, g.id), eq(bonuses.igUsername, input.igUsername), eq(bonuses.type, input.type)),
  });
  const matched = !!(await getEntrantByIg(input.igUsername));

  if (existing && !existing.revokedAt) return { status: 'exists', matched };

  if (existing) {
    await db
      .update(bonuses)
      .set({ revokedAt: null, revokedBy: null, revokedReason: null, source: input.source, createdBy: input.actorId })
      .where(eq(bonuses.id, existing.id));
  } else {
    await db.insert(bonuses).values({
      giveawayId: g.id,
      igUsername: input.igUsername,
      type: input.type,
      source: input.source,
      sourceRef: input.sourceRef ?? null,
      createdBy: input.actorId,
    });
  }
  await audit(input.actorId, 'bonus.added', { igUsername: input.igUsername, type: input.type, source: input.source });
  return { status: existing ? 'reactivated' : 'added', matched };
}

export async function revokeBonus(igUsername: string, type: BonusType, actorId: string, reason: string) {
  const g = await getGiveaway();
  const rows = await db
    .update(bonuses)
    .set({ revokedAt: new Date(), revokedBy: actorId, revokedReason: reason })
    .where(
      and(
        eq(bonuses.giveawayId, g.id),
        eq(bonuses.igUsername, igUsername),
        eq(bonuses.type, type),
        isNull(bonuses.revokedAt),
      ),
    )
    .returning();
  if (rows.length) await audit(actorId, 'bonus.revoked', { igUsername, type, reason });
  return rows.length > 0;
}

export async function setEntryRevoked(igUsername: string, actorId: string, reason: string | null) {
  const g = await getGiveaway();
  const revoking = reason !== null;
  const rows = await db
    .update(entrants)
    .set(
      revoking
        ? { revokedAt: new Date(), revokedBy: actorId, revokedReason: reason }
        : { revokedAt: null, revokedBy: null, revokedReason: null },
    )
    .where(and(eq(entrants.giveawayId, g.id), eq(entrants.igUsername, igUsername)))
    .returning();
  if (rows.length) await audit(actorId, revoking ? 'entry.revoked' : 'entry.restored', { igUsername, reason });
  return rows.length > 0;
}

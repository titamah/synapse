import { and, desc, gt, isNotNull, lte, or } from 'drizzle-orm';
import { db } from '../db/client.js';
import { giveaways } from '../db/schema.js';
import { getSetting, setSetting } from '../db/settings.js';
import { getOpenGiveaway, statusOf, type Giveaway } from '../giveaway/service.js';
import { syncComments } from './comments.js';
import { hasTagRules, syncTaggedPosts } from './tags.js';

export type SyncStatus = {
  lastRunAt: string;
  lastSuccessAt: string | null;
  lastError: string | null;
  lastReason: string;
  lastResult: { comments: Record<string, number> | null; taggedPosts: Record<string, number> | null } | null;
};

const statusKey = (id: number) => `ig_sync:${id}`;
const finalKey = (id: number) => `ig_final_sync:${id}`;

export function getSyncStatus(giveawayId: number) {
  return getSetting<SyncStatus>(statusKey(giveawayId));
}

/**
 * Reads the giveaway post's comments and records how it went, so the dashboard can warn
 * when Instagram stops working (e.g. the token expired). Never throws.
 */
export async function runCommentSync(g: Giveaway, reason: 'scheduled' | 'post-set' | 'final' | 'manual') {
  const previous = await getSyncStatus(g.id);
  const now = new Date().toISOString();
  try {
    const result = { comments: await syncComments(g), taggedPosts: await syncTaggedPosts(g) };
    await setSetting(statusKey(g.id), {
      lastRunAt: now,
      lastSuccessAt: now,
      lastError: null,
      lastReason: reason,
      lastResult: result,
    } satisfies SyncStatus);
    console.log(`Instagram sync (${reason}) for "${g.name}":`, JSON.stringify(result));
    return result;
  } catch (err) {
    const message = (err as Error).message;
    console.error(`Comment sync (${reason}) for "${g.name}" failed:`, message);
    await setSetting(statusKey(g.id), {
      lastRunAt: now,
      lastSuccessAt: previous?.lastSuccessAt ?? null,
      lastError: message,
      lastReason: reason,
      lastResult: null,
    } satisfies SyncStatus);
    return null;
  }
}

/** One last complete read after a giveaway closes, so exports include every comment. */
export async function runFinalSync(g: Giveaway) {
  if (await getSetting(finalKey(g.id))) return;
  const result = await runCommentSync(g, 'final');
  const status = await getSyncStatus(g.id);
  if (status?.lastError === null) await setSetting(finalKey(g.id), { at: new Date().toISOString(), result });
}

/** Every 30 minutes: the open giveaway, plus a final read for any that closed in the last 2 days. */
export async function runScheduledSyncs() {
  const open = await getOpenGiveaway();
  if (open && (open.igMediaId || (await hasTagRules(open)))) await runCommentSync(open, 'scheduled');

  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  const recentlyClosed = await db.query.giveaways.findMany({
    where: and(
      or(isNotNull(giveaways.igMediaId), isNotNull(giveaways.startsAt)),
      or(and(isNotNull(giveaways.closedAt), gt(giveaways.closedAt, twoDaysAgo)), and(lte(giveaways.endsAt, new Date()), gt(giveaways.endsAt, twoDaysAgo))),
    ),
    orderBy: desc(giveaways.endsAt),
  });
  for (const g of recentlyClosed) {
    if (statusOf(g) === 'closed' && (g.igMediaId || (await hasTagRules(g)))) await runFinalSync(g);
  }
}


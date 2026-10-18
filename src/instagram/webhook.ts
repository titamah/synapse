import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { giveaways, webhookEvents } from '../db/schema.js';
import { getOpenGiveaway, normalizeIg, recordInstagramActivity, type Giveaway } from '../giveaway/service.js';
import { getUsernameForSender, giveawayPosts } from './api.js';
import { processComment } from './comments.js';

type Change = { field: string; value: any };
type Messaging = {
  sender?: { id: string };
  recipient?: { id: string };
  timestamp?: number;
  message?: { mid?: string; attachments?: { type: string }[] };
};
type Entry = { id: string; time: number; changes?: Change[]; messaging?: Messaging[] };
type Payload = { object: string; entry?: Entry[] };

const isStoryMention = (m: Messaging) => !!m.message?.attachments?.some(a => a.type === 'story_mention');

/**
 * Keeps only what giveaways need: comments on a giveaway post and Story mentions. Everything
 * else (regular DMs, comments on other posts) is dropped without being stored. With no posts
 * known yet (null), all comments are kept. Returns null when nothing is left.
 */
export function filterInstagramPayload(payload: Payload, giveawayMediaIds: Set<string> | null): Payload | null {
  const entry = (payload.entry ?? [])
    .map(e => {
      const changes = e.changes?.filter(
        c => c.field === 'comments' && (!giveawayMediaIds || giveawayMediaIds.has(c.value?.media?.id)),
      );
      const messaging = e.messaging?.filter(isStoryMention);
      return {
        ...e,
        ...(changes ? { changes } : {}),
        ...(messaging ? { messaging } : {}),
      };
    })
    .filter(e => (e.changes?.length ?? 0) + (e.messaging?.length ?? 0) > 0);

  return entry.length ? { ...payload, entry } : null;
}

async function processStoryMention(g: Giveaway, m: Messaging) {
  const senderId = m.sender?.id;
  // Our own account mentioning itself, or a malformed event.
  if (!senderId || senderId === m.recipient?.id || !m.message?.mid) return 'skipped';
  const at = m.timestamp ? new Date(m.timestamp) : new Date();
  const username = normalizeIg(await getUsernameForSender(senderId));
  if (!username) return 'skipped';
  // Recorded either way; the engine only counts Stories from after the first giveaway post.
  return recordInstagramActivity({ giveaway: g, action: 'story', igUsername: username, at, sourceRef: m.message.mid });
}

/** Records the comments (on giveaway posts) and Story mentions in a filtered payload. Safe to re-run. */
export async function processInstagramPayload(payload: Payload, g: Giveaway) {
  const postIds = new Set(giveawayPosts(g).map(p => p.id));
  for (const e of payload.entry ?? []) {
    for (const c of e.changes ?? []) {
      const v = c.value;
      if (postIds.has(v?.media?.id) && v?.from?.username && typeof v.text === 'string' && v.id) {
        const at = e.time ? new Date(e.time * 1000) : new Date();
        await processComment(g, { id: v.id, username: v.from.username, text: v.text, at, mediaId: v.media.id });
      }
    }
    for (const m of e.messaging ?? []) {
      if (isStoryMention(m)) await processStoryMention(g, m);
    }
  }
}

/**
 * The giveaway that stored events should be checked against: the open one, or one that
 * closed in the last day (so a restart right after closing doesn't lose late events).
 */
async function giveawayForProcessing(): Promise<Giveaway | null> {
  const open = await getOpenGiveaway();
  if (open) return open;
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const recent = await db.query.giveaways.findFirst({ where: gt(giveaways.endsAt, dayAgo), orderBy: desc(giveaways.endsAt) });
  return recent ?? null;
}

/** Processes stored events that haven't been yet (bot restarted, API call failed, post not found yet). */
export async function processPendingInstagramEvents() {
  const pending = await db
    .select()
    .from(webhookEvents)
    .where(and(eq(webhookEvents.source, 'instagram'), isNull(webhookEvents.processedAt)))
    .orderBy(webhookEvents.id);
  if (!pending.length) return;

  const g = await giveawayForProcessing();

  let done = 0;
  for (const event of pending) {
    try {
      // No giveaway to attach it to: nothing can count, so just mark it handled.
      if (g) await processInstagramPayload(event.payload as Payload, g);
      await db.update(webhookEvents).set({ processedAt: new Date() }).where(eq(webhookEvents.id, event.id));
      done++;
    } catch (err) {
      console.error(`Webhook event ${event.id} still failing:`, (err as Error).message);
    }
  }
  console.log(`Processed ${done}/${pending.length} pending webhook events`);
}

import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { webhookEvents } from '../db/schema.js';
import { GIVEAWAY, addBonus, normalizeIg } from '../giveaway/service.js';
import { getUsernameForSender, knownGiveawayPost, type GiveawayPost } from './api.js';
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
 * Keeps only what the giveaway needs: comments on the giveaway post and Story
 * mentions. Everything else (regular DMs, comments on other posts) is dropped
 * without being stored. Returns null when nothing is left.
 */
export function filterInstagramPayload(payload: Payload, giveawayMediaId: string | null): Payload | null {
  const entry = (payload.entry ?? [])
    .map(e => {
      const changes = e.changes?.filter(
        c => c.field === 'comments' && (!giveawayMediaId || c.value?.media?.id === giveawayMediaId),
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

async function processStoryMention(m: Messaging, post: GiveawayPost) {
  const senderId = m.sender?.id;
  // Our own account mentioning itself, or a malformed event.
  if (!senderId || senderId === m.recipient?.id) return 'skipped';
  const at = m.timestamp ? new Date(m.timestamp) : new Date();
  // Only Story mentions from after the giveaway post went up, and before entries close.
  if (at < post.postedAt) return 'early';
  if (at >= GIVEAWAY.closesAt) return 'late';

  const username = normalizeIg(await getUsernameForSender(senderId));
  if (!username || username === GIVEAWAY.igHandle.toLowerCase()) return 'skipped';

  const result = await addBonus({
    igUsername: username,
    type: 'STORY',
    source: 'ig_webhook',
    actorId: 'system:instagram',
    ...(m.message?.mid ? { sourceRef: m.message.mid } : {}),
  });
  return result.status;
}

/**
 * Awards bonuses for the comments and Story mentions in a (filtered) payload.
 * Comments only count on the giveaway post. Safe to re-run.
 */
export async function processInstagramPayload(payload: Payload, post: GiveawayPost) {
  for (const e of payload.entry ?? []) {
    for (const c of e.changes ?? []) {
      const v = c.value;
      if (v?.media?.id === post.id && v?.from?.username && typeof v.text === 'string' && v.id) {
        await processComment({ id: v.id, username: v.from.username, text: v.text }, 'ig_webhook');
      }
    }
    for (const m of e.messaging ?? []) {
      if (isStoryMention(m)) await processStoryMention(m, post);
    }
  }
}

/** Retries stored events that were never processed (e.g. the bot restarted, or the API call failed). */
export async function processPendingInstagramEvents() {
  // Events wait until the giveaway post exists; until then there's nothing to compare against.
  const post = await knownGiveawayPost();
  if (!post) return;

  const pending = await db
    .select()
    .from(webhookEvents)
    .where(and(eq(webhookEvents.source, 'instagram'), isNull(webhookEvents.processedAt)))
    .orderBy(webhookEvents.id);

  let done = 0;
  for (const event of pending) {
    try {
      await processInstagramPayload(event.payload as Payload, post);
      await db.update(webhookEvents).set({ processedAt: new Date() }).where(eq(webhookEvents.id, event.id));
      done++;
    } catch (err) {
      console.error(`Webhook event ${event.id} still failing:`, (err as Error).message);
    }
  }
  if (pending.length) console.log(`Retried ${pending.length} pending webhook events, ${done} processed`);
}

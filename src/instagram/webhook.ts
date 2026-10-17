import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { giveaways, webhookEvents } from '../db/schema.js';
import { awardAction, getOpenGiveaway, normalizeIg, statusOf, type Giveaway } from '../giveaway/service.js';
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

async function processStoryMention(g: Giveaway, post: GiveawayPost, m: Messaging) {
  const senderId = m.sender?.id;
  // Our own account mentioning itself, or a malformed event.
  if (!senderId || senderId === m.recipient?.id || !m.message?.mid) return 'skipped';
  const at = m.timestamp ? new Date(m.timestamp) : new Date();
  // Story mentions only count once the giveaway post is up; the rules handle the giveaway's dates.
  if (at < post.postedAt) return 'early';

  const username = normalizeIg(await getUsernameForSender(senderId));
  if (!username) return 'skipped';
  return awardAction({ giveaway: g, action: 'ig_story', igUsername: username, at, sourceRef: m.message.mid, source: 'ig_webhook' });
}

/**
 * Awards entries for the comments and Story mentions in a (filtered) payload.
 * Comments only count on the giveaway post. Safe to re-run.
 */
export async function processInstagramPayload(payload: Payload, g: Giveaway, post: GiveawayPost) {
  for (const e of payload.entry ?? []) {
    for (const c of e.changes ?? []) {
      const v = c.value;
      if (v?.media?.id === post.id && v?.from?.username && typeof v.text === 'string' && v.id) {
        const at = e.time ? new Date(e.time * 1000) : new Date();
        await processComment(g, { id: v.id, username: v.from.username, text: v.text, at }, 'ig_webhook');
      }
    }
    for (const m of e.messaging ?? []) {
      if (isStoryMention(m)) await processStoryMention(g, post, m);
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
  const post = g ? knownGiveawayPost(g) : null;
  // An open giveaway whose post isn't up yet: keep waiting.
  if (g && !post && statusOf(g) === 'open') return;

  let done = 0;
  for (const event of pending) {
    try {
      // No giveaway (or one that closed without a post): nothing can count, so just mark it handled.
      if (g && post) await processInstagramPayload(event.payload as Payload, g, post);
      await db.update(webhookEvents).set({ processedAt: new Date() }).where(eq(webhookEvents.id, event.id));
      done++;
    } catch (err) {
      console.error(`Webhook event ${event.id} still failing:`, (err as Error).message);
    }
  }
  console.log(`Processed ${done}/${pending.length} pending webhook events`);
}

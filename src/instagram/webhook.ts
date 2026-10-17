import { processComment } from './comments.js';

type Change = { field: string; value: any };
type Messaging = { sender?: { id: string }; message?: { mid?: string; attachments?: { type: string }[] } };
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

/** Awards bonuses for the comments in a (filtered) payload. Story mentions are handled later. */
export async function processInstagramPayload(payload: Payload) {
  for (const e of payload.entry ?? []) {
    for (const c of e.changes ?? []) {
      const v = c.value;
      if (v?.from?.username && typeof v.text === 'string' && v.id) {
        await processComment({ id: v.id, username: v.from.username, text: v.text }, 'ig_webhook');
      }
    }
  }
}

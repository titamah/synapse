import { OWN_IG_HANDLE, giveawayPosts, markMissingRemoved, normalizeIg, recordInstagramActivity, type Giveaway } from '../giveaway/service.js';
import { getAllComments } from './api.js';

/** How long a comment webhook may take before a read counts the comment as missed by it. */
const WEBHOOK_GRACE_MS = 5 * 60 * 1000;

/** "Tag a friend": the comment @mentions someone other than us or the commenter. */
export function tagsAFriend(username: string, text: string): boolean {
  const mentions = [...text.matchAll(/@([A-Za-z0-9._]+)/g)].map(m => m[1]!.toLowerCase().replace(/\.+$/, ''));
  return mentions.some(m => m !== OWN_IG_HANDLE && m !== username);
}

/** Records a comment on a giveaway post in the activity log. Whether it counts is up to the rules. */
export async function processComment(g: Giveaway, comment: { id: string; username: string; text: string; at: Date; mediaId: string }) {
  const username = normalizeIg(comment.username);
  if (!username) return 'invalid-username';
  return recordInstagramActivity({
    giveaway: g,
    action: 'comment',
    igUsername: username,
    at: comment.at,
    sourceRef: comment.id,
    details: { taggedFriend: tagsAFriend(username, comment.text), mediaId: comment.mediaId },
  });
}

/**
 * Reads every comment on every giveaway post: records new ones and marks deleted or hidden ones
 * as removed (so they stop counting). Only acts on a complete read; if Instagram fails partway,
 * it throws and nothing is changed.
 */
export async function syncComments(g: Giveaway, opts: { missedSince?: Date | undefined } = {}) {
  const posts = await giveawayPosts(g);
  if (!posts.length) return null;

  const counts: Record<string, number> = { posts: posts.length, comments: 0, hidden: 0, removed: 0 };
  for (const post of posts) {
    const all = await getAllComments(post.id);
    const visible = all.filter(c => !c.hidden);
    counts.comments! += visible.length;
    counts.hidden! += all.length - visible.length;
    counts.removed! += await markMissingRemoved(g.id, 'comment', new Set(visible.map(c => c.id)), 'Comment deleted or hidden', a => a.details.mediaId === post.id);
    for (const c of visible) {
      const at = new Date(c.timestamp);
      const outcome = await processComment(g, { id: c.id, username: c.username, text: c.text, at, mediaId: post.id });
      counts[outcome] = (counts[outcome] ?? 0) + 1;
      // New to us, written since the last read and more than 5 minutes ago: the webhook should
      // have delivered it already, so it missed it.
      if (outcome === 'recorded' && opts.missedSince && at >= opts.missedSince && Date.now() - at.getTime() > WEBHOOK_GRACE_MS) {
        counts.missedByWebhook = (counts.missedByWebhook ?? 0) + 1;
      }
    }
  }
  return counts;
}

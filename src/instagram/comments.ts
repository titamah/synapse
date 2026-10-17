import { OWN_IG_HANDLE, awardAction, normalizeIg, type Giveaway } from '../giveaway/service.js';
import { findGiveawayPost, getAllComments } from './api.js';

/** "Tag a friend": the comment @mentions someone other than us or the commenter. */
export function tagsAFriend(username: string, text: string): boolean {
  const mentions = [...text.matchAll(/@([A-Za-z0-9._]+)/g)].map(m => m[1]!.toLowerCase().replace(/\.+$/, ''));
  return mentions.some(m => m !== OWN_IG_HANDLE && m !== username);
}

/** Awards an entry for a comment on the giveaway post if a rule has room. Safe to repeat. */
export async function processComment(
  g: Giveaway,
  comment: { id: string; username: string; text: string; at: Date },
  source: 'ig_api' | 'ig_webhook',
) {
  const username = normalizeIg(comment.username);
  if (!username) return 'invalid-username';
  return awardAction({
    giveaway: g,
    action: 'ig_comment',
    igUsername: username,
    at: comment.at,
    sourceRef: comment.id,
    source,
    taggedFriend: tagsAFriend(username, comment.text),
  });
}

/** Reads every comment on the giveaway post and awards any missing entries. */
export async function syncComments(g: Giveaway) {
  const post = await findGiveawayPost(g);
  if (!post) return null;

  const comments = await getAllComments(post.id);
  const counts: Record<string, number> = {};
  for (const c of comments) {
    const outcome = await processComment(g, { id: c.id, username: c.username, text: c.text, at: new Date(c.timestamp) }, 'ig_api');
    counts[outcome] = (counts[outcome] ?? 0) + 1;
  }
  return { total: comments.length, ...counts };
}

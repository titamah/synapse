import { OWN_IG_HANDLE, awardAction, countedCommentBonuses, normalizeIg, revokeBonus, type Giveaway } from '../giveaway/service.js';
import { getAllComments, knownGiveawayPost } from './api.js';

/** "Tag a friend": the comment @mentions someone other than us or the commenter. */
export function tagsAFriend(username: string, text: string): boolean {
  const mentions = [...text.matchAll(/@([A-Za-z0-9._]+)/g)].map(m => m[1]!.toLowerCase().replace(/\.+$/, ''));
  return mentions.some(m => m !== OWN_IG_HANDLE && m !== username);
}

/** Counted comments that are no longer visible on the post (deleted or hidden). */
export function commentsToRevoke(counted: { id: number; sourceRef: string | null }[], visibleIds: Set<string>) {
  return counted.filter(b => b.sourceRef && !visibleIds.has(b.sourceRef));
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

/**
 * Reads every comment on the giveaway post: removes entries for comments that were deleted
 * or hidden, then awards any missing ones. Only acts on a complete read; if Instagram fails
 * partway, it throws and nothing is changed.
 */
export async function syncComments(g: Giveaway) {
  const post = knownGiveawayPost(g);
  if (!post) return null;

  const all = await getAllComments(post.id);
  const visible = all.filter(c => !c.hidden);

  const removed = commentsToRevoke(await countedCommentBonuses(g.id), new Set(visible.map(c => c.id)));
  for (const b of removed) await revokeBonus(g.id, b.id, 'system:instagram', 'Comment deleted or hidden');

  const counts: Record<string, number> = {};
  for (const c of visible) {
    const outcome = await processComment(g, { id: c.id, username: c.username, text: c.text, at: new Date(c.timestamp) }, 'ig_api');
    counts[outcome] = (counts[outcome] ?? 0) + 1;
  }
  return { comments: visible.length, hidden: all.length - visible.length, removed: removed.length, ...counts };
}

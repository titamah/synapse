import { GIVEAWAY, addBonus, normalizeIg } from '../giveaway/service.js';
import { findGiveawayPost, getAllComments, type IgComment } from './api.js';

const ACTOR = 'system:instagram';
const ownHandle = GIVEAWAY.igHandle.toLowerCase();

/** "Comment and tag a friend": the comment must @mention someone other than us or the commenter. */
export function tagsAFriend(username: string, text: string): boolean {
  const mentions = [...text.matchAll(/@([A-Za-z0-9._]+)/g)].map(m => m[1]!.toLowerCase().replace(/\.+$/, ''));
  return mentions.some(m => m !== ownHandle && m !== username);
}

/** Awards the comment bonus if this comment qualifies. Safe to call repeatedly for the same comment. */
export async function processComment(comment: Pick<IgComment, 'id' | 'username' | 'text'> & { timestamp?: string }, source: 'ig_api' | 'ig_webhook') {
  const username = normalizeIg(comment.username);
  if (!username || username === ownHandle) return 'skipped';
  if (comment.timestamp && new Date(comment.timestamp) >= GIVEAWAY.closesAt) return 'late';
  if (!tagsAFriend(username, comment.text)) return 'no-tag';

  const result = await addBonus({ igUsername: username, type: 'COMMENT', source, actorId: ACTOR, sourceRef: comment.id });
  return result.status;
}

/** Reads every comment on the giveaway post and awards any missing comment bonuses. */
export async function syncComments() {
  const post = await findGiveawayPost();
  if (!post) return null;

  const comments = await getAllComments(post.id);
  const counts: Record<string, number> = {};
  for (const c of comments) {
    const outcome = await processComment(c, 'ig_api');
    counts[outcome] = (counts[outcome] ?? 0) + 1;
  }
  return { total: comments.length, ...counts };
}

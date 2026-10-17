import { awardAction, countedBonuses, getRules, normalizeIg, revokeBonus, type Giveaway } from '../giveaway/service.js';
import { getTaggedPosts } from './api.js';
import { commentsToRevoke } from './comments.js';

export async function hasTagRules(g: Giveaway) {
  return (await getRules(g.id)).some(r => r.action === 'ig_tag');
}

/**
 * Reads posts that tag @BostonBlerds since the giveaway started: removes entries for posts that
 * were deleted (or untagged us), then awards any missing ones. Only acts on a complete read.
 */
export async function syncTaggedPosts(g: Giveaway) {
  if (!g.startsAt || !(await hasTagRules(g))) return null;
  const posts = await getTaggedPosts(g.startsAt);

  const removed = commentsToRevoke(await countedBonuses(g.id, 'ig_tag'), new Set(posts.map(p => p.id)));
  for (const b of removed) await revokeBonus(g.id, b.id, 'system:instagram', 'Post deleted or no longer tags us');

  const counts: Record<string, number> = {};
  for (const p of posts) {
    const username = normalizeIg(p.username);
    const outcome = username
      ? await awardAction({ giveaway: g, action: 'ig_tag', igUsername: username, at: new Date(p.timestamp), sourceRef: p.id, source: 'ig_api', caption: p.caption })
      : 'invalid-username';
    counts[outcome] = (counts[outcome] ?? 0) + 1;
  }
  return { posts: posts.length, removed: removed.length, ...counts };
}

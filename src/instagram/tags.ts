import { getRules, markMissingRemoved, normalizeIg, recordInstagramActivity, type Giveaway } from '../giveaway/service.js';
import { getTaggedPosts } from './api.js';

export async function hasTagRules(g: Giveaway) {
  return (await getRules(g.id)).some(r => r.platform === 'instagram' && r.action === 'tag');
}

/**
 * Reads posts that tag @BostonBlerds since the giveaway started: records new ones and marks
 * deleted (or no-longer-tagging) ones as removed. Only acts on a complete read.
 */
export async function syncTaggedPosts(g: Giveaway) {
  if (!g.startsAt || !(await hasTagRules(g))) return null;
  const posts = await getTaggedPosts(g.startsAt);
  const removed = await markMissingRemoved(g.id, 'tag', new Set(posts.map(p => p.id)), 'Post deleted or no longer tags us');

  const counts: Record<string, number> = { posts: posts.length, removed };
  for (const p of posts) {
    const username = normalizeIg(p.username);
    const outcome = username
      ? await recordInstagramActivity({ giveaway: g, action: 'tag', igUsername: username, at: new Date(p.timestamp), sourceRef: p.id, details: { caption: p.caption, permalink: p.permalink } })
      : 'invalid-username';
    counts[outcome] = (counts[outcome] ?? 0) + 1;
  }
  return counts;
}

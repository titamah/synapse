import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { giveaways } from '../db/schema.js';
import { audit, getGiveaway, type Giveaway } from '../giveaway/service.js';
import { listRecentPosts } from './api.js';

/** Our posts this long before the giveaway starts can still be giveaway posts (teasers). */
const LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

/** Does a caption use this exact hashtag? (#BBxGTA matches "#bbxgta!" but not "#BBxGTAVI"). */
export function hasHashtag(caption: string | null, hashtag: string) {
  if (!caption) return false;
  const tag = hashtag.replace(/^#/, '').toLowerCase();
  return (caption.toLowerCase().match(/#\w+/g) ?? []).some(t => t.slice(1) === tag);
}

/**
 * autoIncludeHashtag: any of our recent posts using the giveaway's hashtag becomes a giveaway
 * post automatically (comments on it count like comments on the main post). Returns the
 * giveaway, reloaded if posts were added.
 */
export async function includeHashtagPosts(g: Giveaway): Promise<Giveaway> {
  const ig = g.platformSettings.instagram;
  if (!ig?.autoIncludeHashtag) return g;
  const from = (g.startsAt ?? g.createdAt).getTime() - LOOKBACK_MS;
  const known = new Set(ig.posts.map(p => p.id));
  const found = (await listRecentPosts(25)).filter(
    p => !known.has(p.id) && hasHashtag(p.caption, ig.autoIncludeHashtag!) && new Date(p.postedAt).getTime() >= from && new Date(p.postedAt) <= g.endsAt,
  );
  if (!found.length) return g;

  const posts = [...ig.posts, ...found.map(p => ({ id: p.id, permalink: p.permalink, postedAt: p.postedAt }))].sort((a, b) => a.postedAt.localeCompare(b.postedAt));
  await db
    .update(giveaways)
    .set({ platformSettings: { ...g.platformSettings, instagram: { ...ig, posts } } })
    .where(eq(giveaways.id, g.id));
  await audit(g.id, 'system', 'instagram.posts_added', { hashtag: ig.autoIncludeHashtag, posts: found.map(p => p.permalink) });
  console.log(`Added ${found.length} ${ig.autoIncludeHashtag} post(s) to "${g.name}"`);
  return (await getGiveaway(g.id))!;
}

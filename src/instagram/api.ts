import { env } from '../config/environment.js';
import { GIVEAWAY, getGiveaway, setGiveawayPost } from '../giveaway/service.js';

const GRAPH = 'https://graph.instagram.com/v26.0';

export type IgComment = { id: string; username: string; text: string; timestamp: string };

async function graphGet<T>(pathOrUrl: string, params: Record<string, string> = {}): Promise<T> {
  if (!env.IG_ACCESS_TOKEN) throw new Error('IG_ACCESS_TOKEN is not set');
  const url = new URL(pathOrUrl.startsWith('http') ? pathOrUrl : `${GRAPH}${pathOrUrl}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  if (!url.searchParams.has('access_token')) url.searchParams.set('access_token', env.IG_ACCESS_TOKEN);

  const res = await fetch(url);
  const body = (await res.json()) as T & { error?: { message: string } };
  if (!res.ok || body.error) throw new Error(`Instagram API ${res.status}: ${body.error?.message ?? 'unknown error'}`);
  return body;
}

/** Follows `paging.next` links until every item has been read. */
async function getAll<T>(path: string, params: Record<string, string>): Promise<T[]> {
  const items: T[] = [];
  let page = await graphGet<{ data: T[]; paging?: { next?: string } }>(path, params);
  items.push(...page.data);
  while (page.paging?.next) {
    page = await graphGet(page.paging.next);
    items.push(...page.data);
  }
  return items;
}

export async function getAccount() {
  return graphGet<{ user_id: string; username: string }>('/me', { fields: 'user_id,username' });
}

export type GiveawayPost = { id: string; postedAt: Date };

/** The giveaway post if it's already been found (database only, no API call). */
export async function knownGiveawayPost(): Promise<GiveawayPost | null> {
  const g = await getGiveaway();
  return g.igMediaId && g.igPostedAt ? { id: g.igMediaId, postedAt: g.igPostedAt } : null;
}

/**
 * The giveaway post, or null if it hasn't gone up yet. Checked in order: the
 * database (once found, it's saved), the IG_GIVEAWAY_POST override, then
 * @BostonBlerds' recent posts for one whose caption contains the giveaway hashtag.
 */
export async function findGiveawayPost(): Promise<GiveawayPost | null> {
  const known = await knownGiveawayPost();
  if (known) return known;

  type Media = { id: string; caption?: string; permalink: string; timestamp: string };
  const recent = await graphGet<{ data: Media[] }>('/me/media', { fields: 'id,caption,permalink,timestamp', limit: '25' });

  const override = env.IG_GIVEAWAY_POST?.trim();
  const shortcode = override?.match(/instagram\.com\/(?:p|reel)\/([^/?#]+)/)?.[1];
  const tag = GIVEAWAY.igHashtag.toLowerCase();
  const match = override
    ? recent.data.find(m => m.id === override || (shortcode && m.permalink.includes(`/${shortcode}`)))
    : recent.data
        .filter(m => m.caption?.toLowerCase().split(/\s+/).some(word => word.replace(/[^\w#]/g, '') === tag))
        .sort((x, y) => x.timestamp.localeCompare(y.timestamp))[0];
  if (!match) return null;

  const post = { id: match.id, postedAt: new Date(match.timestamp) };
  await setGiveawayPost(post.id, post.postedAt);
  console.log(`Giveaway post found: ${match.permalink}`);
  return post;
}

/** Every comment and reply on a post. */
export async function getAllComments(mediaId: string): Promise<IgComment[]> {
  type Raw = IgComment & { replies?: { data: IgComment[] } };
  const top = await getAll<Raw>(`/${mediaId}/comments`, {
    fields: 'id,username,text,timestamp,replies{id,username,text,timestamp}',
    limit: '50',
  });
  return top.flatMap(({ replies, ...c }) => [c, ...(replies?.data ?? [])]);
}

/** Story mentions only include the sender's Instagram-scoped ID; this looks up their username. */
export async function getUsernameForSender(senderId: string): Promise<string> {
  const user = await graphGet<{ username: string }>(`/${senderId}`, { fields: 'username' });
  return user.username;
}

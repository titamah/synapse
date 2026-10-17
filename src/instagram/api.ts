import { env } from '../config/environment.js';

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

let cachedMediaId: string | null | undefined;

/**
 * The giveaway post's media ID. IG_GIVEAWAY_POST can be the media ID itself or
 * the post's link (instagram.com/p/...), which is looked up among BB's posts.
 */
export async function getGiveawayMediaId(): Promise<string | null> {
  if (cachedMediaId !== undefined) return cachedMediaId;
  const configured = env.IG_GIVEAWAY_POST?.trim();
  if (!configured) return (cachedMediaId = null);
  if (/^\d+$/.test(configured)) return (cachedMediaId = configured);

  const shortcode = configured.match(/instagram\.com\/(?:p|reel)\/([^/?#]+)/)?.[1];
  if (!shortcode) throw new Error(`IG_GIVEAWAY_POST isn't a media ID or post link: ${configured}`);
  const media = await getAll<{ id: string; permalink: string }>('/me/media', { fields: 'id,permalink', limit: '50' });
  const match = media.find(m => m.permalink.includes(`/${shortcode}`));
  if (!match) throw new Error(`Couldn't find the giveaway post (${shortcode}) on the account`);
  return (cachedMediaId = match.id);
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

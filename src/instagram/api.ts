import { getAccessToken } from './token.js';
import type { Giveaway } from '../giveaway/service.js';

const GRAPH = 'https://graph.instagram.com/v26.0';

export type IgComment = { id: string; username: string; text: string; timestamp: string; hidden?: boolean };

export type IgPost = {
  id: string;
  permalink: string;
  caption: string | null;
  mediaType: string;
  /** Image to show in the post picker (the cover frame for videos). Instagram's URLs expire after a while. */
  thumbnailUrl: string | null;
  postedAt: string;
  commentsCount: number;
};

async function graphGet<T>(pathOrUrl: string, params: Record<string, string> = {}): Promise<T> {
  const token = await getAccessToken();
  if (!token) throw new Error('IG_ACCESS_TOKEN is not set');
  const url = new URL(pathOrUrl.startsWith('http') ? pathOrUrl : `${GRAPH}${pathOrUrl}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  // Paging links already carry a token; always use the current one.
  url.searchParams.set('access_token', token);

  const res = await fetch(url);
  const body = (await res.json()) as T & { error?: { message: string } };
  if (!res.ok || body.error) throw new Error(`Instagram API ${res.status}: ${body.error?.message ?? 'unknown error'}`);
  return body;
}

type Page<T> = { data: T[]; paging?: { next?: string } };

/** Follows `paging.next` links until every item has been read (or `max` items). */
async function getAll<T>(path: string, params: Record<string, string>, max = Infinity): Promise<T[]> {
  const items: T[] = [];
  let page = await graphGet<Page<T>>(path, params);
  items.push(...page.data);
  while (page.paging?.next && items.length < max) {
    page = await graphGet<Page<T>>(page.paging.next);
    items.push(...page.data);
  }
  return items.slice(0, max);
}

export async function getAccount() {
  return graphGet<{ user_id: string; username: string }>('/me', { fields: 'user_id,username' });
}

// ---------------------------------------------------------------------------
// Posts

const POST_FIELDS = 'id,permalink,caption,media_type,media_url,thumbnail_url,timestamp,comments_count';
type RawPost = {
  id: string;
  permalink: string;
  caption?: string;
  media_type: string;
  media_url?: string;
  thumbnail_url?: string;
  timestamp: string;
  comments_count?: number;
};

function toPost(m: RawPost): IgPost {
  return {
    id: m.id,
    permalink: m.permalink,
    caption: m.caption ?? null,
    mediaType: m.media_type,
    thumbnailUrl: m.thumbnail_url ?? (m.media_type === 'VIDEO' ? null : (m.media_url ?? null)),
    postedAt: m.timestamp,
    commentsCount: m.comments_count ?? 0,
  };
}

/** @BostonBlerds' most recent posts, newest first. */
export async function listRecentPosts(limit = 12): Promise<IgPost[]> {
  const raw = await getAll<RawPost>('/me/media', { fields: POST_FIELDS, limit: String(Math.min(limit, 50)) }, limit);
  return raw.map(toPost);
}

/** The short code in an Instagram link, e.g. "DeU57Lun84l" from instagram.com/p/DeU57Lun84l/?igsh=… */
export function parseShortcode(link: string): string | null {
  return link.match(/instagram\.com\/(?:[\w.]+\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/)?.[1] ?? null;
}

/**
 * Finds one of @BostonBlerds' posts from a link or a media ID. Instagram can't look a post up
 * by its link, so this matches the link's short code against the account's posts (newest 200).
 */
export async function resolvePost(input: string): Promise<IgPost | null> {
  const value = input.trim();
  if (/^\d+$/.test(value)) {
    try {
      return toPost(await graphGet<RawPost>(`/${value}`, { fields: POST_FIELDS }));
    } catch {
      return null;
    }
  }
  const shortcode = parseShortcode(value);
  if (!shortcode) return null;
  const posts = await getAll<RawPost>('/me/media', { fields: POST_FIELDS, limit: '50' }, 200);
  const match = posts.find(m => parseShortcode(m.permalink) === shortcode);
  return match ? toPost(match) : null;
}

export type GiveawayPost = { id: string; postedAt: Date };

/** The giveaway's Instagram post, set from the dashboard (igPost). */
export function knownGiveawayPost(g: Giveaway): GiveawayPost | null {
  return g.igMediaId && g.igPostedAt ? { id: g.igMediaId, postedAt: g.igPostedAt } : null;
}

// ---------------------------------------------------------------------------
// Comments and users

type RawComment = {
  id: string;
  text?: string;
  timestamp: string;
  hidden?: boolean;
  username?: string;
  from?: { id: string; username?: string };
};

/**
 * Instagram puts the commenter under `from.username` (not `username`), and GIF or
 * sticker-only comments have no text. Returns null if there's no username at all.
 */
export function toComment(c: RawComment): IgComment | null {
  const username = c.from?.username ?? c.username;
  if (!username) return null;
  return { id: c.id, username, text: c.text ?? '', timestamp: c.timestamp, hidden: c.hidden ?? false };
}

/** Every comment and reply on a post, including whether it's hidden. */
export async function getAllComments(mediaId: string): Promise<IgComment[]> {
  type Raw = RawComment & { replies?: { data: RawComment[] } };
  const top = await getAll<Raw>(`/${mediaId}/comments`, {
    fields: 'id,text,timestamp,hidden,from,username,replies{id,text,timestamp,hidden,from,username}',
    limit: '50',
  });
  return top
    .flatMap(({ replies, ...c }) => [c, ...(replies?.data ?? [])])
    .map(toComment)
    .filter((c): c is IgComment => c !== null);
}

export type TaggedPost = { id: string; username: string; caption: string; permalink: string; timestamp: string };

/**
 * Other people's posts that tag @BostonBlerds, newest first, back to `since`.
 * Stops paging once posts are older than `since`.
 */
export async function getTaggedPosts(since: Date): Promise<TaggedPost[]> {
  type Raw = { id: string; username?: string; caption?: string; permalink: string; timestamp: string };
  const out: TaggedPost[] = [];
  let page = await graphGet<Page<Raw>>('/me/tags', { fields: 'id,username,caption,permalink,timestamp', limit: '50' });
  for (;;) {
    for (const p of page.data) {
      if (new Date(p.timestamp) < since) return out;
      if (p.username) out.push({ id: p.id, username: p.username, caption: p.caption ?? '', permalink: p.permalink, timestamp: p.timestamp });
    }
    if (!page.paging?.next) return out;
    page = await graphGet<Page<Raw>>(page.paging.next);
  }
}

/** Story mentions only include the sender's Instagram-scoped ID; this looks up their username. */
export async function getUsernameForSender(senderId: string): Promise<string> {
  const user = await graphGet<{ username: string }>(`/${senderId}`, { fields: 'username' });
  return user.username;
}

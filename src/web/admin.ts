import crypto from 'crypto';
import type { Client } from 'discord.js';
import express, { type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { eq, inArray } from 'drizzle-orm';
import { env } from '../config/environment.js';
import { db } from '../db/client.js';
import { ACTIONS, giveawayRules, giveaways, type FormField, type InstagramPost, type Platform, type PlatformSettings, type RuleOptions } from '../db/schema.js';
import { toCsv } from '../lib/csv.js';
import { channelName } from '../discord/channels.js';
import { listRecentPosts, parseShortcode, resolvePost, type IgPost } from '../instagram/api.js';
import { getSyncStatus, runCommentSync, runFinalSync } from '../instagram/sync.js';
import { renewTokenIfDue, tokenStatus } from '../instagram/token.js';
import { announceExtended } from '../giveaway/announcements.js';
import { resolveAnnouncements } from '../giveaway/announcementRules.js';
import type { EngineRule } from '../giveaway/engine.js';
import { describeRule, ruleLabel } from '../giveaway/labels.js';
import { deletesAt, saveStats } from '../giveaway/retention.js';
import { DEFAULT_WINNER_MESSAGE, openSlots } from '../giveaway/winnerRules.js';
import { confirmWinnerCheck, drawWinner, eligiblePool, listWinners, notifyWinner, resolveWinner, selectWinner } from '../giveaway/winners.js';
import {
  addOverride,
  audit,
  auditRows,
  closeGiveaway,
  computePeople,
  deleteGiveaway,
  discordChannel,
  findOverlap,
  giveawayPosts,
  getGiveaway,
  getRules,
  isInstagramField,
  readsInstagram,
  listGiveaways,
  participantCount,
  revokeOverride,
  setEntrantRevoked,
  slugify,
  statusOf,
  takesDiscordEntries,
  type Giveaway,
  type PersonReport,
} from '../giveaway/service.js';

// ---------------------------------------------------------------------------
// Validation (v2, plus the v1 fields the current dashboard still sends)

const isoDate = z.iso.datetime({ offset: true }).transform(s => new Date(s));

/**
 * Optional field that may be left out OR sent as null; null means "not set" (use the default
 * on create, leave unchanged on edit). For fields where null means "clear it", use .nullish().
 */
const unset = <T extends z.ZodType>(schema: T) => schema.nullish().transform(v => v ?? undefined);

const formFieldSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9_]{1,40}$/, 'lowercase letters, numbers and underscores'),
    label: z.string().min(1).max(45),
    // ig_username = v1 name for an Instagram account field
    type: z.enum(['account', 'short_text', 'long_text', 'select', 'ig_username']),
    required: unset(z.boolean()).transform(v => v ?? false),
    placeholder: unset(z.string().max(100)),
    options: unset(z.array(z.string().min(1).max(100)).max(25)).transform(v => (v?.length ? v : undefined)),
    platforms: unset(z.array(z.enum(['instagram'])).min(1)),
    locked: unset(z.boolean()),
  })
  .transform(f => (f.type === 'ig_username' ? { ...f, type: 'account' as const, platforms: ['instagram' as const] } : f))
  .refine(f => f.type !== 'select' || !!f.options?.length, { message: 'select fields need options' })
  .refine(f => f.type !== 'account' || !!f.platforms?.length, { message: 'account fields need platforms' });

const ALL_ACTIONS = [...ACTIONS.discord, ...ACTIONS.instagram] as const;
const ruleOptions = unset(
  z.object({
    requireTag: unset(z.boolean()),
    captionIncludes: unset(z.string().min(1).max(100)),
    // comment rules: the post whose comments count. A link (instagram.com/p/…, Reels too) or media ID;
    // also accepts the post object this API returns.
    post: unset(z.union([z.string().min(1).max(500), z.object({ id: z.string() }).passthrough().transform(p => p.id)])),
  }),
);

const ruleSchema = z.object({
  id: unset(z.number().int()),
  action: z.enum(ALL_ACTIONS),
  type: unset(z.enum(['required', 'bonus'])).transform(v => v ?? 'bonus'),
  weight: unset(z.number().int().min(1).max(1000)).transform(v => v ?? 1),
  min: unset(z.number().int().min(1).max(1000)).transform(v => v ?? 1),
  check: z.enum(['winners', 'everyone']).nullish(),
  maxCount: unset(z.number().int().min(1).max(1000)).transform(v => v ?? 1),
  windowStart: isoDate.nullish(),
  windowEnd: isoDate.nullish(),
  frequency: z.enum(['day', 'week']).nullish(),
  options: ruleOptions,
});
type RuleInput = z.infer<typeof ruleSchema>;

const platformSchema = z.discriminatedUnion('platform', [
  z.object({
    platform: z.literal('discord'),
    // Channel NAME; a leading # and capitals are fine ("#GTA-Giveaway" is saved as "gta-giveaway").
    settings: unset(z.object({ channel: z.string().max(100).nullish().transform(v => (typeof v === 'string' ? channelName(v) || null : v)) })),
    rules: z.array(ruleSchema).min(1, 'each platform needs at least one rule'),
  }),
  z.object({
    platform: z.literal('instagram'),
    // No writable settings: posts live on the comment rules. (sync, sent back, is ignored.)
    settings: unset(z.object({}).passthrough()),
    rules: z.array(ruleSchema).min(1, 'each platform needs at least one rule'),
  }),
]);
type PlatformInput = z.infer<typeof platformSchema>;

/** v1 rules (flat, Instagram only, ig_* names). */
const v1RuleSchema = z.object({
  id: unset(z.number().int()),
  action: z.enum(['ig_comment', 'ig_story', 'ig_tag']),
  maxCount: z.number().int().min(1).max(1000),
  windowStart: isoDate.nullish(),
  windowEnd: isoDate.nullish(),
  frequency: z.enum(['day', 'week']).nullish(),
  options: ruleOptions,
});

const giveawayFields = {
  name: z.string().min(1).max(80),
  startsAt: isoDate,
  endsAt: isoDate,
  baseWeight: unset(z.number().int().min(1).max(1000)),
  platforms: unset(z.array(platformSchema).min(1, 'pick at least one platform').max(2)),
  reminderText: z.string().max(500).nullish(),
  maxParticipants: z.number().int().min(1).nullish(),
  formFields: unset(z.array(formFieldSchema).max(5)),
  announcements: unset(
    z.object({
      enabled: unset(z.boolean()),
      started: unset(z.boolean()),
      closed: unset(z.boolean()),
      extended: unset(z.boolean()),
      milestones: unset(z.object({ enabled: z.boolean(), every: z.number().int().min(1).max(100_000) })),
      capacity: unset(z.object({ enabled: z.boolean(), percents: z.array(z.number().int().min(1).max(100)).max(10) })),
      countdown: unset(z.object({ enabled: z.boolean(), hours: z.array(z.number().positive().max(24 * 365)).max(10) })),
    }),
  ),
  testMode: unset(z.boolean()),
  winners: unset(
    z.object({
      count: unset(z.number().int().min(1).max(100)),
      select: unset(z.enum(['manual', 'auto'])),
      notify: unset(z.enum(['manual', 'auto'])),
      notifyDelayMinutes: unset(z.number().int().min(0).max(7 * 24 * 60)),
      message: z.string().max(1500).nullish(),
      claimHours: unset(z.number().int().min(1).max(720)),
    }).passthrough(), // read-only fields (defaultMessage, history) are ignored
  ),
  // ----- flat winner fields (v1 names; the grouped `winners` object wins when both are sent)
  winnerCount: unset(z.number().int().min(1).max(100)),
  winnerSelect: unset(z.enum(['manual', 'auto'])),
  winnerNotify: unset(z.enum(['manual', 'auto'])),
  notifyDelayMinutes: unset(z.number().int().min(0).max(7 * 24 * 60)),
  // DM text with {name}, {giveaway}, {deadline}. null = use the default message.
  winnerMessage: z.string().max(1500).nullish(),
  claimHours: unset(z.number().int().min(1).max(720)),
  // ----- v1 (deprecated, translated into platforms): kept so the current dashboard keeps working.
  entryMethods: unset(z.array(z.enum(['discord', 'instagram'])).min(1).max(2)),
  entryChannel: z.string().max(100).nullish().transform(v => (typeof v === 'string' ? channelName(v) || null : v)),
  igPost: z.string().min(1).max(500).nullish(),
  rules: unset(z.array(v1RuleSchema).max(20)),
};

const createSchema = z.object(giveawayFields);
const updateSchema = z.object(giveawayFields).partial();
type GiveawayInput = z.infer<typeof updateSchema>;

// ---------------------------------------------------------------------------
// v1 → v2 translation

/** Grouped `winners` settings → the flat columns (grouped wins over the flat v1 names). */
function winnerColumns(input: GiveawayInput) {
  const w = input.winners;
  const pick = <T>(grouped: T | undefined, flat: T | undefined) => (grouped !== undefined ? grouped : flat);
  return {
    winnerCount: pick(w?.count, input.winnerCount),
    winnerSelect: pick(w?.select, input.winnerSelect),
    winnerNotify: pick(w?.notify, input.winnerNotify),
    notifyDelayMinutes: pick(w?.notifyDelayMinutes, input.notifyDelayMinutes),
    winnerMessage: pick(w && 'message' in w ? w.message : undefined, input.winnerMessage),
    claimHours: pick(w?.claimHours, input.claimHours),
  };
}

const winnerJson = <W extends { entrantId: number | null }>(w: W) => ({ personId: w.entrantId, ...w });

const V1_ACTION = { ig_comment: 'comment', ig_story: 'story', ig_tag: 'tag' } as const;
const toV1Action = (a: string) => (({ comment: 'ig_comment', story: 'ig_story', tag: 'ig_tag' }) as Record<string, string>)[a] ?? a;

/** Current platforms of a saved giveaway, in input shape (for merging partial v1 edits). */
function currentPlatforms(g: Giveaway, rules: EngineRule[]): PlatformInput[] {
  const toInput = (r: EngineRule): RuleInput => ({ ...r, check: r.check ?? null, options: { requireTag: r.options.requireTag, captionIncludes: r.options.captionIncludes, post: r.options.post?.id } });
  const out: PlatformInput[] = [];
  const discord = rules.filter(r => r.platform === 'discord');
  if (discord.length) out.push({ platform: 'discord', settings: { channel: discordChannel(g) }, rules: discord.map(toInput) });
  const ig = rules.filter(r => r.platform === 'instagram');
  if (ig.length) out.push({ platform: 'instagram', settings: {}, rules: ig.map(toInput) });
  return out;
}

/**
 * Builds v2 platforms from v1 fields (entryMethods, entryChannel, igPost, flat rules), applied on
 * top of the giveaway's current platforms when editing. Returns undefined if no v1 field was sent.
 */
function platformsFromV1(input: GiveawayInput, current: PlatformInput[] | null): PlatformInput[] | undefined {
  const touched = input.entryMethods !== undefined || input.entryChannel !== undefined || input.igPost !== undefined || input.rules !== undefined;
  if (!touched) return undefined;

  const prevDiscord = current?.find(p => p.platform === 'discord') as Extract<PlatformInput, { platform: 'discord' }> | undefined;
  const prevIg = current?.find(p => p.platform === 'instagram') as Extract<PlatformInput, { platform: 'instagram' }> | undefined;
  const methods = input.entryMethods ?? (current ? [...(prevDiscord ? ['discord' as const] : []), ...(prevIg && !prevDiscord ? ['instagram' as const] : [])] : ['discord' as const]);
  const either = methods.includes('discord') && methods.includes('instagram');

  // v1 had one post for the whole giveaway: it goes on every comment rule.
  const prevPost = prevIg?.rules.find(r => r.action === 'comment' && r.options?.post)?.options?.post;
  const v1Post = input.igPost !== undefined ? (input.igPost ?? undefined) : prevPost;
  const igRules: RuleInput[] = (
    input.rules
      ? input.rules.map(r => ({ id: r.id, action: V1_ACTION[r.action], type: 'bonus' as const, weight: 1, min: 1, check: null, maxCount: r.maxCount, windowStart: r.windowStart, windowEnd: r.windowEnd, frequency: r.frequency, options: r.options }))
      : (prevIg?.rules ?? [])
  ).map(r => (r.action === 'comment' ? { ...r, options: { requireTag: r.options?.requireTag, captionIncludes: r.options?.captionIncludes, post: v1Post } } : r));
  if (!methods.includes('discord') && igRules.length && !igRules.some(r => r.type === 'required')) igRules[0] = { ...igRules[0]!, type: 'required' };

  const out: PlatformInput[] = [];
  if (methods.includes('discord')) {
    const discordRules: RuleInput[] =
      input.entryMethods || !prevDiscord
        ? [
            { id: undefined, action: 'enter', type: either ? 'bonus' : 'required', weight: 1, min: 1, check: null, maxCount: 1, options: undefined },
            ...(either ? [] : [{ id: undefined, action: 'member' as const, type: 'required' as const, weight: 1, min: 1, check: null, maxCount: 1, options: undefined }]),
          ]
        : prevDiscord.rules;
    out.push({ platform: 'discord', settings: { channel: input.entryChannel !== undefined ? input.entryChannel : (prevDiscord?.settings?.channel ?? null) }, rules: discordRules });
  }
  if (igRules.length) out.push({ platform: 'instagram', settings: {}, rules: igRules });
  return out;
}

// ---------------------------------------------------------------------------
// Checks that need the whole picture

type Checked = { error: string } | { formFields: FormField[] };

/**
 * Validates platforms, rules and dates, and returns the form with Synapse's required account
 * fields added and locked: when Discord "enter" is required and another platform is present,
 * the Discord form must collect that platform's username (it's how one person is linked).
 */
function crossCheck(merged: { startsAt: Date | null; endsAt: Date; platforms: PlatformInput[]; formFields: FormField[] }, requirePosts = true): Checked {
  if (!merged.startsAt || merged.endsAt <= merged.startsAt) return { error: 'endsAt must be after startsAt' };
  const seen = new Set<string>();
  for (const p of merged.platforms) {
    if (seen.has(p.platform)) return { error: `${p.platform} is listed twice` };
    seen.add(p.platform);
    for (const r of p.rules) {
      if (!(ACTIONS[p.platform] as readonly string[]).includes(r.action)) return { error: `"${r.action}" isn't a ${p.platform} action (use ${ACTIONS[p.platform].join(', ')})` };
      if (r.windowStart && r.windowEnd && r.windowEnd <= r.windowStart) return { error: 'rule windowEnd must be after windowStart' };
      if (r.check && r.action !== 'follow') return { error: '"check" only applies to manual actions (follow)' };
      if (r.options?.post && r.action !== 'comment') return { error: '"post" only applies to comment rules' };
      if (requirePosts && r.action === 'comment' && !r.options?.post) return { error: 'comment rules need a post (options.post: the post\'s link)' };
    }
  }
  const discord = merged.platforms.find(p => p.platform === 'discord');
  const entersOnDiscord = !!discord?.rules.some(r => r.action === 'enter');
  if (entersOnDiscord && !(discord as Extract<PlatformInput, { platform: 'discord' }>).settings?.channel) {
    return { error: 'Discord "enter" needs a channel (settings.channel)' };
  }

  let formFields = [...merged.formFields];
  const ids = formFields.map(f => f.id);
  if (new Set(ids).size !== ids.length) return { error: 'form field ids must be unique' };
  // Link people across platforms: Discord entry + Instagram needs the Instagram username in the form.
  const needsIg = entersOnDiscord && merged.platforms.some(p => p.platform === 'instagram');
  if (needsIg) {
    const existing = formFields.find(isInstagramField);
    if (existing) formFields = formFields.map(f => (f === existing ? { ...f, type: 'account', platforms: ['instagram'], required: true, locked: true } : f));
    else formFields = [{ id: 'ig', type: 'account', platforms: ['instagram'], label: 'Instagram username', required: true, locked: true }, ...formFields];
  }
  if (formFields.filter(isInstagramField).length > 1) return { error: 'only one Instagram username field allowed' };
  if (formFields.length > 5) return { error: 'Discord forms allow at most 5 fields (including the locked account field)' };
  return { formFields };
}

// ---------------------------------------------------------------------------
// Shapes returned to the dashboard (v2, plus v1 mirrors)

function platformsJson(g: Giveaway, rules: EngineRule[], sync: unknown) {
  return currentPlatforms(g, rules).map(p =>
    p.platform === 'instagram'
      ? { platform: p.platform, settings: { sync }, rules: rulesJson(rules, 'instagram') }
      : { platform: p.platform, settings: { channel: discordChannel(g) }, rules: rulesJson(rules, 'discord') },
  );
}

const rulesJson = (rules: EngineRule[], platform: Platform) =>
  rules.filter(r => r.platform === platform).map(r => ({ ...r, label: ruleLabel(r), description: describeRule(r) }));

async function giveawayJson(g: Giveaway, client?: Client) {
  const rules = await getRules(g.id);
  const people = await computePeople(g, client);
  const eligible = people.filter(p => p.result.eligible);
  const sync = await getSyncStatus(g.id);
  const firstPost = (await giveawayPosts(g)).sort((a, b) => a.postedAt.getTime() - b.postedAt.getTime())[0];
  return {
    id: g.id,
    name: g.name,
    slug: g.slug,
    status: statusOf(g),
    startsAt: g.startsAt,
    endsAt: g.endsAt,
    baseWeight: g.baseWeight,
    platforms: platformsJson(g, rules, sync),
    formFields: g.formFields,
    reminderText: g.reminderText,
    maxParticipants: g.maxParticipants,
    testMode: g.testMode,
    announcements: resolveAnnouncements(g.announcements),
    winners: {
      count: g.winnerCount,
      select: g.winnerSelect,
      notify: g.winnerNotify,
      notifyDelayMinutes: g.notifyDelayMinutes,
      message: g.winnerMessage,
      defaultMessage: DEFAULT_WINNER_MESSAGE,
      claimHours: g.claimHours,
      history: (await listWinners(g.id)).map(winnerJson),
    },
    closedAt: g.closedAt,
    closeReason: g.closeReason,
    entrantCount: people.filter(p => !p.revokedAt).length,
    eligibleCount: eligible.length,
    entryCount: eligible.reduce((s, p) => s + p.result.entries.total, 0),
    igSync: sync,
    // Snapshot of the numbers (kept after personal data is deleted). null until the giveaway closes.
    stats: g.stats,
    // People, activity and entries are deleted 90 days after the end; the dashboard shows
    // "removed per privacy policy" once personalDataDeletedAt is set.
    personalDataDeletesAt: statusOf(g) === 'closed' ? deletesAt(g) : null,
    personalDataDeletedAt: g.personalDataDeletedAt,
    createdAt: g.createdAt,
    updatedAt: g.updatedAt,
    // ----- v1 mirrors (deprecated): for dashboards not yet on v2.
    discordEntrantCount: await participantCount(g.id, rules),
    winnerCount: g.winnerCount,
    winnerSelect: g.winnerSelect,
    winnerNotify: g.winnerNotify,
    notifyDelayMinutes: g.notifyDelayMinutes,
    winnerMessage: g.winnerMessage,
    defaultWinnerMessage: DEFAULT_WINNER_MESSAGE,
    claimHours: g.claimHours,
    entryMethods: [...(takesDiscordEntries(rules) ? ['discord'] : []), ...(rules.some(r => r.platform === 'instagram' && r.type === 'required') && !takesDiscordEntries(rules) ? ['instagram'] : [])],
    entryChannel: discordChannel(g),
    igMediaId: firstPost?.id ?? null,
    igPermalink: firstPost?.permalink ?? null,
    igPostedAt: firstPost?.postedAt ?? null,
    rules: rules
      .filter(r => r.platform === 'instagram' && r.type === 'bonus' && r.action !== 'follow')
      .map(r => ({ ...r, action: toV1Action(r.action), description: describeRule(r) })),
  };
}

/** One person, v2 shape (GET /people). */
function personJson(p: PersonReport, rules: EngineRule[]) {
  const label = (id: number) => {
    const r = rules.find(x => x.id === id);
    return r ? ruleLabel(r) : `rule #${id}`;
  };
  const describe = (id: number) => {
    const r = rules.find(x => x.id === id);
    return r ? describeRule(r) : `rule #${id}`;
  };
  return {
    id: p.id,
    discord: p.discordId ? { id: p.discordId, username: p.discordUsername } : null,
    accounts: p.accounts,
    answers: p.answers,
    eligible: p.result.eligible,
    missing: p.result.missing.map(label),
    winnerChecks: p.result.winnerChecks.map(label),
    entries: p.result.entries,
    breakdown: p.result.breakdown.map(b => ({ ...b, label: label(b.ruleId), description: describe(b.ruleId) })),
    requirements: p.result.requirements.map(r => ({ ...r, label: label(r.ruleId) })),
    overrides: p.overrides.map(o => ({ id: o.id, kind: o.kind, ruleId: o.ruleId, label: o.label, weight: o.weight, reason: o.reason, by: o.createdBy, at: o.createdAt })),
    inServer: p.inServer,
    disqualified: p.revokedAt ? { reason: p.revokedReason, by: p.revokedBy, at: p.revokedAt } : null,
    activity: p.activities.map(a => ({ id: a.id, platform: a.platform, action: a.action, at: a.at, removed: a.removedAt ? a.removedReason ?? true : false })),
    createdAt: p.createdAt,
  };
}

/** Looks up the post for an Instagram link or ID. Returns the post, or an HTTP error to send back. */
async function lookupIgPost(value: string): Promise<{ post: IgPost; error?: undefined } | { post?: undefined; error: { status: number; message: string } }> {
  try {
    const post = await resolvePost(value);
    if (!post) return { error: { status: 400, message: `Couldn't find that post on @BostonBlerds. Paste the post's link (instagram.com/p/…).` } };
    return { post };
  } catch (err) {
    return { error: { status: 502, message: `Instagram didn't respond: ${(err as Error).message}` } };
  }
}

/** Same post? Matches a media ID, or a link by its short code (so share junk like ?igsh= doesn't matter). */
const samePost = (p: InstagramPost, ref: string) => p.id === ref || p.permalink === ref || (!!parseShortcode(ref) && parseShortcode(ref) === parseShortcode(p.permalink));

/**
 * Resolves the posts on comment rules (links or media IDs) to stored posts. Reuses ones already
 * saved, so unchanged posts need no API call. Returns the posts, and the platforms with each rule's
 * post as its media ID.
 */
async function resolvePosts(platforms: PlatformInput[], existing: InstagramPost[]) {
  const ig = platforms.find(p => p.platform === 'instagram');
  if (!ig) return { posts: [] as InstagramPost[], platforms };
  const out: InstagramPost[] = [];
  for (const ref of ig.rules.flatMap(r => (r.options?.post ? [r.options.post] : []))) {
    if (out.some(p => samePost(p, ref))) continue;
    const known = existing.find(p => samePost(p, ref));
    if (known) {
      out.push(known);
      continue;
    }
    const found = await lookupIgPost(ref);
    if (found.error) return { error: found.error };
    if (!out.some(p => p.id === found.post.id)) out.push({ id: found.post.id, permalink: found.post.permalink, postedAt: found.post.postedAt });
  }
  const rules = ig.rules.map(r => (r.options?.post ? { ...r, options: { ...r.options, post: out.find(p => samePost(p, r.options!.post!))!.id } } : r));
  return { posts: out, platforms: platforms.map(p => (p === ig ? ({ ...ig, rules } as PlatformInput) : p)) };
}

function settingsFrom(platforms: PlatformInput[]): PlatformSettings {
  const discord = platforms.find(p => p.platform === 'discord') as Extract<PlatformInput, { platform: 'discord' }> | undefined;
  return {
    ...(discord ? { discord: { channel: discord.settings?.channel ?? null } } : {}),
    ...(platforms.some(p => p.platform === 'instagram') ? { instagram: {} } : {}),
  };
}

/** Rules as stored. `posts` are the resolved posts, so each comment rule stores its post's link and date. */
const ruleRows = (platforms: PlatformInput[], posts: InstagramPost[]) =>
  platforms.flatMap(p =>
    p.rules.map(r => ({
      id: r.id,
      platform: p.platform,
      action: r.action,
      type: r.type,
      weight: r.weight,
      min: r.min,
      check: r.action === 'follow' ? (r.check ?? 'winners') : null,
      maxCount: r.type === 'required' ? 1 : r.maxCount,
      windowStart: r.windowStart ?? null,
      windowEnd: r.windowEnd ?? null,
      frequency: r.type === 'required' ? null : (r.frequency ?? null),
      options: (() => {
        const { post, ...rest } = r.options ?? {};
        const stored = post ? posts.find(x => x.id === post) : undefined;
        return { ...rest, ...(stored ? { post: stored } : {}) } as RuleOptions;
      })(),
    })),
  );

/** Runs in the background so the dashboard gets its response right away. */
const inBackground = (task: Promise<unknown>) => void task.catch(err => console.error('Background task failed:', err));

// ---------------------------------------------------------------------------
// Router

type Req = Request & { actor?: string; giveaway?: Giveaway };

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Who's acting: the dashboard sends the signed-in admin's email in X-Admin-User. */
function requireActor(req: Req, res: Response, next: NextFunction) {
  const actor = req.get('x-admin-user')?.trim();
  if (!actor) return void res.status(400).json({ error: 'X-Admin-User header (the admin email) is required for changes' });
  req.actor = `admin:${actor}`;
  next();
}

export function createAdminRouter(client?: Client) {
  const router = express.Router();
  router.use(express.json({ limit: '200kb' }));

  // Only the admin dashboard has this key. It never reaches a browser.
  router.use((req, res, next) => {
    if (!env.ADMIN_API_KEY) return void res.status(503).json({ error: 'Admin API is not configured' });
    const token = req.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
    if (!safeEqual(token, env.ADMIN_API_KEY)) return void res.status(401).json({ error: 'Unauthorized' });
    next();
  });

  // Loads :id for every route that has it.
  router.param('id', async (req: Req, res, next, id) => {
    const g = /^\d+$/.test(id) ? await getGiveaway(Number(id)) : undefined;
    if (!g) return void res.status(404).json({ error: 'Giveaway not found' });
    req.giveaway = g;
    next();
  });

  router.get('/giveaways', async (_req, res) => {
    const all = await listGiveaways();
    res.json(await Promise.all(all.map(g => giveawayJson(g, client))));
  });

  router.post('/giveaways', requireActor, async (req: Req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: z.prettifyError(parsed.error) });
    const input = parsed.data;
    let platforms = input.platforms ?? platformsFromV1(input, null) ?? [];
    if (!platforms.length) return void res.status(400).json({ error: 'pick at least one platform (platforms)' });
    const checked = crossCheck({ startsAt: input.startsAt, endsAt: input.endsAt, platforms, formFields: input.formFields ?? [] });
    if ('error' in checked) return void res.status(400).json({ error: checked.error });

    const overlap = await findOverlap(input.startsAt, input.endsAt);
    if (overlap) return void res.status(409).json({ error: `Overlaps with "${overlap.name}". Only one giveaway can run at a time.` });

    const resolved = await resolvePosts(platforms, []);
    if ('error' in resolved) return void res.status(resolved.error!.status).json({ error: resolved.error!.message });
    platforms = resolved.platforms;

    const wc = winnerColumns(input);
    let slug = slugify(input.name) || 'giveaway';
    for (let n = 2; await db.query.giveaways.findFirst({ where: eq(giveaways.slug, slug) }); n++) slug = `${slugify(input.name)}-${n}`;

    const g = await db.transaction(async tx => {
      const [created] = await tx
        .insert(giveaways)
        .values({
          slug,
          name: input.name,
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          baseWeight: input.baseWeight ?? 1,
          platformSettings: settingsFrom(platforms),
          formFields: checked.formFields,
          reminderText: input.reminderText ?? null,
          maxParticipants: input.maxParticipants ?? null,
          ...(input.announcements ? { announcements: input.announcements } : {}),
          testMode: input.testMode ?? false,
          winnerCount: wc.winnerCount ?? 1,
          winnerSelect: wc.winnerSelect ?? 'manual',
          winnerNotify: wc.winnerNotify ?? 'manual',
          notifyDelayMinutes: wc.notifyDelayMinutes ?? 30,
          winnerMessage: wc.winnerMessage ?? null,
          claimHours: wc.claimHours ?? 12,
        })
        .returning();
      await tx.insert(giveawayRules).values(ruleRows(platforms, resolved.posts).map(({ id: _id, ...r }, i) => ({ ...r, giveawayId: created!.id, position: i + 1 })));
      return created!;
    });
    await audit(g.id, req.actor!, 'giveaway.created', { name: g.name, platforms: platforms.map(p => p.platform) });
    if (resolved.posts.length) inBackground(runCommentSync(g, 'post-set'));
    res.status(201).json(await giveawayJson(g, client));
  });

  router.get('/giveaways/:id', async (req: Req, res) => {
    res.json(await giveawayJson(req.giveaway!, client));
  });

  /** Shared by PATCH and the dry run: validates an edit and returns what would be saved. */
  async function prepareEdit(g: Giveaway, body: unknown) {
    const parsed = updateSchema.safeParse(body);
    if (!parsed.success) return { ok: false, status: 400, error: z.prettifyError(parsed.error) } as const;
    const input = parsed.data;
    const currentRules = await getRules(g.id);
    const current = currentPlatforms(g, currentRules);
    const platforms = input.platforms ?? platformsFromV1(input, current) ?? current;
    const merged = {
      startsAt: input.startsAt ?? g.startsAt,
      endsAt: input.endsAt ?? g.endsAt,
      platforms,
      formFields: input.formFields ?? g.formFields,
    };
    // Posts are required on comment rules the request sends; rules saved before (v1) are left alone.
    const checked = crossCheck(merged, !!input.platforms);
    if ('error' in checked) return { ok: false, status: 400, error: checked.error } as const;
    const ruleIds = platforms.flatMap(p => p.rules).filter(r => r.id).map(r => r.id!);
    if (ruleIds.some(id => !currentRules.some(c => c.id === id))) return { ok: false, status: 400, error: 'A rule id does not belong to this giveaway' } as const;
    const saved = (await giveawayPosts(g)).map(p => ({ ...p, postedAt: p.postedAt.toISOString() }));
    const resolved = await resolvePosts(platforms, saved);
    if ('error' in resolved) return { ok: false, status: resolved.error!.status, error: resolved.error!.message } as const;
    return { ok: true, input, platforms: resolved.platforms, posts: resolved.posts, saved, merged, formFields: checked.formFields, currentRules } as const;
  }

  router.patch('/giveaways/:id', requireActor, async (req: Req, res) => {
    const g = req.giveaway!;
    const prep = await prepareEdit(g, req.body);
    if (!prep.ok) return void res.status(prep.status).json({ error: prep.error });
    const { input, platforms, posts, saved, merged, formFields, currentRules } = prep;

    if ((input.startsAt || input.endsAt) && !g.closedAt) {
      const overlap = await findOverlap(merged.startsAt!, merged.endsAt, g.id);
      if (overlap) return void res.status(409).json({ error: `Overlaps with "${overlap.name}". Only one giveaway can run at a time.` });
    }

    const newPost = posts.some(p => !saved.some(o => o.id === p.id));

    const { platforms: _p, entryMethods: _m, entryChannel: _c, igPost: _i, rules: _r, formFields: _f, winners: _w, ...rest } = input;
    const settings = { ...rest, ...winnerColumns(input) };
    await db.transaction(async tx => {
      const changes = Object.fromEntries(Object.entries(settings).filter(([, v]) => v !== undefined));
      await tx
        .update(giveaways)
        .set({ ...changes, formFields, platformSettings: settingsFrom(platforms), updatedAt: new Date() })
        .where(eq(giveaways.id, g.id));

      // Rules are replaced by the list sent: matched by id, new ones added, missing ones removed.
      // Activity is never deleted, so a removed rule just stops counting (and can come back).
      const rows = ruleRows(platforms, posts);
      const keep = rows.filter(r => r.id).map(r => r.id!);
      const removed = currentRules.filter(c => !keep.includes(c.id)).map(c => c.id);
      if (removed.length) await tx.delete(giveawayRules).where(inArray(giveawayRules.id, removed));
      for (const [i, { id, ...r }] of rows.entries()) {
        if (id) await tx.update(giveawayRules).set({ ...r, position: i + 1 }).where(eq(giveawayRules.id, id));
        else await tx.insert(giveawayRules).values({ ...r, position: i + 1, giveawayId: g.id });
      }
    });
    await audit(g.id, req.actor!, 'giveaway.updated', { fields: Object.keys(req.body ?? {}) });
    const updated = (await getGiveaway(g.id))!;
    // Later end time or a bigger cap: tell #community-updates.
    const extended: { endsAt?: Date; maxParticipants?: number } = {};
    if (updated.endsAt > g.endsAt) extended.endsAt = updated.endsAt;
    if (updated.maxParticipants && (!g.maxParticipants || updated.maxParticipants > g.maxParticipants)) extended.maxParticipants = updated.maxParticipants;
    if (Object.keys(extended).length && statusOf(updated) !== 'closed') inBackground(announceExtended(client, updated, extended));
    // A new post: read its comments now instead of waiting for the next scheduled read.
    if (newPost) inBackground(runCommentSync(updated, 'post-set'));
    res.json(await giveawayJson(updated, client));
  });

  // Dry run: what an edit would do to eligibility and entries, without saving anything.
  router.post('/giveaways/:id/preview', async (req: Req, res) => {
    const g = req.giveaway!;
    const prep = await prepareEdit(g, req.body);
    if (!prep.ok) return void res.status(prep.status).json({ error: prep.error });
    let tempId = -1;
    const proposed: EngineRule[] = ruleRows(prep.platforms, prep.posts).map((r, i) => ({ ...r, id: r.id ?? tempId--, position: i + 1 }));
    const previewG = { ...g, baseWeight: prep.input.baseWeight ?? g.baseWeight, startsAt: prep.merged.startsAt, endsAt: prep.merged.endsAt };
    const before = await computePeople(g, client);
    const after = await computePeople(previewG, client, proposed);
    const byId = new Map(after.map(p => [p.id, p]));
    const changed = before
      .map(b => ({ b, a: byId.get(b.id)! }))
      .filter(({ a, b }) => a.result.eligible !== b.result.eligible || a.result.entries.total !== b.result.entries.total)
      .map(({ a, b }) => ({
        personId: b.id,
        discord: b.discordUsername,
        instagram: b.igUsername,
        before: { eligible: b.result.eligible, entries: b.result.entries.total },
        after: { eligible: a.result.eligible, entries: a.result.entries.total },
      }));
    res.json({
      becomeEligible: changed.filter(c => !c.before.eligible && c.after.eligible).length,
      becomeIneligible: changed.filter(c => c.before.eligible && !c.after.eligible).length,
      entriesBefore: before.reduce((s, p) => s + p.result.entries.total, 0),
      entriesAfter: after.reduce((s, p) => s + p.result.entries.total, 0),
      changed,
    });
  });

  router.post('/giveaways/:id/close', requireActor, async (req: Req, res) => {
    const closed = await closeGiveaway(req.giveaway!.id, req.actor!, 'early');
    if (!closed) return void res.status(409).json({ error: 'Already closed' });
    inBackground(runFinalSync(closed).then(() => saveStats(closed)));
    res.json(await giveawayJson(closed, client));
  });

  // Permanent delete. Open giveaways must be closed first; needs ?confirm=<giveaway name> unless in test mode.
  router.delete('/giveaways/:id', requireActor, async (req: Req, res) => {
    const g = req.giveaway!;
    if (statusOf(g) === 'open') return void res.status(409).json({ error: 'Close this giveaway before deleting it.' });
    const everyone = (await computePeople(g)).length;
    const confirm = typeof req.query.confirm === 'string' ? req.query.confirm.trim() : '';
    if (!g.testMode && confirm !== (g.name ?? g.slug)) {
      return void res.status(400).json({
        error: `To permanently delete this giveaway${everyone ? ` and its ${everyone} ${everyone === 1 ? 'person' : 'people'}` : ''}, add ?confirm=<giveaway name> (exactly "${g.name ?? g.slug}").`,
        requiresConfirm: true,
        entrants: everyone,
      });
    }
    const result = await deleteGiveaway(g, req.actor!);
    res.json({ deleted: true, id: g.id, name: g.name, entrants: result.entrants });
  });

  // "Sync now": read the posts' comments and tagged posts immediately and return the result.
  router.post('/giveaways/:id/sync', requireActor, async (req: Req, res) => {
    const g = req.giveaway!;
    if (!(await readsInstagram(g))) {
      return void res.status(400).json({ error: 'Add a comment rule with a post, or a tagged-post rule, first' });
    }
    await runCommentSync(g, 'manual');
    res.json({ igSync: await getSyncStatus(g.id) });
  });

  // ----- Instagram

  router.get('/instagram/status', async (_req, res) => {
    res.json(await tokenStatus());
  });

  router.post('/instagram/renew', requireActor, async (_req, res) => {
    await renewTokenIfDue(true);
    res.json(await tokenStatus());
  });

  router.get('/instagram/posts', async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 12, 1), 50);
    try {
      res.json(await listRecentPosts(limit));
    } catch (err) {
      res.status(502).json({ error: `Instagram didn't respond: ${(err as Error).message}` });
    }
  });

  router.get('/instagram/resolve', async (req, res) => {
    const url = typeof req.query.url === 'string' ? req.query.url : '';
    if (!url) return void res.status(400).json({ error: 'Pass ?url=<Instagram post link or media ID>' });
    const found = await lookupIgPost(url);
    if (found.error) return void res.status(found.error.status === 400 ? 404 : found.error.status).json({ error: found.error.message });
    res.json(found.post);
  });

  // ----- People

  // v2: everyone with activity, with eligibility, what's missing, entries and a breakdown.
  router.get('/giveaways/:id/people', async (req: Req, res) => {
    const g = req.giveaway!;
    const rules = await getRules(g.id);
    res.json((await computePeople(g, client)).map(p => personJson(p, rules)));
  });

  // v1 shape (deprecated): entrants + "unmatched" (people active on Instagram who haven't entered on Discord).
  router.get('/giveaways/:id/entrants', async (req: Req, res) => {
    const g = req.giveaway!;
    const rules = await getRules(g.id);
    const people = await computePeople(g, client);
    const discordEntry = takesDiscordEntries(rules);
    const asV1 = (p: PersonReport) => ({
      ...p,
      totalEntries: p.result.entries.total,
      eligible: p.result.eligible,
      bonuses: p.result.breakdown.flatMap(b => {
        const r = rules.find(x => x.id === b.ruleId)!;
        return Array.from({ length: b.count }, () => ({ ruleId: b.ruleId, action: toV1Action(r.action), label: null, weight: b.weight }));
      }),
      activities: undefined,
      result: undefined,
    });
    res.json({
      entrants: people.filter(p => !discordEntry || p.discordId).map(asV1),
      unmatched: people.filter(p => discordEntry && !p.discordId).map(asV1),
    });
  });

  router.post('/giveaways/:id/people/:entrantId/disqualify', requireActor, disqualify);
  router.post('/giveaways/:id/entrants/:entrantId/disqualify', requireActor, disqualify);
  async function disqualify(req: Req, res: Response) {
    const body = z.object({ reason: z.string().min(1).max(200) }).safeParse(req.body);
    if (!body.success) return void res.status(400).json({ error: 'A reason is required' });
    const e = await setEntrantRevoked(req.giveaway!.id, Number(req.params.entrantId), req.actor!, body.data.reason);
    if (!e) return void res.status(404).json({ error: 'Person not found' });
    res.json(e);
  }

  router.post('/giveaways/:id/people/:entrantId/restore', requireActor, restore);
  router.post('/giveaways/:id/entrants/:entrantId/restore', requireActor, restore);
  async function restore(req: Req, res: Response) {
    const e = await setEntrantRevoked(req.giveaway!.id, Number(req.params.entrantId), req.actor!, null);
    if (!e) return void res.status(404).json({ error: 'Person not found' });
    res.json(e);
  }

  // Overrides: count a requirement as met (grandfathering / confirming a manual check), or a manual entry.
  router.post('/giveaways/:id/people/:entrantId/overrides', requireActor, async (req: Req, res) => {
    const g = req.giveaway!;
    const body = z
      .discriminatedUnion('kind', [
        z.object({ kind: z.literal('requirement_met'), ruleId: z.number().int(), reason: unset(z.string().max(200)) }),
        z.object({ kind: z.literal('manual_entry'), label: z.string().min(1).max(100), weight: unset(z.number().int().min(1).max(1000)).transform(v => v ?? 1), reason: unset(z.string().max(200)) }),
      ])
      .safeParse(req.body);
    if (!body.success) return void res.status(400).json({ error: z.prettifyError(body.error) });
    if (body.data.kind === 'requirement_met') {
      const rule = (await getRules(g.id)).find(r => r.id === (body.data as { ruleId: number }).ruleId);
      if (!rule || rule.type !== 'required') return void res.status(400).json({ error: 'ruleId must be one of this giveaway\'s required rules' });
    }
    const row = await addOverride(g.id, Number(req.params.entrantId), body.data as Parameters<typeof addOverride>[2], req.actor!);
    if (!row) return void res.status(404).json({ error: 'Person not found' });
    res.status(201).json(row);
  });

  router.delete('/giveaways/:id/overrides/:overrideId', requireActor, async (req: Req, res) => {
    const row = await revokeOverride(req.giveaway!.id, Number(req.params.overrideId), req.actor!);
    if (!row) return void res.status(404).json({ error: 'Override not found or already removed' });
    res.json(row);
  });

  // v1 manual bonuses (deprecated) = manual-entry overrides.
  router.post('/giveaways/:id/bonuses', requireActor, async (req: Req, res) => {
    const body = z.object({ entrantId: z.number().int(), label: z.string().min(1).max(100) }).safeParse(req.body);
    if (!body.success) return void res.status(400).json({ error: z.prettifyError(body.error) });
    const row = await addOverride(req.giveaway!.id, body.data.entrantId, { kind: 'manual_entry', label: body.data.label, weight: 1 }, req.actor!);
    if (!row) return void res.status(404).json({ error: 'Entrant not found' });
    res.status(201).json(row);
  });
  router.delete('/giveaways/:id/bonuses/:bonusId', requireActor, async (req: Req, res) => {
    const row = await revokeOverride(req.giveaway!.id, Number(req.params.bonusId), req.actor!);
    if (!row) return void res.status(404).json({ error: 'Bonus not found or already removed' });
    res.json(row);
  });

  // ----- Winners

  router.get('/giveaways/:id/winners', async (req: Req, res) => {
    const g = req.giveaway!;
    const people = await computePeople(g, client);
    const byId = new Map(people.map(p => [p.id, p]));
    res.json(
      (await listWinners(g.id)).map(w => {
        const p = w.entrantId ? byId.get(w.entrantId) : undefined;
        // After personal data is deleted, `person` (who won) is all that's left; null once anonymized.
        return { ...winnerJson(w), entrant: p ? { ...p, activities: undefined } : null };
      }),
    );
  });

  /** Checks shared by picking and drawing: the giveaway is closed and a winner slot is open. */
  async function canSelect(g: Giveaway) {
    if (statusOf(g) !== 'closed') return 'Winners can be picked once the giveaway is closed.';
    if (!openSlots(g.winnerCount, (await listWinners(g.id)).map(w => w.status))) return `All ${g.winnerCount} winner slot(s) are filled. Resolve a winner first, or raise winnerCount.`;
    return null;
  }

  async function pickWinner(req: Req, res: Response, v1 = false) {
    const g = req.giveaway!;
    const body = z.object({ entrantId: unset(z.number().int()), personId: unset(z.number().int()) }).safeParse(req.body);
    const id = body.success ? (body.data.personId ?? body.data.entrantId) : undefined;
    if (!id) return void res.status(400).json({ error: 'personId is required' });
    const problem = await canSelect(g);
    if (problem) return void res.status(409).json({ error: problem });
    const pick = (await eligiblePool(g, client)).find(p => p.person.id === id);
    if (!pick) return void res.status(400).json({ error: "That person can't win: not eligible, disqualified, or already picked." });
    const w = await selectWinner(client, g, pick.person, req.actor!);
    if (!w) return void res.status(409).json({ error: 'That person was just picked.' });
    if (v1) return void res.json({ winner: { ...pick.person, activities: undefined }, record: w });
    res.status(201).json(winnerJson(w));
  }
  // Deprecated alias for older dashboard code.
  router.post('/giveaways/:id/winner', requireActor, (req: Req, res) => pickWinner(req, res, true));
  router.post('/giveaways/:id/winners', requireActor, (req: Req, res) => pickWinner(req, res));

  router.post('/giveaways/:id/winners/draw', requireActor, async (req: Req, res) => {
    const g = req.giveaway!;
    const problem = await canSelect(g);
    if (problem) return void res.status(409).json({ error: problem });
    const w = await drawWinner(client, g, req.actor!);
    if (!w) return void res.status(409).json({ error: 'No eligible people left to draw.' });
    res.status(201).json(winnerJson(w));
  });

  // Winner checks (e.g. "follows @BostonBlerds"): confirm or reject one.
  router.post('/giveaways/:id/winners/:winnerId/checks/:ruleId', requireActor, async (req: Req, res) => {
    const body = z.object({ confirmed: z.boolean() }).safeParse(req.body);
    if (!body.success) return void res.status(400).json({ error: 'confirmed (true/false) is required' });
    const w = (await listWinners(req.giveaway!.id)).find(x => x.id === Number(req.params.winnerId));
    if (!w) return void res.status(404).json({ error: 'Winner not found' });
    const result = await confirmWinnerCheck(client, w.id, Number(req.params.ruleId), body.data.confirmed, req.actor!);
    if (!result.ok) return void res.status(409).json({ error: result.error });
    res.json(result.winner);
  });

  router.post('/giveaways/:id/winners/:winnerId/notify', requireActor, async (req: Req, res) => {
    if (!client?.isReady()) return void res.status(503).json({ error: 'The bot is not connected to Discord right now.' });
    const w = (await listWinners(req.giveaway!.id)).find(x => x.id === Number(req.params.winnerId));
    if (!w) return void res.status(404).json({ error: 'Winner not found' });
    const result = await notifyWinner(client, w.id, req.actor!);
    if (!result.ok) return void res.status(409).json({ error: result.error });
    res.json({ notified: true });
  });

  router.post('/giveaways/:id/winners/:winnerId/outcome', requireActor, async (req: Req, res) => {
    const body = z.object({ outcome: z.enum(['accepted', 'declined']) }).safeParse(req.body);
    if (!body.success) return void res.status(400).json({ error: 'outcome must be "accepted" or "declined"' });
    const w = (await listWinners(req.giveaway!.id)).find(x => x.id === Number(req.params.winnerId));
    if (!w) return void res.status(404).json({ error: 'Winner not found' });
    const result = await resolveWinner(client, w.id, body.data.outcome, req.actor!);
    if (!result.ok) return void res.status(409).json({ error: result.error });
    res.json(result.winner);
  });

  router.get('/giveaways/:id/audit', async (req: Req, res) => {
    res.json(await auditRows(req.giveaway!.id));
  });

  // ----- Exports (eligibility and entries are calculated here, same as the dashboard and draws)

  router.get('/giveaways/:id/export/:file', async (req: Req, res) => {
    const g = req.giveaway!;
    const file = req.params.file as string;
    const base = (g.name ?? g.slug).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const send = (suffix: string, csv: string) => res.type('text/csv').attachment(`${base}-${suffix}.csv`).send(csv);

    if (file === 'audit.csv') {
      const rows = await auditRows(g.id, 100_000);
      return void send('audit', toCsv(['when', 'who', 'action', 'details'], rows.map(a => [a.createdAt, a.actorId, a.action, JSON.stringify(a.details)])));
    }

    const rules = await getRules(g.id);
    const people = await computePeople(g, client);
    const label = (id: number) => {
      const r = rules.find(x => x.id === id);
      return r ? describeRule(r) : `rule #${id}`;
    };

    if (file === 'entries.csv') {
      // One row per entry (weights expanded), eligible people only: what a random picker loads.
      const rows = people
        .filter(p => p.result.eligible)
        .flatMap(p => {
          const who = [p.discordUsername, p.discordId, p.igUsername];
          return [
            ...Array.from({ length: p.result.entries.base }, () => [...who, 'Base entry']),
            ...p.result.breakdown.flatMap(b => Array.from({ length: b.entries }, () => [...who, label(b.ruleId)])),
            ...p.overrides.filter(o => o.kind === 'manual_entry').flatMap(o => Array.from({ length: o.weight }, () => [...who, `Manual: ${o.label ?? ''}`])),
          ];
        });
      return void send('entries', toCsv(['discord_username', 'discord_id', 'ig_username', 'entry_source'], rows));
    }

    if (file === 'entrants.csv') {
      const fields = g.formFields.filter(f => !isInstagramField(f));
      const bonusRules = rules.filter(r => r.type === 'bonus');
      const headers = [
        'discord_username', 'discord_id', 'ig_username',
        ...fields.map(f => f.label),
        'eligible', 'missing',
        ...bonusRules.map(r => `${describeRule(r)} (count)`),
        'manual_entries', 'base_entries', 'bonus_entries', 'total_entries',
        'in_server', 'disqualified_reason', 'first_seen',
      ];
      const rows = people.map(p => [
        p.discordUsername, p.discordId, p.igUsername,
        ...fields.map(f => p.answers[f.id] ?? ''),
        p.result.eligible, p.result.missing.map(id => ruleLabel(rules.find(r => r.id === id) ?? { platform: 'discord', action: 'enter', options: {} })).join('; '),
        ...bonusRules.map(r => p.result.breakdown.find(b => b.ruleId === r.id)?.count ?? 0),
        p.result.entries.manual, p.result.entries.base, p.result.entries.bonus, p.result.entries.total,
        p.inServer ?? '', p.revokedReason ?? '', p.createdAt,
      ]);
      return void send('entrants', toCsv(headers, rows));
    }

    if (file === 'activity.csv') {
      const rows = people.flatMap(p =>
        p.activities.map(a => [a.at, a.platform, a.action, p.discordUsername, p.igUsername, a.sourceRef, a.removedAt ? a.removedReason ?? 'removed' : '', JSON.stringify(a.details)]),
      );
      return void send('activity', toCsv(['when', 'platform', 'action', 'discord_username', 'ig_username', 'source_id', 'removed', 'details'], rows));
    }

    res.status(404).json({ error: 'Unknown export. Use entries.csv, entrants.csv, activity.csv or audit.csv' });
  });

  return router;
}

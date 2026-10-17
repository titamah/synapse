import crypto from 'crypto';
import type { Client } from 'discord.js';
import express, { type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { eq, inArray } from 'drizzle-orm';
import { env } from '../config/environment.js';
import { db } from '../db/client.js';
import { giveawayRules, giveaways } from '../db/schema.js';
import { toCsv } from '../lib/csv.js';
import { serverMemberIds } from '../discord/members.js';
import { listRecentPosts, resolvePost } from '../instagram/api.js';
import { getSyncStatus, runCommentSync, runFinalSync } from '../instagram/sync.js';
import { announceExtended } from '../giveaway/announcements.js';
import { DEFAULT_WINNER_MESSAGE, openSlots } from '../giveaway/winnerRules.js';
import { drawWinner, eligiblePool, listWinners, notifyWinner, resolveWinner, selectWinner } from '../giveaway/winners.js';
import { resolveAnnouncements } from '../giveaway/announcementRules.js';
import type { Rule } from '../giveaway/rules.js';
import {
  addManualBonus,
  audit,
  auditRows,
  closeGiveaway,
  deleteGiveaway,
  entrantCount,
  entrantReport,
  findOverlap,
  getGiveaway,
  getRules,
  listGiveaways,
  revokeBonus,
  setEntrantRevoked,
  slugify,
  statusOf,
  type Giveaway,
} from '../giveaway/service.js';

// ---------------------------------------------------------------------------
// Validation

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
    type: z.enum(['ig_username', 'short_text', 'long_text', 'select']),
    required: unset(z.boolean()).transform(v => v ?? false),
    placeholder: unset(z.string().max(100)),
    options: unset(z.array(z.string().min(1).max(100)).max(25)).transform(v => (v?.length ? v : undefined)),
  })
  .refine(f => f.type !== 'select' || !!f.options?.length, { message: 'select fields need options' });

const ruleSchema = z.object({
  id: unset(z.number().int()),
  action: z.enum(['ig_comment', 'ig_story']),
  maxCount: z.number().int().min(1).max(1000),
  // null = no window / no frequency
  windowStart: isoDate.nullish(),
  windowEnd: isoDate.nullish(),
  frequency: z.enum(['day', 'week']).nullish(),
  options: unset(z.object({ requireTag: unset(z.boolean()) })),
});

const giveawayFields = {
  name: z.string().min(1).max(80),
  startsAt: isoDate,
  endsAt: isoDate,
  // null = clear the setting
  entryChannel: z.string().max(100).nullish(),
  // The giveaway's Instagram post: a link (instagram.com/p/…) or media ID. Can be set any time,
  // even after the giveaway starts; comments are counted from startsAt. null = clear.
  igPost: z.string().min(1).max(500).nullish(),
  reminderText: z.string().max(500).nullish(),
  maxParticipants: z.number().int().min(1).nullish(),
  // null = not set
  formFields: unset(z.array(formFieldSchema).max(5)),
  rules: unset(z.array(ruleSchema).max(20)),
  // Discord updates in #community-updates. Anything left out uses the defaults.
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
  // Winners
  winnerCount: unset(z.number().int().min(1).max(100)),
  winnerSelect: unset(z.enum(['manual', 'auto'])),
  winnerNotify: unset(z.enum(['manual', 'auto'])),
  notifyDelayMinutes: unset(z.number().int().min(0).max(7 * 24 * 60)),
  // DM text with {name}, {giveaway}, {deadline}. null = use the default message.
  winnerMessage: z.string().max(1500).nullish(),
  claimHours: unset(z.number().int().min(1).max(720)),
};

const createSchema = z.object(giveawayFields);
const updateSchema = z.object(giveawayFields).partial();
type GiveawayInput = z.infer<typeof updateSchema>;

/** Checks that need the whole picture: dates, IG setup, unique field ids. Returns an error message or null. */
function crossCheck(merged: {
  startsAt: Date | null;
  endsAt: Date;
  formFields: { id: string; type: string }[];
  rules: { action: string; windowStart?: Date | null | undefined; windowEnd?: Date | null | undefined }[];
}) {
  if (!merged.startsAt || merged.endsAt <= merged.startsAt) return 'endsAt must be after startsAt';
  const ids = merged.formFields.map(f => f.id);
  if (new Set(ids).size !== ids.length) return 'form field ids must be unique';
  if (merged.formFields.filter(f => f.type === 'ig_username').length > 1) return 'only one Instagram username field allowed';
  if (merged.rules.some(r => r.action.startsWith('ig_')) && !merged.formFields.some(f => f.type === 'ig_username')) {
    return 'Instagram rules need an Instagram username field in the form';
  }
  for (const r of merged.rules) {
    if (r.windowStart && r.windowEnd && r.windowEnd <= r.windowStart) return 'rule windowEnd must be after windowStart';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Shapes returned to the dashboard

const ACTION_LABELS: Record<string, string> = { ig_comment: 'Instagram comment', ig_story: 'Instagram Story mention', manual: 'Manual' };

const fmt = (d: Date) =>
  d.toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** Human label for a rule, used in the dashboard and as export column headers. */
export function describeRule(r: Rule) {
  const parts = [`${ACTION_LABELS[r.action] ?? r.action} (max ${r.maxCount}`];
  if (r.frequency) parts.push(`, 1 per ${r.frequency}`);
  if (r.windowStart || r.windowEnd) parts.push(`, ${r.windowStart ? fmt(r.windowStart) : 'start'}–${r.windowEnd ? fmt(r.windowEnd) : 'end'}`);
  if (r.options.requireTag) parts.push(', must tag a friend');
  return `#${r.position} ${parts.join('')})`;
}

async function giveawayJson(g: Giveaway) {
  const rules = await getRules(g.id);
  return {
    ...g,
    status: statusOf(g),
    entrantCount: await entrantCount(g.id),
    rules: rules.map(r => ({ ...r, description: describeRule(r) })),
    // Effective update settings with defaults filled in, for the dashboard's toggles.
    announcements: resolveAnnouncements(g.announcements),
    defaultWinnerMessage: DEFAULT_WINNER_MESSAGE,
    winners: await listWinners(g.id),
    // Last Instagram comment read: show a warning when lastError is set.
    igSync: await getSyncStatus(g.id),
  };
}

/** Looks up the post for an igPost value. Returns the post, or an HTTP error to send back. */
async function lookupIgPost(value: string) {
  try {
    const post = await resolvePost(value);
    if (!post) return { error: { status: 400, message: `Couldn't find that post on @BostonBlerds. Paste the post's link (instagram.com/p/…).` } };
    return { post };
  } catch (err) {
    return { error: { status: 502, message: `Instagram didn't respond: ${(err as Error).message}` } };
  }
}

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
    res.json(await Promise.all(all.map(giveawayJson)));
  });

  router.post('/giveaways', requireActor, async (req: Req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: z.prettifyError(parsed.error) });
    const input = { ...parsed.data, formFields: parsed.data.formFields ?? [], rules: parsed.data.rules ?? [] };
    const problem = crossCheck(input);
    if (problem) return void res.status(400).json({ error: problem });

    const overlap = await findOverlap(input.startsAt, input.endsAt);
    if (overlap) return void res.status(409).json({ error: `Overlaps with "${overlap.name}". Only one giveaway can run at a time.` });

    let igPost = null;
    if (input.igPost) {
      const found = await lookupIgPost(input.igPost);
      if (found.error) return void res.status(found.error.status).json({ error: found.error.message });
      igPost = found.post;
    }

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
          entryChannel: input.entryChannel ?? null,
          igMediaId: igPost?.id ?? null,
          igPostedAt: igPost ? new Date(igPost.postedAt) : null,
          igPermalink: igPost?.permalink ?? null,
          formFields: input.formFields,
          reminderText: input.reminderText ?? null,
          maxParticipants: input.maxParticipants ?? null,
          ...(input.announcements ? { announcements: input.announcements } : {}),
          testMode: input.testMode ?? false,
          winnerNotify: input.winnerNotify ?? 'manual',
          claimHours: input.claimHours ?? 12,
        })
        .returning();
      if (input.rules.length) {
        await tx.insert(giveawayRules).values(
          input.rules.map((r, i) => ({
            giveawayId: created!.id,
            position: i + 1,
            action: r.action,
            maxCount: r.maxCount,
            windowStart: r.windowStart ?? null,
            windowEnd: r.windowEnd ?? null,
            frequency: r.frequency ?? null,
            options: r.options ?? {},
          })),
        );
      }
      return created!;
    });
    await audit(g.id, req.actor!, 'giveaway.created', { name: g.name, igPost: igPost?.permalink ?? null });
    if (igPost) inBackground(runCommentSync(g, 'post-set'));
    res.status(201).json(await giveawayJson(g));
  });

  router.get('/giveaways/:id', async (req: Req, res) => {
    res.json(await giveawayJson(req.giveaway!));
  });

  router.patch('/giveaways/:id', requireActor, async (req: Req, res) => {
    const g = req.giveaway!;
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: z.prettifyError(parsed.error) });
    const input: GiveawayInput = parsed.data;
    const currentRules = await getRules(g.id);

    const merged = {
      startsAt: input.startsAt ?? g.startsAt,
      endsAt: input.endsAt ?? g.endsAt,
      formFields: input.formFields ?? g.formFields,
      rules: input.rules ?? currentRules,
    };
    const problem = crossCheck(merged);
    if (problem) return void res.status(400).json({ error: problem });
    if ((input.startsAt || input.endsAt) && !g.closedAt) {
      const overlap = await findOverlap(merged.startsAt!, merged.endsAt, g.id);
      if (overlap) return void res.status(409).json({ error: `Overlaps with "${overlap.name}". Only one giveaway can run at a time.` });
    }
    if (input.rules?.some(r => r.id && !currentRules.some(c => c.id === r.id))) {
      return void res.status(400).json({ error: 'A rule id does not belong to this giveaway' });
    }

    // undefined = leave the post alone, null = clear it, anything else = look it up.
    let postChange: { id: string | null; postedAt: Date | null; permalink: string | null } | undefined;
    if (input.igPost === null) postChange = { id: null, postedAt: null, permalink: null };
    else if (input.igPost) {
      const found = await lookupIgPost(input.igPost);
      if (found.error) return void res.status(found.error.status).json({ error: found.error.message });
      postChange = { id: found.post.id, postedAt: new Date(found.post.postedAt), permalink: found.post.permalink };
    }

    const { rules, igPost: _igPost, ...settings } = input;
    await db.transaction(async tx => {
      const changes = Object.fromEntries(Object.entries(settings).filter(([, v]) => v !== undefined));
      if (postChange) Object.assign(changes, { igMediaId: postChange.id, igPostedAt: postChange.postedAt, igPermalink: postChange.permalink });
      await tx.update(giveaways).set({ ...changes, updatedAt: new Date() }).where(eq(giveaways.id, g.id));

      if (rules) {
        // Rules are replaced by the list sent: matched by id, new ones added, missing ones removed.
        // Entries already earned under a removed rule stay; they just lose their rule label.
        const keep = rules.filter(r => r.id).map(r => r.id!);
        const removed = currentRules.filter(c => !keep.includes(c.id)).map(c => c.id);
        if (removed.length) await tx.delete(giveawayRules).where(inArray(giveawayRules.id, removed));
        for (const [i, r] of rules.entries()) {
          const values = {
            position: i + 1,
            action: r.action,
            maxCount: r.maxCount,
            windowStart: r.windowStart ?? null,
            windowEnd: r.windowEnd ?? null,
            frequency: r.frequency ?? null,
            options: r.options ?? {},
          };
          if (r.id) await tx.update(giveawayRules).set(values).where(eq(giveawayRules.id, r.id));
          else await tx.insert(giveawayRules).values({ ...values, giveawayId: g.id });
        }
      }
    });
    await audit(g.id, req.actor!, 'giveaway.updated', { fields: Object.keys(input), ...(postChange ? { igPost: postChange.permalink } : {}) });
    const updated = (await getGiveaway(g.id))!;
    // Later end time or a bigger cap: tell #community-updates.
    const extended: { endsAt?: Date; maxParticipants?: number } = {};
    if (updated.endsAt > g.endsAt) extended.endsAt = updated.endsAt;
    if (updated.maxParticipants && (!g.maxParticipants || updated.maxParticipants > g.maxParticipants)) extended.maxParticipants = updated.maxParticipants;
    if (Object.keys(extended).length && statusOf(updated) !== 'closed') inBackground(announceExtended(client, updated, extended));
    // A new post: read its comments now instead of waiting for the next scheduled read.
    if (postChange?.id && postChange.id !== g.igMediaId) inBackground(runCommentSync(updated, 'post-set'));
    res.json(await giveawayJson(updated));
  });

  router.post('/giveaways/:id/close', requireActor, async (req: Req, res) => {
    const closed = await closeGiveaway(req.giveaway!.id, req.actor!, 'early');
    if (!closed) return void res.status(409).json({ error: 'Already closed' });
    inBackground(runFinalSync(closed));
    res.json(await giveawayJson(closed));
  });

  // Permanent delete. Open giveaways must be closed first; needs ?confirm=<giveaway name> unless in test mode.
  router.delete('/giveaways/:id', requireActor, async (req: Req, res) => {
    const g = req.giveaway!;
    if (statusOf(g) === 'open') return void res.status(409).json({ error: 'Close this giveaway before deleting it.' });
    // Everyone gets deleted, disqualified entrants included, so count them all.
    const entrantsSoFar = (await entrantReport(g.id)).entrants.length;
    const confirm = typeof req.query.confirm === 'string' ? req.query.confirm.trim() : '';
    // Every delete needs the exact name typed, except test-mode giveaways.
    if (!g.testMode && confirm !== (g.name ?? g.slug)) {
      return void res.status(400).json({
        error: `To permanently delete this giveaway${entrantsSoFar ? ` and its ${entrantsSoFar} entrant${entrantsSoFar === 1 ? '' : 's'}` : ''}, add ?confirm=<giveaway name> (exactly "${g.name ?? g.slug}").`,
        requiresConfirm: true,
        entrants: entrantsSoFar,
      });
    }
    const result = await deleteGiveaway(g, req.actor!);
    res.json({ deleted: true, id: g.id, name: g.name, entrants: result.entrants });
  });

  // "Sync now": read the post's comments immediately and return the result.
  router.post('/giveaways/:id/sync', requireActor, async (req: Req, res) => {
    const g = req.giveaway!;
    if (!g.igMediaId) return void res.status(400).json({ error: 'Set the giveaway\'s Instagram post first' });
    await runCommentSync(g, 'manual');
    res.json({ igSync: await getSyncStatus(g.id) });
  });

  // Post picker: @BostonBlerds' recent posts with thumbnails.
  router.get('/instagram/posts', async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 12, 1), 50);
    try {
      res.json(await listRecentPosts(limit));
    } catch (err) {
      res.status(502).json({ error: `Instagram didn't respond: ${(err as Error).message}` });
    }
  });

  // Paste a link → the post (or a clear error), e.g. to preview it before saving.
  router.get('/instagram/resolve', async (req, res) => {
    const url = typeof req.query.url === 'string' ? req.query.url : '';
    if (!url) return void res.status(400).json({ error: 'Pass ?url=<Instagram post link or media ID>' });
    const found = await lookupIgPost(url);
    if (found.error) return void res.status(found.error.status === 400 ? 404 : found.error.status).json({ error: found.error.message });
    res.json(found.post);
  });

  router.get('/giveaways/:id/entrants', async (req: Req, res) => {
    const g = req.giveaway!;
    const { entrants, unmatched } = await entrantReport(g.id);
    const members = await serverMemberIds(client);
    res.json({
      entrants: entrants.map(e => ({ ...e, inServer: members ? members.has(e.discordId) : null })),
      unmatched,
    });
  });

  router.post('/giveaways/:id/bonuses', requireActor, async (req: Req, res) => {
    const body = z.object({ entrantId: z.number().int(), label: z.string().min(1).max(100) }).safeParse(req.body);
    if (!body.success) return void res.status(400).json({ error: z.prettifyError(body.error) });
    const bonus = await addManualBonus(req.giveaway!.id, body.data.entrantId, body.data.label, req.actor!);
    if (!bonus) return void res.status(404).json({ error: 'Entrant not found' });
    res.status(201).json(bonus);
  });

  router.delete('/giveaways/:id/bonuses/:bonusId', requireActor, async (req: Req, res) => {
    const reason = z.object({ reason: z.string().min(1).max(200) }).safeParse(req.body ?? {});
    const revoked = await revokeBonus(req.giveaway!.id, Number(req.params.bonusId), req.actor!, reason.success ? reason.data.reason : 'Removed by admin');
    if (!revoked) return void res.status(404).json({ error: 'Bonus not found or already removed' });
    res.json(revoked);
  });

  router.post('/giveaways/:id/entrants/:entrantId/disqualify', requireActor, async (req: Req, res) => {
    const body = z.object({ reason: z.string().min(1).max(200) }).safeParse(req.body);
    if (!body.success) return void res.status(400).json({ error: 'A reason is required' });
    const e = await setEntrantRevoked(req.giveaway!.id, Number(req.params.entrantId), req.actor!, body.data.reason);
    if (!e) return void res.status(404).json({ error: 'Entrant not found' });
    res.json(e);
  });

  router.post('/giveaways/:id/entrants/:entrantId/restore', requireActor, async (req: Req, res) => {
    const e = await setEntrantRevoked(req.giveaway!.id, Number(req.params.entrantId), req.actor!, null);
    if (!e) return void res.status(404).json({ error: 'Entrant not found' });
    res.json(e);
  });

  // ----- Winners

  router.get('/giveaways/:id/winners', async (req: Req, res) => {
    const g = req.giveaway!;
    const { entrants } = await entrantReport(g.id);
    const byId = new Map(entrants.map(e => [e.id, e]));
    res.json((await listWinners(g.id)).map(w => ({ ...w, entrant: byId.get(w.entrantId) ?? null })));
  });

  /** Checks shared by picking and drawing: the giveaway is closed and a winner slot is open. */
  async function canSelect(g: Giveaway) {
    if (statusOf(g) !== 'closed') return 'Winners can be picked once the giveaway is closed.';
    if (!openSlots(g.winnerCount, (await listWinners(g.id)).map(w => w.status))) return `All ${g.winnerCount} winner slot(s) are filled. Resolve a winner first, or raise winnerCount.`;
    return null;
  }

  // Manual pick from the entrants list.
  router.post('/giveaways/:id/winners', requireActor, async (req: Req, res) => {
    const g = req.giveaway!;
    const body = z.object({ entrantId: z.number().int() }).safeParse(req.body);
    if (!body.success) return void res.status(400).json({ error: 'entrantId is required' });
    const problem = await canSelect(g);
    if (problem) return void res.status(409).json({ error: problem });
    const pick = (await eligiblePool(g, client)).find(p => p.entrant.id === body.data.entrantId);
    if (!pick) return void res.status(400).json({ error: "That entrant can't win: disqualified, left the server, or already picked." });
    const w = await selectWinner(client, g, pick.entrant, req.actor!);
    res.status(201).json(w);
  });

  // "Draw at random" (weighted by entries), for manual-select giveaways that want a random pick.
  router.post('/giveaways/:id/winners/draw', requireActor, async (req: Req, res) => {
    const g = req.giveaway!;
    const problem = await canSelect(g);
    if (problem) return void res.status(409).json({ error: problem });
    const w = await drawWinner(client, g, req.actor!);
    if (!w) return void res.status(409).json({ error: 'No eligible entrants left to draw.' });
    res.status(201).json(w);
  });

  // "Notify now": send the winner's DM without waiting for the delay.
  router.post('/giveaways/:id/winners/:winnerId/notify', requireActor, async (req: Req, res) => {
    if (!client?.isReady()) return void res.status(503).json({ error: 'The bot is not connected to Discord right now.' });
    const w = (await listWinners(req.giveaway!.id)).find(x => x.id === Number(req.params.winnerId));
    if (!w) return void res.status(404).json({ error: 'Winner not found' });
    const result = await notifyWinner(client, w.id, req.actor!);
    if (!result.ok) return void res.status(409).json({ error: result.error });
    res.json({ notified: true });
  });

  // Manual notify (or DMs closed): admins report what the winner said.
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

  router.get('/giveaways/:id/export/:file', async (req: Req, res) => {
    const g = req.giveaway!;
    const file = req.params.file as string;
    const base = (g.name ?? g.slug).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const send = (suffix: string, csv: string) =>
      res.type('text/csv').attachment(`${base}-${suffix}.csv`).send(csv);

    if (file === 'audit.csv') {
      const rows = await auditRows(g.id, 100_000);
      return void send('audit', toCsv(['when', 'who', 'action', 'details'], rows.map(a => [a.createdAt, a.actorId, a.action, JSON.stringify(a.details)])));
    }

    const rules = await getRules(g.id);
    const { entrants } = await entrantReport(g.id);
    const members = await serverMemberIds(client);
    const inServer = (id: string) => (members ? members.has(id) : '');
    const eligible = entrants.filter(e => !e.revokedAt && (!members || members.has(e.discordId)));
    const ruleName = (ruleId: number | null, action: string | null, label: string | null) => {
      const r = rules.find(x => x.id === ruleId);
      return r ? describeRule(r) : action === 'manual' ? `Manual: ${label ?? ''}` : `${ACTION_LABELS[action ?? ''] ?? action} (removed rule)`;
    };

    if (file === 'entries.csv') {
      // One row per entry: what the spinner loads. Disqualified people and people who left the server are excluded.
      const rows = eligible.flatMap(e => [
        [e.discordUsername, e.discordId, e.igUsername, 'Base entry'],
        ...e.bonuses.map(b => [e.discordUsername, e.discordId, e.igUsername, ruleName(b.ruleId, b.action, b.label)]),
      ]);
      return void send('entries', toCsv(['discord_username', 'discord_id', 'ig_username', 'entry_source'], rows));
    }

    if (file === 'entrants.csv') {
      const fields = g.formFields.filter(f => f.type !== 'ig_username');
      const headers = [
        'discord_username', 'discord_id', 'ig_username',
        ...fields.map(f => f.label),
        ...rules.map(describeRule), 'manual_entries',
        'total_entries', 'entered_at', 'in_server', 'disqualified_reason',
      ];
      const rows = entrants.map(e => [
        e.discordUsername, e.discordId, e.igUsername,
        ...fields.map(f => e.answers[f.id] ?? ''),
        ...rules.map(r => e.bonuses.filter(b => b.ruleId === r.id).length),
        e.bonuses.filter(b => b.action === 'manual').length,
        e.totalEntries, e.createdAt, inServer(e.discordId), e.revokedReason ?? '',
      ]);
      return void send('entrants', toCsv(headers, rows));
    }

    res.status(404).json({ error: 'Unknown export. Use entries.csv, entrants.csv or audit.csv' });
  });

  return router;
}

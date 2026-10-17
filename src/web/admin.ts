import crypto from 'crypto';
import type { Client } from 'discord.js';
import express, { type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { eq, inArray } from 'drizzle-orm';
import { env } from '../config/environment.js';
import { db } from '../db/client.js';
import { giveawayRules, giveaways } from '../db/schema.js';
import { toCsv } from '../lib/csv.js';
import type { Rule } from '../giveaway/rules.js';
import {
  addManualBonus,
  audit,
  auditRows,
  closeGiveaway,
  entrantCount,
  entrantReport,
  findOverlap,
  getGiveaway,
  getRules,
  listGiveaways,
  recordWinner,
  revokeBonus,
  setEntrantRevoked,
  slugify,
  statusOf,
  type Giveaway,
} from '../giveaway/service.js';

// ---------------------------------------------------------------------------
// Validation

const isoDate = z.iso.datetime({ offset: true }).transform(s => new Date(s));

const formFieldSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9_]{1,40}$/, 'lowercase letters, numbers and underscores'),
    label: z.string().min(1).max(45),
    type: z.enum(['ig_username', 'short_text', 'long_text', 'select']),
    required: z.boolean(),
    placeholder: z.string().max(100).optional(),
    options: z.array(z.string().min(1).max(100)).min(1).max(25).optional(),
  })
  .refine(f => f.type !== 'select' || !!f.options?.length, { message: 'select fields need options' });

const ruleSchema = z.object({
  id: z.number().int().optional(),
  action: z.enum(['ig_comment', 'ig_story']),
  maxCount: z.number().int().min(1).max(1000),
  windowStart: isoDate.nullable().optional(),
  windowEnd: isoDate.nullable().optional(),
  frequency: z.enum(['day', 'week']).nullable().optional(),
  options: z.object({ requireTag: z.boolean().optional() }).optional(),
});

const giveawayFields = {
  name: z.string().min(1).max(80),
  startsAt: isoDate,
  endsAt: isoDate,
  entryChannel: z.string().max(100).nullable().optional(),
  igHashtag: z.string().regex(/^#\w{1,60}$/, 'a single hashtag like #BBxGTAVI').nullable().optional(),
  formFields: z.array(formFieldSchema).max(5),
  reminderText: z.string().max(500).nullable().optional(),
  maxParticipants: z.number().int().min(1).nullable().optional(),
  announcements: z
    .object({
      enabled: z.boolean(),
      milestoneEvery: z.number().int().min(1).optional(),
      countdownHours: z.array(z.number().positive()).max(10).optional(),
    })
    .optional(),
  testMode: z.boolean().optional(),
  winnerNotify: z.enum(['manual', 'auto']).optional(),
  claimHours: z.number().int().min(1).max(720).optional(),
  rules: z.array(ruleSchema).max(20),
};

const createSchema = z.object(giveawayFields);
const updateSchema = z.object(giveawayFields).partial();
type GiveawayInput = z.infer<typeof updateSchema>;

/** Checks that need the whole picture: dates, IG setup, unique field ids. Returns an error message or null. */
function crossCheck(merged: {
  startsAt: Date | null;
  endsAt: Date;
  igHashtag?: string | null | undefined;
  formFields: { id: string; type: string }[];
  rules: { action: string; windowStart?: Date | null | undefined; windowEnd?: Date | null | undefined }[];
}) {
  if (!merged.startsAt || merged.endsAt <= merged.startsAt) return 'endsAt must be after startsAt';
  const ids = merged.formFields.map(f => f.id);
  if (new Set(ids).size !== ids.length) return 'form field ids must be unique';
  if (merged.formFields.filter(f => f.type === 'ig_username').length > 1) return 'only one Instagram username field allowed';
  if (merged.rules.some(r => r.action.startsWith('ig_'))) {
    if (!merged.igHashtag) return 'Instagram rules need igHashtag';
    if (!merged.formFields.some(f => f.type === 'ig_username')) return 'Instagram rules need an Instagram username field in the form';
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
  };
}

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
    const input = parsed.data;
    const problem = crossCheck({ ...input, rules: input.rules });
    if (problem) return void res.status(400).json({ error: problem });

    const overlap = await findOverlap(input.startsAt, input.endsAt);
    if (overlap) return void res.status(409).json({ error: `Overlaps with "${overlap.name}". Only one giveaway can run at a time.` });

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
          igHashtag: input.igHashtag ?? null,
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
    await audit(g.id, req.actor!, 'giveaway.created', { name: g.name });
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
      igHashtag: input.igHashtag !== undefined ? input.igHashtag : g.igHashtag,
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

    const { rules, ...settings } = input;
    await db.transaction(async tx => {
      const changes = Object.fromEntries(Object.entries(settings).filter(([, v]) => v !== undefined));
      // A new hashtag means a different post: forget the one found for the old hashtag.
      if (input.igHashtag !== undefined && input.igHashtag !== g.igHashtag) Object.assign(changes, { igMediaId: null, igPostedAt: null });
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
    await audit(g.id, req.actor!, 'giveaway.updated', { fields: Object.keys(input) });
    res.json(await giveawayJson((await getGiveaway(g.id))!));
  });

  router.post('/giveaways/:id/close', requireActor, async (req: Req, res) => {
    const closed = await closeGiveaway(req.giveaway!.id, req.actor!, 'early');
    if (!closed) return void res.status(409).json({ error: 'Already closed' });
    res.json(await giveawayJson(closed));
  });

  router.get('/giveaways/:id/entrants', async (req: Req, res) => {
    const g = req.giveaway!;
    const { entrants, unmatched } = await entrantReport(g.id);
    const members = await serverMembers(client);
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

  router.post('/giveaways/:id/winner', requireActor, async (req: Req, res) => {
    const body = z.object({ entrantId: z.number().int() }).safeParse(req.body);
    if (!body.success) return void res.status(400).json({ error: 'entrantId is required' });
    const winner = await recordWinner(req.giveaway!.id, body.data.entrantId, req.actor!);
    if (!winner) return void res.status(404).json({ error: 'Entrant not found' });
    res.json({ winner });
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
    const members = await serverMembers(client);
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

// Server members, cached briefly so exports and tables don't refetch on every request.
let membersCache: { at: number; ids: Set<string> } | undefined;
async function serverMembers(client?: Client): Promise<Set<string> | null> {
  if (!client?.isReady()) return null;
  if (membersCache && Date.now() - membersCache.at < 60_000) return membersCache.ids;
  const guild = await client.guilds.fetch(env.SERVER_ID);
  const members = await guild.members.fetch();
  membersCache = { at: Date.now(), ids: new Set(members.keys()) };
  return membersCache.ids;
}

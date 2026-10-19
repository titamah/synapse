import { PermissionFlagsBits, type Client } from 'discord.js';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { env } from '../config/environment.js';
import { db } from '../db/client.js';
import { auditLog, flagStates, giveaways } from '../db/schema.js';
import { textChannelByName } from '../discord/channels.js';
import type { EngineRule } from '../giveaway/engine.js';
import { ruleLabel } from '../giveaway/labels.js';
import { deletesAt } from '../giveaway/retention.js';
import { enterChannels, getEntrantByIg, getRules, readsInstagram, statusOf, type Giveaway, type GiveawayStatus } from '../giveaway/service.js';
import { listWinners } from '../giveaway/winners.js';
import { getSyncStatus } from '../instagram/sync.js';
import { tokenStatus } from '../instagram/token.js';

/**
 * Flags: things that need an admin's attention. They're calculated from the current state every
 * time, so a flag clears itself as soon as what it checks is fixed. Only snoozes, dismissals and
 * the Discord alert are remembered (flag_states).
 *
 *   blocking  something isn't working on a live giveaway. Clears only by fixing it.
 *   warning   needs attention soon. Fix it, or snooze it for 24 hours.
 *   info      a heads-up. Fix it, dismiss it, or it passes.
 */
export type Severity = 'blocking' | 'warning' | 'info';

export type FlagCode =
  | 'comment_post_missing'
  | 'entry_channel_problem'
  | 'ig_sync_failing'
  | 'ig_token'
  | 'winner_waiting'
  | 'username_conflict'
  | 'retention_upcoming';

export type Flag = {
  key: string;
  code: FlagCode;
  severity: Severity;
  giveawayId: number | null;
  ruleId?: number;
  winnerId?: number;
  message: string;
  /** Post an alert in #community-updates when it appears (some flags only matter once a giveaway is open). */
  alert: boolean;
};

export const SNOOZE_MS = 24 * 60 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;

const name = (g: Giveaway) => g.name ?? g.slug;

// ---------------------------------------------------------------------------
// Calculating

/** What one giveaway's flags are worked out from (gathered from the database and Discord). */
export type GiveawayFacts = {
  giveaway: Giveaway;
  status: GiveawayStatus;
  rules: EngineRule[];
  /** Entry channels with a problem: missing, or the bot can't see/post there. null = Discord unknown (offline). */
  channelProblems: { channel: string; problem: 'missing' | 'no-access' }[] | null;
  syncError: string | null;
  winnersWaiting: { id: number; status: string; who: string }[];
  /** Username conflicts still standing: the username's owner hasn't been disqualified. */
  conflicts: { igUsername: string; attemptedBy: string; claimedBy: string | null }[];
  now: Date;
};

/** A giveaway's flags. Pure, so it's easy to test. */
export function giveawayFlags(f: GiveawayFacts): Flag[] {
  const g = f.giveaway;
  const out: Flag[] = [];
  const live = f.status === 'open';
  const quiet = g.testMode; // test giveaways show flags but never alert

  if (f.status !== 'closed') {
    for (const r of f.rules.filter(r => r.platform === 'instagram' && r.action === 'comment' && !r.options.post)) {
      out.push({
        key: `comment_post_missing:${g.id}:${r.id}`,
        code: 'comment_post_missing',
        severity: live ? 'blocking' : 'info',
        giveawayId: g.id,
        ruleId: r.id,
        message: live
          ? `${name(g)}: Rule #${r.position} (${ruleLabel(r)}) has no post, so its comments don't count yet.`
          : `${name(g)}: Rule #${r.position} (${ruleLabel(r)}) needs its post before the giveaway starts.`,
        alert: live && !quiet,
      });
    }
    for (const c of f.channelProblems ?? []) {
      out.push({
        key: `entry_channel_problem:${g.id}:${c.channel}`,
        code: 'entry_channel_problem',
        severity: live ? 'blocking' : 'warning',
        giveawayId: g.id,
        message:
          c.problem === 'missing'
            ? `${name(g)}: the entry channel #${c.channel} doesn't exist, so /giveaway enter can't be used there.`
            : `${name(g)}: BB-Bot can't see or post in #${c.channel}. Check the channel's permissions.`,
        alert: !quiet,
      });
    }
  }

  if (live && f.syncError) {
    out.push({
      key: `ig_sync_failing:${g.id}`,
      code: 'ig_sync_failing',
      severity: 'blocking',
      giveawayId: g.id,
      message: `${name(g)}: reading Instagram is failing, so new comments and tagged posts aren't counted. Last error: ${f.syncError}`,
      alert: !quiet,
    });
  }

  for (const w of f.winnersWaiting) {
    out.push({
      key: `winner_waiting:${g.id}:${w.id}:${w.status}`,
      code: 'winner_waiting',
      severity: 'warning',
      giveawayId: g.id,
      winnerId: w.id,
      message:
        w.status === 'checking'
          ? `${name(g)}: winner ${w.who} is waiting for their winner checks to be confirmed.`
          : `${name(g)}: winner ${w.who} can't be DMed. Reach out to them and report the outcome.`,
      alert: !quiet,
    });
  }

  for (const c of f.conflicts) {
    out.push({
      key: `username_conflict:${g.id}:${c.igUsername}:${c.attemptedBy}`,
      code: 'username_conflict',
      severity: 'warning',
      giveawayId: g.id,
      message: `${name(g)}: <@${c.attemptedBy}> couldn't enter with Instagram @${c.igUsername}, already used by ${c.claimedBy ? `<@${c.claimedBy}>` : 'someone else'}. Disqualify whoever doesn't own it.`,
      alert: false, // already alerted when it happened
    });
  }

  if (f.status === 'closed' && !g.personalDataDeletedAt) {
    const due = deletesAt(g);
    if (due.getTime() - f.now.getTime() <= 7 * DAY) {
      const when = due.toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'long', day: 'numeric', year: 'numeric' });
      out.push({
        key: `retention_upcoming:${g.id}`,
        code: 'retention_upcoming',
        severity: 'info',
        giveawayId: g.id,
        message: `${name(g)}: people, activity and entries will be deleted on ${when} (90 days after it ended). Export anything you need before then.`,
        alert: !quiet,
      });
    }
  }
  return out;
}

/** Flags that aren't about one giveaway. */
export function globalFlags(token: Awaited<ReturnType<typeof tokenStatus>>, now: Date): Flag[] {
  if (!token.configured) return [];
  const out: Flag[] = [];
  if (token.lastError) {
    out.push({ key: 'ig_token:renew_failed', code: 'ig_token', severity: 'warning', giveawayId: null, message: `Instagram connection: renewing the token failed (${token.lastError}).`, alert: true });
  }
  if (token.expiresAt && new Date(token.expiresAt).getTime() - now.getTime() < 14 * DAY) {
    out.push({ key: 'ig_token:expiring', code: 'ig_token', severity: 'warning', giveawayId: null, message: `Instagram connection: the token expires ${new Date(token.expiresAt).toDateString()}. Renew it in the dashboard.`, alert: true });
  }
  return out;
}

async function channelProblems(client: Client | undefined, g: Giveaway) {
  if (!client?.isReady()) return null;
  const out: GiveawayFacts['channelProblems'] = [];
  for (const channel of enterChannels(g)) {
    const found = await textChannelByName(client, channel).catch(() => null);
    if (!found) out.push({ channel, problem: 'missing' });
    else if (!found.permissionsFor(client.user)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) out.push({ channel, problem: 'no-access' });
  }
  return out;
}

async function standingConflicts(g: Giveaway) {
  const rows = await db.select().from(auditLog).where(and(eq(auditLog.giveawayId, g.id), eq(auditLog.action, 'entry.ig_conflict')));
  const seen = new Map<string, GiveawayFacts['conflicts'][number]>();
  for (const r of rows) {
    const d = r.details as { igUsername?: string; claimedByDiscordId?: string | null };
    if (!d.igUsername) continue;
    seen.set(`${d.igUsername}:${r.actorId}`, { igUsername: d.igUsername, attemptedBy: r.actorId, claimedBy: d.claimedByDiscordId ?? null });
  }
  const out: GiveawayFacts['conflicts'] = [];
  for (const c of seen.values()) {
    const owner = await getEntrantByIg(g.id, c.igUsername);
    // Resolved once the owner is disqualified, the username is free, or the person who tried now has it.
    if (owner && !owner.revokedAt && owner.discordId !== c.attemptedBy) out.push({ ...c, claimedBy: owner.discordId });
  }
  return out;
}

/** Every current flag, worked out from the database (and Discord, when connected). */
export async function computeFlags(client?: Client, now = new Date()): Promise<Flag[]> {
  const all = await db.query.giveaways.findMany({ where: isNull(giveaways.personalDataDeletedAt) });
  const out: Flag[] = globalFlags(await tokenStatus(), now);
  for (const g of all) {
    const status = statusOf(g, now);
    const rules = await getRules(g.id);
    const winners = await listWinners(g.id);
    const sync = status === 'open' && (await readsInstagram(g)) ? await getSyncStatus(g.id) : null;
    out.push(
      ...giveawayFlags({
        giveaway: g,
        status,
        rules,
        channelProblems: status === 'closed' ? [] : await channelProblems(client, g),
        syncError: sync?.lastError ?? null,
        winnersWaiting: winners
          .filter(w => w.status === 'checking' || w.status === 'unreachable')
          .map(w => ({ id: w.id, status: w.status, who: w.person?.discordId ? `<@${w.person.discordId}>` : `@${w.person?.igUsername ?? 'unknown'}` })),
        conflicts: await standingConflicts(g),
        now,
      }),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Remembering (snoozes, dismissals, alerts)

export type FlagState = typeof flagStates.$inferSelect;
export type ActiveFlag = Flag & { state: FlagState };

/**
 * Calculates the flags and brings flag_states up to date: new flags get a row, flags that came
 * back start over (alert again), and flags that are gone are marked resolved.
 * Returns the current flags (with their state) and the ones that just cleared.
 */
export async function syncFlags(client?: Client, now = new Date()) {
  const flags = await computeFlags(client, now);
  const keys = flags.map(f => f.key);
  const existing = keys.length ? await db.select().from(flagStates).where(inArray(flagStates.key, keys)) : [];
  const byKey = new Map(existing.map(s => [s.key, s]));

  const active: ActiveFlag[] = [];
  for (const f of flags) {
    let state = byKey.get(f.key);
    if (!state) {
      [state] = await db.insert(flagStates).values({ key: f.key, giveawayId: f.giveawayId, code: f.code, firstSeenAt: now }).onConflictDoNothing().returning();
      state ??= (await db.query.flagStates.findFirst({ where: eq(flagStates.key, f.key) }))!;
    } else if (state.resolvedAt) {
      // It came back: treat it as new.
      [state] = await db
        .update(flagStates)
        .set({ resolvedAt: null, firstSeenAt: now, alertedAt: null, alertChannelId: null, alertMessageId: null, snoozedUntil: null, dismissedAt: null, actedBy: null })
        .where(eq(flagStates.id, state.id))
        .returning();
    }
    active.push({ ...f, state: state! });
  }

  const gone = (await db.select().from(flagStates).where(isNull(flagStates.resolvedAt))).filter(s => !keys.includes(s.key));
  if (gone.length) await db.update(flagStates).set({ resolvedAt: now }).where(inArray(flagStates.id, gone.map(s => s.id)));
  return { active, resolved: gone };
}

/** Shown to admins (not snoozed or dismissed). */
export const isOpen = (f: ActiveFlag, now = new Date()) => !f.state.dismissedAt && !(f.state.snoozedUntil && f.state.snoozedUntil > now);

export const resolveUrl = (f: Pick<Flag, 'giveawayId'>) => (f.giveawayId ? `${env.ADMIN_DASHBOARD_URL}/giveaways/${f.giveawayId}/` : `${env.ADMIN_DASHBOARD_URL}/`);

/** What an admin can do besides fixing it. */
export const flagActions = (severity: Severity) => (severity === 'warning' ? ['snooze'] : severity === 'info' ? ['dismiss'] : []) as ('snooze' | 'dismiss')[];

export function flagJson(f: ActiveFlag, now = new Date()) {
  return {
    id: f.state.id,
    key: f.key,
    code: f.code,
    severity: f.severity,
    giveawayId: f.giveawayId,
    ruleId: f.ruleId ?? null,
    winnerId: f.winnerId ?? null,
    message: f.message,
    since: f.state.firstSeenAt,
    open: isOpen(f, now),
    snoozedUntil: f.state.snoozedUntil && f.state.snoozedUntil > now ? f.state.snoozedUntil : null,
    dismissedAt: f.state.dismissedAt,
    actions: flagActions(f.severity),
    resolveUrl: resolveUrl(f),
  };
}

/** Snooze (warnings, 24h) or dismiss (info). Returns an error message, or the updated state. */
export async function actOnFlag(id: number, action: 'snooze' | 'dismiss', by: string, client?: Client) {
  const { active } = await syncFlags(client);
  const f = active.find(x => x.state.id === id);
  if (!f) return { error: 'That flag is resolved or no longer exists.' } as const;
  if (!flagActions(f.severity).includes(action)) {
    return { error: f.severity === 'blocking' ? 'Blocking flags clear only when fixed.' : `${f.severity} flags can't be ${action}ed.` } as const;
  }
  const [state] = await db
    .update(flagStates)
    .set(action === 'snooze' ? { snoozedUntil: new Date(Date.now() + SNOOZE_MS), alertedAt: null, actedBy: by } : { dismissedAt: new Date(), actedBy: by })
    .where(eq(flagStates.id, id))
    .returning();
  return { flag: { ...f, state: state! } } as const;
}

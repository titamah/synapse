import { sql } from 'drizzle-orm';
import { boolean, pgEnum, pgTable, serial, text, timestamp, integer, jsonb, uniqueIndex, index } from 'drizzle-orm/pg-core';

/** Ways to enter a giveaway. New platforms get added here. */
export const ENTRY_METHODS = ['discord', 'instagram'] as const;
export type EntryMethod = (typeof ENTRY_METHODS)[number];

/** One entry-form field. Discord forms allow up to 5. */
export type FormField = {
  id: string;
  label: string;
  type: 'ig_username' | 'short_text' | 'long_text' | 'select';
  required: boolean;
  placeholder?: string | undefined;
  options?: string[] | undefined;
};

/** Which Discord updates a giveaway posts in #community-updates. Missing values use the defaults. */
export type AnnouncementSettings = {
  /** Master switch. Test-mode giveaways never post, whatever this says. */
  enabled?: boolean | undefined;
  started?: boolean | undefined;
  closed?: boolean | undefined;
  extended?: boolean | undefined;
  milestones?: { enabled: boolean; every: number } | undefined;
  capacity?: { enabled: boolean; percents: number[] } | undefined;
  countdown?: { enabled: boolean; hours: number[] } | undefined;
  /** @deprecated v1 shape, still read for old rows. */
  milestoneEvery?: number | undefined;
  /** @deprecated v1 shape, still read for old rows. */
  countdownHours?: number[] | undefined;
};

/**
 * A giveaway campaign. Its status is derived, never stored: scheduled before starts_at,
 * open until ends_at / closed_at / the participant cap, closed after.
 */
export const giveaways = pgTable('giveaways', {
  id: serial('id').primaryKey(),
  slug: text('slug').notNull().unique(),
  name: text('name'),
  startsAt: timestamp('starts_at', { withTimezone: true }),
  // Column keeps its original name; it's the giveaway's end time.
  endsAt: timestamp('closes_at', { withTimezone: true }).notNull(),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  closeReason: text('close_reason'),
  // How people can enter (one or more): discord = /giveaway enter; instagram = first counted Instagram action.
  entryMethods: text('entry_methods').array().$type<EntryMethod[]>().notNull().default(sql`ARRAY['discord']::text[]`),
  entryChannel: text('entry_channel'),
  formFields: jsonb('form_fields').$type<FormField[]>().notNull().default([]),
  reminderText: text('reminder_text'),
  maxParticipants: integer('max_participants'),
  announcements: jsonb('announcements').$type<AnnouncementSettings>().notNull().default({ enabled: true }),
  testMode: boolean('test_mode').notNull().default(false),
  // Winners: how many, how they're picked (auto = random weighted by entries, manual = admins pick)
  // and notified (auto = DM with Accept/Decline after a delay, manual = admins reach out and report).
  winnerCount: integer('winner_count').notNull().default(1),
  winnerSelect: text('winner_select').$type<'auto' | 'manual'>().notNull().default('manual'),
  winnerNotify: text('winner_notify').$type<'auto' | 'manual'>().notNull().default('manual'),
  notifyDelayMinutes: integer('notify_delay_minutes').notNull().default(30),
  winnerMessage: text('winner_message'),
  claimHours: integer('claim_hours').notNull().default(12),
  // The giveaway's Instagram post, set from a link in the dashboard.
  igMediaId: text('ig_media_id'),
  igPostedAt: timestamp('ig_posted_at', { withTimezone: true }),
  igPermalink: text('ig_permalink'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type RuleAction = 'ig_comment' | 'ig_story' | 'ig_tag';
export type RuleOptions = {
  /** ig_comment: must @mention someone other than us or the commenter. */
  requireTag?: boolean | undefined;
  /** ig_tag: the post's caption must contain this text (e.g. a hashtag), case-insensitive. */
  captionIncludes?: string | undefined;
};

/**
 * How many times an action earns an entry. Optional time window and frequency.
 * An action is counted under the most specific rule that still has room.
 */
export const giveawayRules = pgTable(
  'giveaway_rules',
  {
    id: serial('id').primaryKey(),
    giveawayId: integer('giveaway_id').notNull().references(() => giveaways.id, { onDelete: 'cascade' }),
    position: integer('position').notNull().default(0),
    action: text('action').$type<RuleAction>().notNull(),
    maxCount: integer('max_count').notNull(),
    windowStart: timestamp('window_start', { withTimezone: true }),
    windowEnd: timestamp('window_end', { withTimezone: true }),
    frequency: text('frequency').$type<'day' | 'week'>(),
    options: jsonb('options').$type<RuleOptions>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  t => [index('giveaway_rules_giveaway_idx').on(t.giveawayId)],
);

/** One row per person. A Discord entry is worth 1 base entry; Instagram-only entrants start at 0 plus their actions. */
export const entrants = pgTable(
  'entrants',
  {
    id: serial('id').primaryKey(),
    giveawayId: integer('giveaway_id').notNull().references(() => giveaways.id),
    // Null for people who entered through Instagram only.
    discordId: text('discord_id'),
    discordUsername: text('discord_username'),
    // Null in Discord-only giveaways.
    igUsername: text('ig_username'),
    answers: jsonb('answers').$type<Record<string, string>>().notNull().default({}),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedBy: text('revoked_by'),
    revokedReason: text('revoked_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  t => [
    uniqueIndex('entrants_giveaway_discord_uq').on(t.giveawayId, t.discordId),
    uniqueIndex('entrants_giveaway_ig_uq').on(t.giveawayId, t.igUsername),
  ],
);

export const bonusSource = pgEnum('bonus_source', ['admin', 'ig_api', 'ig_webhook', 'posh']);

/**
 * Extra entries earned beyond the base entry. Instagram ones are keyed by IG username,
 * not entrant, so one that arrives before someone enters ("unmatched") attaches
 * automatically once they do. Manual ones are given to an entrant directly.
 */
export const bonuses = pgTable(
  'bonuses',
  {
    id: serial('id').primaryKey(),
    giveawayId: integer('giveaway_id').notNull().references(() => giveaways.id),
    action: text('action').$type<RuleAction | 'manual'>(),
    ruleId: integer('rule_id').references(() => giveawayRules.id, { onDelete: 'set null' }),
    entrantId: integer('entrant_id').references(() => entrants.id),
    label: text('label'),
    igUsername: text('ig_username'),
    source: bonusSource('source').notNull(),
    sourceRef: text('source_ref'),
    createdBy: text('created_by'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedBy: text('revoked_by'),
    revokedReason: text('revoked_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  t => [
    // The same comment or Story mention can only ever count once.
    uniqueIndex('bonuses_giveaway_action_ref_uq').on(t.giveawayId, t.action, t.sourceRef),
    index('bonuses_giveaway_ig_idx').on(t.giveawayId, t.igUsername),
  ],
);

export type WinnerStatus = 'pending' | 'notified' | 'unreachable' | 'accepted' | 'declined' | 'expired';

/**
 * Every winner picked, in order, with what happened. Declined and expired winners stay
 * here (their entries are disqualified) so the history shows the whole story.
 *   pending → (DM sent) notified → accepted | declined | expired
 *   pending → (DM failed) unreachable → accepted | declined   (admins report)
 *   pending (manual notify) → accepted | declined             (admins report)
 */
export const winners = pgTable(
  'winners',
  {
    id: serial('id').primaryKey(),
    giveawayId: integer('giveaway_id').notNull().references(() => giveaways.id, { onDelete: 'cascade' }),
    entrantId: integer('entrant_id').notNull().references(() => entrants.id, { onDelete: 'cascade' }),
    status: text('status').$type<WinnerStatus>().notNull().default('pending'),
    selectedBy: text('selected_by').notNull(),
    entriesAtDraw: integer('entries_at_draw').notNull(),
    notifyAt: timestamp('notify_at', { withTimezone: true }),
    notifiedAt: timestamp('notified_at', { withTimezone: true }),
    claimDeadline: timestamp('claim_deadline', { withTimezone: true }),
    respondedAt: timestamp('responded_at', { withTimezone: true }),
    outcomeBy: text('outcome_by'),
    dmChannelId: text('dm_channel_id'),
    dmMessageId: text('dm_message_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  t => [index('winners_giveaway_idx').on(t.giveawayId), uniqueIndex('winners_giveaway_entrant_uq').on(t.giveawayId, t.entrantId)],
);

/** Discord alerts already sent, so restarts never repeat one. */
export const announcementsSent = pgTable(
  'announcements_sent',
  {
    id: serial('id').primaryKey(),
    giveawayId: integer('giveaway_id').notNull().references(() => giveaways.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    key: text('key').notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
  },
  t => [uniqueIndex('announcements_sent_uq').on(t.giveawayId, t.kind, t.key)],
);

/** Small key-value store, e.g. the auto-renewed Instagram token. */
export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const auditLog = pgTable(
  'audit_log',
  {
    id: serial('id').primaryKey(),
    giveawayId: integer('giveaway_id').references(() => giveaways.id),
    actorId: text('actor_id').notNull(),
    action: text('action').notNull(),
    details: jsonb('details').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  t => [index('audit_log_giveaway_idx').on(t.giveawayId, t.createdAt)],
);

/**
 * Every inbound webhook (Instagram, later Posh), stored raw before any
 * processing so nothing is lost if handling code fails or doesn't exist yet.
 */
export const webhookEvents = pgTable(
  'webhook_events',
  {
    id: serial('id').primaryKey(),
    source: text('source').notNull(),
    payload: jsonb('payload').notNull(),
    signatureValid: boolean('signature_valid').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
  },
  t => [index('webhook_events_unprocessed_idx').on(t.source, t.processedAt)],
);

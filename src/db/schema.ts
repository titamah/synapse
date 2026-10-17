import { boolean, pgEnum, pgTable, serial, text, timestamp, integer, jsonb, uniqueIndex, index } from 'drizzle-orm/pg-core';

/** One entry-form field. Discord forms allow up to 5. */
export type FormField = {
  id: string;
  label: string;
  type: 'ig_username' | 'short_text' | 'long_text' | 'select';
  required: boolean;
  placeholder?: string;
  options?: string[];
};

export type AnnouncementSettings = {
  enabled: boolean;
  milestoneEvery?: number;
  countdownHours?: number[];
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
  entryChannel: text('entry_channel'),
  igHashtag: text('ig_hashtag'),
  formFields: jsonb('form_fields').$type<FormField[]>().notNull().default([]),
  reminderText: text('reminder_text'),
  maxParticipants: integer('max_participants'),
  announcements: jsonb('announcements').$type<AnnouncementSettings>().notNull().default({ enabled: true }),
  testMode: boolean('test_mode').notNull().default(false),
  winnerNotify: text('winner_notify').notNull().default('manual'),
  claimHours: integer('claim_hours').notNull().default(12),
  winnerEntrantId: integer('winner_entrant_id'),
  winnerRecordedBy: text('winner_recorded_by'),
  winnerRecordedAt: timestamp('winner_recorded_at', { withTimezone: true }),
  // The giveaway's Instagram post, found automatically by its caption hashtag.
  igMediaId: text('ig_media_id'),
  igPostedAt: timestamp('ig_posted_at', { withTimezone: true }),
  // Unused legacy columns, removed in a later cleanup migration.
  channelId: text('channel_id'),
  messageId: text('message_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type RuleAction = 'ig_comment' | 'ig_story';
export type RuleOptions = { requireTag?: boolean };

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

/** One row per person: the base entry. */
export const entrants = pgTable(
  'entrants',
  {
    id: serial('id').primaryKey(),
    giveawayId: integer('giveaway_id').notNull().references(() => giveaways.id),
    discordId: text('discord_id').notNull(),
    discordUsername: text('discord_username').notNull(),
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

export const bonusType = pgEnum('bonus_type', ['COMMENT', 'STORY', 'IRL']);
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
    // Legacy fixed type (COMMENT/STORY/IRL), superseded by action + rule_id.
    type: bonusType('type'),
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

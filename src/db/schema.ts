import { boolean, pgTable, serial, text, timestamp, integer, jsonb, uniqueIndex, index } from 'drizzle-orm/pg-core';

/** Platforms a giveaway can run on. New platforms get added here. */
export const PLATFORMS = ['discord', 'instagram'] as const;
export type Platform = (typeof PLATFORMS)[number];
/** Platforms people have a username on (everything except Discord, which is the entry form itself). */
export type AccountPlatform = Exclude<Platform, 'discord'>;

/** One entry-form field. Discord forms allow up to 5. */
export type FormField = {
  id: string;
  label: string;
  /** account = a username on another platform; ig_username is the v1 name for an Instagram account field. */
  type: 'account' | 'short_text' | 'long_text' | 'select' | 'ig_username';
  required: boolean;
  placeholder?: string | undefined;
  options?: string[] | undefined;
  /** account fields: which platform(s) the username is for. */
  platforms?: AccountPlatform[] | undefined;
  /** Added by Synapse because a platform requires it; clients shouldn't remove it. */
  locked?: boolean | undefined;
};

/** Per-platform settings on a giveaway. A platform is "on" when the giveaway has rules for it. */
export type PlatformSettings = {
  discord?: { channel: string | null } | undefined;
  instagram?: {
    posts: { id: string; permalink: string; postedAt: string }[];
    autoIncludeHashtag?: string | null | undefined;
  } | undefined;
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
  // Entries for being eligible (meeting every required rule).
  baseWeight: integer('base_weight').notNull().default(1),
  // Discord channel, Instagram posts, etc. (see PlatformSettings).
  platformSettings: jsonb('platform_settings').$type<PlatformSettings>().notNull().default({}),
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
  // Numbers kept after personal data is deleted (see GiveawayStats). Refreshed until then.
  stats: jsonb('stats').$type<GiveawayStats>(),
  // Set when people, activity and per-person audit were deleted (90 days after the end).
  personalDataDeletedAt: timestamp('personal_data_deleted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Snapshot of a giveaway's numbers; survives the 90-day deletion of personal data. */
export type GiveawayStats = {
  takenAt: string;
  entrants: number;
  eligible: number;
  entries: number;
  byRule: { ruleId: number; description: string; people: number; actions: number; entries: number }[];
  byPlatform: Partial<Record<Platform, number>>;
};

/** Actions per platform. follow is manual (an admin confirms it); the rest are detected. */
export const ACTIONS = {
  discord: ['enter', 'member'],
  instagram: ['follow', 'comment', 'story', 'tag'],
} as const satisfies Record<Platform, readonly string[]>;
export type DiscordAction = (typeof ACTIONS)['discord'][number];
export type InstagramAction = (typeof ACTIONS)['instagram'][number];
export type RuleAction = DiscordAction | InstagramAction;
export const MANUAL_ACTIONS: readonly RuleAction[] = ['follow'];

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
    platform: text('platform').$type<Platform>().notNull().default('instagram'),
    action: text('action').$type<RuleAction>().notNull(),
    // required = needed to be eligible (part of the base entry); bonus = adds weight entries per action.
    type: text('type').$type<'required' | 'bonus'>().notNull().default('bonus'),
    weight: integer('weight').notNull().default(1),
    // required: times it must be done (reserved; dashboards can hide it).
    min: integer('min').notNull().default(1),
    // manual actions: confirm for the winner only, or for everyone.
    check: text('check').$type<'winners' | 'everyone'>(),
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

export type WinnerStatus = 'checking' | 'pending' | 'notified' | 'unreachable' | 'accepted' | 'declined' | 'expired';

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
    // null once personal data is deleted; `person` keeps who won (for 1 year, then anonymized).
    entrantId: integer('entrant_id').references(() => entrants.id, { onDelete: 'set null' }),
    person: jsonb('person').$type<{ discordId: string | null; discordUsername: string | null; igUsername: string | null }>(),
    anonymizedAt: timestamp('anonymized_at', { withTimezone: true }),
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
    // Manual winner checks (e.g. follows): one entry per rule, confirmed true/false or null while waiting.
    checks: jsonb('checks').$type<{ ruleId: number; label: string; confirmed: boolean | null; by?: string; at?: string }[]>().notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  t => [index('winners_giveaway_idx').on(t.giveawayId), uniqueIndex('winners_giveaway_entrant_uq').on(t.giveawayId, t.entrantId)],
);

/**
 * Every action anyone does in a giveaway, from any platform, in any order: the source of truth.
 * Eligibility and entries are calculated from this (never stored), so rule changes are retroactive.
 * A person is matched by Discord ID and/or account username.
 */
export const activities = pgTable(
  'activities',
  {
    id: serial('id').primaryKey(),
    giveawayId: integer('giveaway_id').notNull().references(() => giveaways.id, { onDelete: 'cascade' }),
    platform: text('platform').$type<Platform>().notNull(),
    action: text('action').$type<RuleAction>().notNull(),
    discordId: text('discord_id'),
    igUsername: text('ig_username'),
    // The comment / Story / post ID (or Discord user ID for enter), so nothing counts twice.
    sourceRef: text('source_ref').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull(),
    // e.g. { taggedFriend, caption, mediaId, permalink }
    details: jsonb('details').$type<Record<string, unknown>>().notNull().default({}),
    // Deleted or hidden on the platform: no longer counts.
    removedAt: timestamp('removed_at', { withTimezone: true }),
    removedReason: text('removed_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  t => [
    uniqueIndex('activities_source_uq').on(t.giveawayId, t.platform, t.action, t.sourceRef),
    index('activities_giveaway_ig_idx').on(t.giveawayId, t.igUsername),
    index('activities_giveaway_discord_idx').on(t.giveawayId, t.discordId),
  ],
);

/**
 * Admin decisions about one person: "count this requirement as met" (grandfathering, or
 * confirming a manual check like follows) and manual entries. Logged with who and why.
 */
export const overrides = pgTable(
  'overrides',
  {
    id: serial('id').primaryKey(),
    giveawayId: integer('giveaway_id').notNull().references(() => giveaways.id, { onDelete: 'cascade' }),
    entrantId: integer('entrant_id').notNull().references(() => entrants.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<'requirement_met' | 'manual_entry'>().notNull(),
    ruleId: integer('rule_id').references(() => giveawayRules.id, { onDelete: 'cascade' }),
    label: text('label'),
    weight: integer('weight').notNull().default(1),
    reason: text('reason'),
    createdBy: text('created_by').notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedBy: text('revoked_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  t => [index('overrides_giveaway_entrant_idx').on(t.giveawayId, t.entrantId)],
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

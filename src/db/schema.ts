import { pgEnum, pgTable, serial, text, timestamp, integer, jsonb, uniqueIndex, index } from 'drizzle-orm/pg-core';

export const giveaways = pgTable('giveaways', {
  id: serial('id').primaryKey(),
  slug: text('slug').notNull().unique(),
  channelId: text('channel_id'),
  messageId: text('message_id'),
  closesAt: timestamp('closes_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** One row per person: the base entry. */
export const entrants = pgTable(
  'entrants',
  {
    id: serial('id').primaryKey(),
    giveawayId: integer('giveaway_id').notNull().references(() => giveaways.id),
    discordId: text('discord_id').notNull(),
    discordUsername: text('discord_username').notNull(),
    igUsername: text('ig_username').notNull(),
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
 * Bonuses are keyed by IG username, not entrant, so a bonus that arrives before
 * someone enters ("unmatched") attaches automatically once they do.
 */
export const bonuses = pgTable(
  'bonuses',
  {
    id: serial('id').primaryKey(),
    giveawayId: integer('giveaway_id').notNull().references(() => giveaways.id),
    igUsername: text('ig_username').notNull(),
    type: bonusType('type').notNull(),
    source: bonusSource('source').notNull(),
    sourceRef: text('source_ref'),
    createdBy: text('created_by'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedBy: text('revoked_by'),
    revokedReason: text('revoked_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // Max 1 of each bonus type per IG account.
  t => [uniqueIndex('bonuses_giveaway_ig_type_uq').on(t.giveawayId, t.igUsername, t.type)],
);

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

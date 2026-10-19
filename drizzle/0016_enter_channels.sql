-- The Discord entry channel moves from the giveaway (platform_settings.discord.channel) onto its
-- enter rules (options.channel). platform_settings.discord keeps a derived list of entry channels.
UPDATE "giveaway_rules" r
SET "options" = r."options" || jsonb_build_object('channel', g."platform_settings"->'discord'->>'channel')
FROM "giveaways" g
WHERE r."giveaway_id" = g."id" AND r."platform" = 'discord' AND r."action" = 'enter'
  AND COALESCE(g."platform_settings"->'discord'->>'channel', '') <> '' AND NOT (r."options" ? 'channel');
--> statement-breakpoint
-- Past entries record the channel, one "enter" per person per channel.
UPDATE "activities" a
SET "details" = a."details" || jsonb_build_object('channel', g."platform_settings"->'discord'->>'channel'),
    "source_ref" = a."source_ref" || ':' || (g."platform_settings"->'discord'->>'channel')
FROM "giveaways" g
WHERE a."giveaway_id" = g."id" AND a."platform" = 'discord' AND a."action" = 'enter'
  AND COALESCE(g."platform_settings"->'discord'->>'channel', '') <> '' AND NOT (a."details" ? 'channel');
--> statement-breakpoint
UPDATE "giveaways" g
SET "platform_settings" = jsonb_set(g."platform_settings", '{discord}', jsonb_build_object('channels',
  COALESCE((SELECT jsonb_agg(r."options"->>'channel' ORDER BY r."position") FROM "giveaway_rules" r
            WHERE r."giveaway_id" = g."id" AND r."platform" = 'discord' AND r."action" = 'enter' AND r."options" ? 'channel'), '[]'::jsonb)))
WHERE g."platform_settings" ? 'discord';

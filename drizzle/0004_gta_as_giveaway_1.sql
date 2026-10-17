-- Turn the original hardcoded GTA VI giveaway into giveaway #1 with configurable settings and rules.
-- Safe on a fresh database: every statement only touches the 'gta6-2026' row if it exists.
UPDATE "giveaways" SET
  "name" = 'GTA VI Giveaway',
  "starts_at" = COALESCE("starts_at", '2026-10-19T00:00:00-04:00'),
  "entry_channel" = 'gta-giveaway',
  "ig_hashtag" = '#BBxGTAVI',
  "form_fields" = '[{"id":"ig","label":"Instagram username","type":"ig_username","required":true,"placeholder":"yourusername"}]'::jsonb,
  "reminder_text" = 'Don''t forget to follow [@BostonBlerds](https://instagram.com/bostonblerds) on Instagram!',
  "updated_at" = now()
WHERE "slug" = 'gta6-2026';
--> statement-breakpoint
INSERT INTO "giveaway_rules" ("giveaway_id", "position", "action", "max_count", "options")
SELECT "id", 1, 'ig_comment', 1, '{"requireTag":true}'::jsonb FROM "giveaways" WHERE "slug" = 'gta6-2026';
--> statement-breakpoint
INSERT INTO "giveaway_rules" ("giveaway_id", "position", "action", "max_count", "options")
SELECT "id", 2, 'ig_story', 1, '{}'::jsonb FROM "giveaways" WHERE "slug" = 'gta6-2026';
--> statement-breakpoint
-- Existing bonuses: map the old fixed type onto actions and rules.
UPDATE "bonuses" SET
  "action" = CASE "type" WHEN 'COMMENT' THEN 'ig_comment' WHEN 'STORY' THEN 'ig_story' ELSE 'manual' END,
  "label" = CASE "type" WHEN 'IRL' THEN 'In-person' ELSE NULL END
WHERE "action" IS NULL;
--> statement-breakpoint
UPDATE "bonuses" b SET "rule_id" = r."id"
FROM "giveaway_rules" r
WHERE r."giveaway_id" = b."giveaway_id" AND r."action" = b."action" AND b."rule_id" IS NULL;
--> statement-breakpoint
UPDATE "bonuses" b SET "entrant_id" = e."id"
FROM "entrants" e
WHERE b."action" = 'manual' AND b."entrant_id" IS NULL AND e."giveaway_id" = b."giveaway_id" AND e."ig_username" = b."ig_username";

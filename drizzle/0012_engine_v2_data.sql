-- Engine v2 data migration: v1 entry methods + flat rules + bonuses → platforms, required/bonus rules and the activity log.

-- 1. Rule actions get platform-neutral names; existing rules are Instagram bonuses.
UPDATE "giveaway_rules" SET "platform" = 'instagram', "type" = 'bonus',
  "action" = CASE "action" WHEN 'ig_comment' THEN 'comment' WHEN 'ig_story' THEN 'story' WHEN 'ig_tag' THEN 'tag' ELSE "action" END;
--> statement-breakpoint
-- 2. Discord rules from entry methods.
--    Discord only        → enter required + member required (v1 always required being in the server)
--    Discord + Instagram → enter as a bonus, nothing required (v1 meant "either one")
INSERT INTO "giveaway_rules" ("giveaway_id", "position", "platform", "action", "type", "weight", "min", "max_count")
SELECT "id", -1, 'discord', 'enter', CASE WHEN 'instagram' = ANY("entry_methods") THEN 'bonus' ELSE 'required' END, 1, 1, 1
FROM "giveaways" WHERE 'discord' = ANY("entry_methods");
--> statement-breakpoint
INSERT INTO "giveaway_rules" ("giveaway_id", "position", "platform", "action", "type", "weight", "min", "max_count")
SELECT "id", 0, 'discord', 'member', 'required', 1, 1, 1
FROM "giveaways" WHERE 'discord' = ANY("entry_methods") AND NOT ('instagram' = ANY("entry_methods"));
--> statement-breakpoint
--    Instagram only → its first Instagram rule becomes the requirement.
UPDATE "giveaway_rules" r SET "type" = 'required'
FROM (
  SELECT DISTINCT ON (r2."giveaway_id") r2."id"
  FROM "giveaway_rules" r2 JOIN "giveaways" g ON g."id" = r2."giveaway_id"
  WHERE g."entry_methods" = ARRAY['instagram']::text[] AND r2."platform" = 'instagram'
  ORDER BY r2."giveaway_id", r2."position", r2."id"
) first_rule
WHERE r."id" = first_rule."id";
--> statement-breakpoint
-- 3. Platform settings: Discord channel and the Instagram post.
UPDATE "giveaways" SET "platform_settings" = jsonb_strip_nulls(jsonb_build_object(
  'discord', CASE WHEN 'discord' = ANY("entry_methods") THEN jsonb_build_object('channel', "entry_channel") END,
  'instagram', CASE WHEN "ig_media_id" IS NOT NULL OR EXISTS (SELECT 1 FROM "giveaway_rules" r WHERE r."giveaway_id" = "giveaways"."id" AND r."platform" = 'instagram')
    THEN jsonb_build_object('posts', CASE WHEN "ig_media_id" IS NOT NULL
      THEN jsonb_build_array(jsonb_build_object('id', "ig_media_id", 'permalink', COALESCE("ig_permalink", ''), 'postedAt', to_char("ig_posted_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')))
      ELSE '[]'::jsonb END) END
));
--> statement-breakpoint
-- 4. Form: the v1 Instagram username field becomes a locked account field.
UPDATE "giveaways" SET "form_fields" = (
  SELECT COALESCE(jsonb_agg(CASE WHEN f->>'type' = 'ig_username'
    THEN (f - 'type') || '{"type": "account", "platforms": ["instagram"], "locked": true}'::jsonb ELSE f END), '[]'::jsonb)
  FROM jsonb_array_elements("form_fields") f
);
--> statement-breakpoint
-- 5. Activity log from what v1 recorded: Discord entries, and Instagram bonuses (removed ones stay removed).
INSERT INTO "activities" ("giveaway_id", "platform", "action", "discord_id", "ig_username", "source_ref", "at", "details")
SELECT "giveaway_id", 'discord', 'enter', "discord_id", "ig_username", "discord_id", "created_at", '{"migrated": true}'::jsonb
FROM "entrants" WHERE "discord_id" IS NOT NULL
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "activities" ("giveaway_id", "platform", "action", "ig_username", "source_ref", "at", "details", "removed_at", "removed_reason")
SELECT b."giveaway_id", 'instagram',
  CASE b."action" WHEN 'ig_comment' THEN 'comment' WHEN 'ig_story' THEN 'story' ELSE 'tag' END,
  b."ig_username", COALESCE(b."source_ref", 'legacy-' || b."id"), b."created_at", '{"migrated": true}'::jsonb,
  b."revoked_at", b."revoked_reason"
FROM "bonuses" b
WHERE b."action" IN ('ig_comment', 'ig_story', 'ig_tag') AND b."ig_username" IS NOT NULL
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- 6. Manual bonus entries become overrides.
INSERT INTO "overrides" ("giveaway_id", "entrant_id", "kind", "label", "weight", "created_by", "revoked_at", "revoked_by", "created_at")
SELECT b."giveaway_id", b."entrant_id", 'manual_entry', b."label", 1, COALESCE(b."created_by", 'migrated'), b."revoked_at", b."revoked_by", b."created_at"
FROM "bonuses" b WHERE b."action" = 'manual' AND b."entrant_id" IS NOT NULL;

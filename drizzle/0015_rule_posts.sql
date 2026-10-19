-- Posts move from the giveaway (platform_settings.instagram.posts) onto comment rules (options.post).
-- v1 had one post for the whole giveaway, so the first (earliest) post goes on every comment rule.
UPDATE "giveaway_rules" r
SET "options" = r."options" || jsonb_build_object('post', p.post)
FROM (
  SELECT g."id" AS giveaway_id,
         (SELECT x FROM jsonb_array_elements(g."platform_settings"->'instagram'->'posts') x ORDER BY x->>'postedAt' LIMIT 1) AS post
  FROM "giveaways" g
  WHERE jsonb_array_length(COALESCE(g."platform_settings"->'instagram'->'posts', '[]'::jsonb)) > 0
) p
WHERE r."giveaway_id" = p.giveaway_id AND r."platform" = 'instagram' AND r."action" = 'comment' AND NOT (r."options" ? 'post');
--> statement-breakpoint
UPDATE "giveaways" SET "platform_settings" = jsonb_set("platform_settings", '{instagram}', '{}'::jsonb) WHERE "platform_settings" ? 'instagram';

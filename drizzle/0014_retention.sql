ALTER TABLE "winners" DROP CONSTRAINT "winners_entrant_id_entrants_id_fk";
--> statement-breakpoint
ALTER TABLE "winners" ALTER COLUMN "entrant_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "giveaways" ADD COLUMN "stats" jsonb;--> statement-breakpoint
ALTER TABLE "giveaways" ADD COLUMN "personal_data_deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "winners" ADD COLUMN "person" jsonb;--> statement-breakpoint
ALTER TABLE "winners" ADD COLUMN "anonymized_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "winners" ADD CONSTRAINT "winners_entrant_id_entrants_id_fk" FOREIGN KEY ("entrant_id") REFERENCES "public"."entrants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
UPDATE "winners" w SET "person" = jsonb_build_object('discordId', e."discord_id", 'discordUsername', e."discord_username", 'igUsername', e."ig_username") FROM "entrants" e WHERE e."id" = w."entrant_id" AND w."person" IS NULL;

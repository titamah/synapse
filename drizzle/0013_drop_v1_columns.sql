DROP TABLE "bonuses" CASCADE;--> statement-breakpoint
ALTER TABLE "giveaways" DROP COLUMN "entry_methods";--> statement-breakpoint
ALTER TABLE "giveaways" DROP COLUMN "entry_channel";--> statement-breakpoint
ALTER TABLE "giveaways" DROP COLUMN "ig_media_id";--> statement-breakpoint
ALTER TABLE "giveaways" DROP COLUMN "ig_posted_at";--> statement-breakpoint
ALTER TABLE "giveaways" DROP COLUMN "ig_permalink";--> statement-breakpoint
DROP TYPE "public"."bonus_source";
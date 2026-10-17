ALTER TABLE "bonuses" DROP COLUMN "type";--> statement-breakpoint
ALTER TABLE "giveaways" DROP COLUMN "ig_hashtag";--> statement-breakpoint
ALTER TABLE "giveaways" DROP COLUMN "winner_entrant_id";--> statement-breakpoint
ALTER TABLE "giveaways" DROP COLUMN "winner_recorded_by";--> statement-breakpoint
ALTER TABLE "giveaways" DROP COLUMN "winner_recorded_at";--> statement-breakpoint
ALTER TABLE "giveaways" DROP COLUMN "channel_id";--> statement-breakpoint
ALTER TABLE "giveaways" DROP COLUMN "message_id";--> statement-breakpoint
DROP TYPE "public"."bonus_type";
ALTER TABLE "entrants" ALTER COLUMN "discord_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "entrants" ALTER COLUMN "discord_username" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "giveaways" ADD COLUMN "entry_method" text DEFAULT 'discord' NOT NULL;
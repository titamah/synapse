CREATE TABLE "winners" (
	"id" serial PRIMARY KEY NOT NULL,
	"giveaway_id" integer NOT NULL,
	"entrant_id" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"selected_by" text NOT NULL,
	"entries_at_draw" integer NOT NULL,
	"notify_at" timestamp with time zone,
	"notified_at" timestamp with time zone,
	"claim_deadline" timestamp with time zone,
	"responded_at" timestamp with time zone,
	"outcome_by" text,
	"dm_channel_id" text,
	"dm_message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "giveaways" ADD COLUMN "winner_count" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "giveaways" ADD COLUMN "winner_select" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "giveaways" ADD COLUMN "notify_delay_minutes" integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "giveaways" ADD COLUMN "winner_message" text;--> statement-breakpoint
ALTER TABLE "winners" ADD CONSTRAINT "winners_giveaway_id_giveaways_id_fk" FOREIGN KEY ("giveaway_id") REFERENCES "public"."giveaways"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "winners" ADD CONSTRAINT "winners_entrant_id_entrants_id_fk" FOREIGN KEY ("entrant_id") REFERENCES "public"."entrants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "winners_giveaway_idx" ON "winners" USING btree ("giveaway_id");--> statement-breakpoint
CREATE UNIQUE INDEX "winners_giveaway_entrant_uq" ON "winners" USING btree ("giveaway_id","entrant_id");
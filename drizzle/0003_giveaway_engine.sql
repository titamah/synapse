CREATE TABLE "announcements_sent" (
	"id" serial PRIMARY KEY NOT NULL,
	"giveaway_id" integer NOT NULL,
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "giveaway_rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"giveaway_id" integer NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"action" text NOT NULL,
	"max_count" integer NOT NULL,
	"window_start" timestamp with time zone,
	"window_end" timestamp with time zone,
	"frequency" text,
	"options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "bonuses_giveaway_ig_type_uq";--> statement-breakpoint
ALTER TABLE "bonuses" ALTER COLUMN "ig_username" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "bonuses" ALTER COLUMN "type" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "entrants" ALTER COLUMN "ig_username" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "bonuses" ADD COLUMN "action" text;--> statement-breakpoint
ALTER TABLE "bonuses" ADD COLUMN "rule_id" integer;--> statement-breakpoint
ALTER TABLE "bonuses" ADD COLUMN "entrant_id" integer;--> statement-breakpoint
ALTER TABLE "bonuses" ADD COLUMN "label" text;--> statement-breakpoint
ALTER TABLE "entrants" ADD COLUMN "answers" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "giveaways" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "giveaways" ADD COLUMN "starts_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "giveaways" ADD COLUMN "closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "giveaways" ADD COLUMN "close_reason" text;--> statement-breakpoint
ALTER TABLE "giveaways" ADD COLUMN "entry_channel" text;--> statement-breakpoint
ALTER TABLE "giveaways" ADD COLUMN "ig_hashtag" text;--> statement-breakpoint
ALTER TABLE "giveaways" ADD COLUMN "form_fields" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "giveaways" ADD COLUMN "reminder_text" text;--> statement-breakpoint
ALTER TABLE "giveaways" ADD COLUMN "max_participants" integer;--> statement-breakpoint
ALTER TABLE "giveaways" ADD COLUMN "announcements" jsonb DEFAULT '{"enabled":true}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "giveaways" ADD COLUMN "test_mode" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "giveaways" ADD COLUMN "winner_notify" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "giveaways" ADD COLUMN "claim_hours" integer DEFAULT 12 NOT NULL;--> statement-breakpoint
ALTER TABLE "giveaways" ADD COLUMN "winner_entrant_id" integer;--> statement-breakpoint
ALTER TABLE "giveaways" ADD COLUMN "winner_recorded_by" text;--> statement-breakpoint
ALTER TABLE "giveaways" ADD COLUMN "winner_recorded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "giveaways" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "announcements_sent" ADD CONSTRAINT "announcements_sent_giveaway_id_giveaways_id_fk" FOREIGN KEY ("giveaway_id") REFERENCES "public"."giveaways"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "giveaway_rules" ADD CONSTRAINT "giveaway_rules_giveaway_id_giveaways_id_fk" FOREIGN KEY ("giveaway_id") REFERENCES "public"."giveaways"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "announcements_sent_uq" ON "announcements_sent" USING btree ("giveaway_id","kind","key");--> statement-breakpoint
CREATE INDEX "giveaway_rules_giveaway_idx" ON "giveaway_rules" USING btree ("giveaway_id");--> statement-breakpoint
ALTER TABLE "bonuses" ADD CONSTRAINT "bonuses_rule_id_giveaway_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."giveaway_rules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bonuses" ADD CONSTRAINT "bonuses_entrant_id_entrants_id_fk" FOREIGN KEY ("entrant_id") REFERENCES "public"."entrants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bonuses_giveaway_action_ref_uq" ON "bonuses" USING btree ("giveaway_id","action","source_ref");--> statement-breakpoint
CREATE INDEX "bonuses_giveaway_ig_idx" ON "bonuses" USING btree ("giveaway_id","ig_username");
CREATE TABLE "activities" (
	"id" serial PRIMARY KEY NOT NULL,
	"giveaway_id" integer NOT NULL,
	"platform" text NOT NULL,
	"action" text NOT NULL,
	"discord_id" text,
	"ig_username" text,
	"source_ref" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"removed_at" timestamp with time zone,
	"removed_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "overrides" (
	"id" serial PRIMARY KEY NOT NULL,
	"giveaway_id" integer NOT NULL,
	"entrant_id" integer NOT NULL,
	"kind" text NOT NULL,
	"rule_id" integer,
	"label" text,
	"weight" integer DEFAULT 1 NOT NULL,
	"reason" text,
	"created_by" text NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "giveaway_rules" ADD COLUMN "platform" text DEFAULT 'instagram' NOT NULL;--> statement-breakpoint
ALTER TABLE "giveaway_rules" ADD COLUMN "type" text DEFAULT 'bonus' NOT NULL;--> statement-breakpoint
ALTER TABLE "giveaway_rules" ADD COLUMN "weight" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "giveaway_rules" ADD COLUMN "min" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "giveaway_rules" ADD COLUMN "check" text;--> statement-breakpoint
ALTER TABLE "giveaways" ADD COLUMN "base_weight" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "giveaways" ADD COLUMN "platform_settings" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "winners" ADD COLUMN "checks" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_giveaway_id_giveaways_id_fk" FOREIGN KEY ("giveaway_id") REFERENCES "public"."giveaways"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "overrides" ADD CONSTRAINT "overrides_giveaway_id_giveaways_id_fk" FOREIGN KEY ("giveaway_id") REFERENCES "public"."giveaways"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "overrides" ADD CONSTRAINT "overrides_entrant_id_entrants_id_fk" FOREIGN KEY ("entrant_id") REFERENCES "public"."entrants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "overrides" ADD CONSTRAINT "overrides_rule_id_giveaway_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."giveaway_rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "activities_source_uq" ON "activities" USING btree ("giveaway_id","platform","action","source_ref");--> statement-breakpoint
CREATE INDEX "activities_giveaway_ig_idx" ON "activities" USING btree ("giveaway_id","ig_username");--> statement-breakpoint
CREATE INDEX "activities_giveaway_discord_idx" ON "activities" USING btree ("giveaway_id","discord_id");--> statement-breakpoint
CREATE INDEX "overrides_giveaway_entrant_idx" ON "overrides" USING btree ("giveaway_id","entrant_id");
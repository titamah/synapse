CREATE TYPE "public"."bonus_source" AS ENUM('admin', 'ig_api', 'ig_webhook', 'posh');--> statement-breakpoint
CREATE TYPE "public"."bonus_type" AS ENUM('COMMENT', 'STORY', 'IRL');--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"giveaway_id" integer,
	"actor_id" text NOT NULL,
	"action" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bonuses" (
	"id" serial PRIMARY KEY NOT NULL,
	"giveaway_id" integer NOT NULL,
	"ig_username" text NOT NULL,
	"type" "bonus_type" NOT NULL,
	"source" "bonus_source" NOT NULL,
	"source_ref" text,
	"created_by" text,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	"revoked_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entrants" (
	"id" serial PRIMARY KEY NOT NULL,
	"giveaway_id" integer NOT NULL,
	"discord_id" text NOT NULL,
	"discord_username" text NOT NULL,
	"ig_username" text NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	"revoked_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "giveaways" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"channel_id" text,
	"message_id" text,
	"closes_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "giveaways_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_giveaway_id_giveaways_id_fk" FOREIGN KEY ("giveaway_id") REFERENCES "public"."giveaways"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bonuses" ADD CONSTRAINT "bonuses_giveaway_id_giveaways_id_fk" FOREIGN KEY ("giveaway_id") REFERENCES "public"."giveaways"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entrants" ADD CONSTRAINT "entrants_giveaway_id_giveaways_id_fk" FOREIGN KEY ("giveaway_id") REFERENCES "public"."giveaways"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_giveaway_idx" ON "audit_log" USING btree ("giveaway_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "bonuses_giveaway_ig_type_uq" ON "bonuses" USING btree ("giveaway_id","ig_username","type");--> statement-breakpoint
CREATE UNIQUE INDEX "entrants_giveaway_discord_uq" ON "entrants" USING btree ("giveaway_id","discord_id");--> statement-breakpoint
CREATE UNIQUE INDEX "entrants_giveaway_ig_uq" ON "entrants" USING btree ("giveaway_id","ig_username");
CREATE TABLE "flag_states" (
	"id" serial PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"giveaway_id" integer,
	"code" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"alerted_at" timestamp with time zone,
	"alert_channel_id" text,
	"alert_message_id" text,
	"snoozed_until" timestamp with time zone,
	"dismissed_at" timestamp with time zone,
	"acted_by" text,
	CONSTRAINT "flag_states_key_unique" UNIQUE("key")
);
--> statement-breakpoint
ALTER TABLE "flag_states" ADD CONSTRAINT "flag_states_giveaway_id_giveaways_id_fk" FOREIGN KEY ("giveaway_id") REFERENCES "public"."giveaways"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "flag_states_giveaway_idx" ON "flag_states" USING btree ("giveaway_id");
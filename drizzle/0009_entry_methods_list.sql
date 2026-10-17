ALTER TABLE "giveaways" ADD COLUMN "entry_methods" text[] DEFAULT ARRAY['discord']::text[] NOT NULL;--> statement-breakpoint
-- Carry over each giveaway's single entry method.
UPDATE "giveaways" SET "entry_methods" = CASE "entry_method"
  WHEN 'instagram' THEN ARRAY['instagram']::text[]
  WHEN 'either' THEN ARRAY['discord', 'instagram']::text[]
  ELSE ARRAY['discord']::text[]
END;

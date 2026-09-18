CREATE TABLE "companion_channels" (
	"channel_id" text PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"fleet" text DEFAULT 'prod' NOT NULL,
	"secondary_channel_id" text NOT NULL,
	"viewer_role_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "companion_channels_secondary_idx" ON "companion_channels" USING btree ("fleet","secondary_channel_id");--> statement-breakpoint
CREATE INDEX "companion_channels_guild_idx" ON "companion_channels" USING btree ("fleet","guild_id");
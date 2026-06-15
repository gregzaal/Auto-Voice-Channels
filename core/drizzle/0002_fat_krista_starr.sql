CREATE TABLE "join_channels" (
	"channel_id" text PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"secondary_channel_id" text NOT NULL,
	"request_channel_id" text NOT NULL,
	"creator_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "join_channels_secondary_idx" ON "join_channels" USING btree ("secondary_channel_id");
CREATE TABLE "member_room_prefs" (
	"primary_channel_id" text NOT NULL,
	"user_id" text NOT NULL,
	"guild_id" text NOT NULL,
	"name_template" text,
	"user_limit" smallint,
	"privacy" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "member_room_prefs_primary_channel_id_user_id_pk" PRIMARY KEY("primary_channel_id","user_id")
);
--> statement-breakpoint
CREATE INDEX "member_room_prefs_guild_idx" ON "member_room_prefs" USING btree ("guild_id");--> statement-breakpoint
CREATE INDEX "member_room_prefs_user_idx" ON "member_room_prefs" USING btree ("user_id");
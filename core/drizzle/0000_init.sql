CREATE TABLE "aliases" (
	"guild_id" text NOT NULL,
	"game_name" text NOT NULL,
	"alias" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "aliases_guild_id_game_name_pk" PRIMARY KEY("guild_id","game_name")
);
--> statement-breakpoint
CREATE TABLE "auto_channels" (
	"channel_id" text PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"template" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "guild_auth_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "guild_auth_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"guild_id" text NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"reason" text,
	"actor" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "guilds" (
	"guild_id" text PRIMARY KEY NOT NULL,
	"auth_status" text DEFAULT 'trial' NOT NULL,
	"auth_expires_at" timestamp with time zone,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops_audit" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ops_audit_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"target" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runtime_flags" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"description" text,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "secondary_channels" (
	"channel_id" text PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"primary_channel_id" text NOT NULL,
	"owner_id" text,
	"state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shard_leases" (
	"shard_id" integer PRIMARY KEY NOT NULL,
	"total_shards" integer NOT NULL,
	"instance_id" text,
	"heartbeat_at" timestamp with time zone,
	"claimed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "auto_channels_guild_idx" ON "auto_channels" USING btree ("guild_id");--> statement-breakpoint
CREATE INDEX "guild_auth_events_guild_idx" ON "guild_auth_events" USING btree ("guild_id","created_at");--> statement-breakpoint
CREATE INDEX "ops_audit_created_idx" ON "ops_audit" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "secondary_channels_guild_idx" ON "secondary_channels" USING btree ("guild_id");--> statement-breakpoint
CREATE INDEX "secondary_channels_primary_idx" ON "secondary_channels" USING btree ("primary_channel_id");--> statement-breakpoint
CREATE INDEX "shard_leases_instance_idx" ON "shard_leases" USING btree ("instance_id");
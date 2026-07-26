CREATE TABLE "ai_usage" (
	"guild_id" text NOT NULL,
	"month" text NOT NULL,
	"builds" integer DEFAULT 0 NOT NULL,
	"refunds" integer DEFAULT 0 NOT NULL,
	"prompt_tokens" bigint DEFAULT 0 NOT NULL,
	"completion_tokens" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_usage_guild_id_month_pk" PRIMARY KEY("guild_id","month")
);
--> statement-breakpoint
CREATE INDEX "ai_usage_month_idx" ON "ai_usage" USING btree ("month");
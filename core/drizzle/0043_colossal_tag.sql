CREATE TABLE "member_access_lists" (
	"guild_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"member_id" text NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "member_access_lists_guild_id_owner_id_member_id_pk" PRIMARY KEY("guild_id","owner_id","member_id")
);
--> statement-breakpoint
ALTER TABLE "secondary_channels" ADD COLUMN "access" jsonb;--> statement-breakpoint
CREATE INDEX "member_access_lists_member_idx" ON "member_access_lists" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "member_access_lists_owner_idx" ON "member_access_lists" USING btree ("owner_id","guild_id");
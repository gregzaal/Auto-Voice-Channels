CREATE TABLE "announcement_deliveries" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "announcement_deliveries_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"guild_id" text NOT NULL,
	"key" text NOT NULL,
	"touch" text NOT NULL,
	"target" text,
	"delivered_at" timestamp with time zone,
	"last_error" text,
	"opted_out" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "announcement_deliveries_guild_key_touch" ON "announcement_deliveries" USING btree ("guild_id","key","touch");--> statement-breakpoint
CREATE INDEX "announcement_deliveries_key_idx" ON "announcement_deliveries" USING btree ("key","touch");
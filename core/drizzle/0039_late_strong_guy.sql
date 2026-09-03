CREATE TABLE "costs_monthly" (
	"month" text PRIMARY KEY NOT NULL,
	"fly_cents" integer DEFAULT 0 NOT NULL,
	"postgres_cents" integer DEFAULT 0 NOT NULL,
	"model_spend_cents" integer DEFAULT 0 NOT NULL,
	"paddle_fees_cents" integer DEFAULT 0 NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

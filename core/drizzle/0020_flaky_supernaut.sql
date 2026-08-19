CREATE TABLE "metrics_daily" (
	"bucket" timestamp with time zone NOT NULL,
	"metric" text NOT NULL,
	"fleet" text DEFAULT 'prod' NOT NULL,
	"instance" text DEFAULT '' NOT NULL,
	"key" text DEFAULT '' NOT NULL,
	"value" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "metrics_daily_bucket_metric_fleet_instance_key_pk" PRIMARY KEY("bucket","metric","fleet","instance","key")
);
--> statement-breakpoint
CREATE TABLE "metrics_hourly" (
	"bucket" timestamp with time zone NOT NULL,
	"metric" text NOT NULL,
	"fleet" text DEFAULT 'prod' NOT NULL,
	"instance" text DEFAULT '' NOT NULL,
	"key" text DEFAULT '' NOT NULL,
	"value" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "metrics_hourly_bucket_metric_fleet_instance_key_pk" PRIMARY KEY("bucket","metric","fleet","instance","key")
);
--> statement-breakpoint
CREATE INDEX "metrics_daily_metric_idx" ON "metrics_daily" USING btree ("metric","bucket");--> statement-breakpoint
CREATE INDEX "metrics_hourly_metric_idx" ON "metrics_hourly" USING btree ("metric","bucket");
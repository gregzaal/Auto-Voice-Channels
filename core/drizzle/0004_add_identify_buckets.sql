CREATE TABLE "identify_buckets" (
	"bucket" integer PRIMARY KEY NOT NULL,
	"last_identify_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

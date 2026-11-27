-- Every night, what Zoho changed brought across (src/lib/zoho/nightly.ts).
ALTER TABLE "zoho_connections" ADD COLUMN "nightlyTopUp" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "zoho_connections" ADD COLUMN "nightlyTopUpById" TEXT;

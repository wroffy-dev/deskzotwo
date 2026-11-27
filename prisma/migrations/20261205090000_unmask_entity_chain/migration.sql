-- The unmask process (owner, 5 Nov 2026 — Phase 3 masking fixes, audit H.4.5, H.4.8, H.5, M-10, C.3.6;
-- src/lib/authz/unmask.ts). Expand-only and backfilled in place:
--
--   1. unmask_usage and unmask_events say what was revealed — "leads", "contacts" or "companies" and the record's
--      id — read from `leadId`, which keeps being written: `contact:<id>` is a contact, anything else a lead.
--      Usage is unique per person, day and record; a row that came with another record's reveal (a lead's contact)
--      says so in "includedWith" and uses no unit.
--   2. unmask_events gains the reason a person typed, and a hash chain: every row, the old ones too, gets its
--      place ("seq"), the previous row's hash and its own — sha256 of the previous hash and the row's canonical
--      JSON, the same text src/lib/authz/unmask.ts `canonicalEvent` writes for new rows.
--   3. The log can no longer be emptied with TRUNCATE either (the data reset keeps it now).
--   4. unmask_settings: the workspace's default daily limit, 25 when nothing is stored.

-- 1. What was revealed ---------------------------------------------------------------------------------------------
ALTER TABLE "unmask_usage" ADD COLUMN "entity" TEXT NOT NULL DEFAULT 'leads';
ALTER TABLE "unmask_usage" ADD COLUMN "recordId" TEXT;
ALTER TABLE "unmask_usage" ADD COLUMN "includedWith" TEXT;
UPDATE "unmask_usage"
   SET "entity"   = CASE WHEN "leadId" LIKE 'contact:%' THEN 'contacts' ELSE 'leads' END,
       "recordId" = CASE WHEN "leadId" LIKE 'contact:%' THEN substr("leadId", 9) ELSE "leadId" END;
ALTER TABLE "unmask_usage" ALTER COLUMN "recordId" SET NOT NULL;
ALTER TABLE "unmask_usage" ADD CONSTRAINT "unmask_usage_entity_known" CHECK ("entity" IN ('leads', 'contacts', 'companies'));
DROP INDEX IF EXISTS "unmask_usage_userId_businessDate_leadId_key";
CREATE UNIQUE INDEX "unmask_usage_userId_businessDate_entity_recordId_key" ON "unmask_usage"("userId", "businessDate", "entity", "recordId");

ALTER TABLE "unmask_events" ADD COLUMN "entity" TEXT NOT NULL DEFAULT 'leads';
ALTER TABLE "unmask_events" ADD COLUMN "recordId" TEXT;
ALTER TABLE "unmask_events" ADD COLUMN "statedReason" TEXT;
ALTER TABLE "unmask_events" ADD COLUMN "seq" INTEGER;
ALTER TABLE "unmask_events" ADD COLUMN "prevHash" TEXT;
ALTER TABLE "unmask_events" ADD COLUMN "hash" TEXT;

-- The log refuses UPDATE (20261110100000_field_access_unmask); the backfill is the one write it ever gets.
ALTER TABLE "unmask_events" DISABLE TRIGGER "unmask_events_append_only";

UPDATE "unmask_events"
   SET "entity"   = CASE WHEN "leadId" LIKE 'contact:%' THEN 'contacts' ELSE 'leads' END,
       "recordId" = CASE WHEN "leadId" LIKE 'contact:%' THEN substr("leadId", 9) ELSE "leadId" END;

-- 2. The chain over the rows already there, oldest first.
WITH ordered AS (SELECT "id", row_number() OVER (ORDER BY "at", "id") AS n FROM "unmask_events")
UPDATE "unmask_events" e SET "seq" = o.n FROM ordered o WHERE o."id" = e."id";

DO $$
DECLARE
  r RECORD;
  prev TEXT := repeat('0', 64);
  canonical TEXT;
  digest TEXT;
BEGIN
  FOR r IN SELECT * FROM "unmask_events" ORDER BY "seq" LOOP
    -- Keep in step with canonicalEvent (src/lib/authz/unmask.ts): a JSON array of text or null, in this order.
    canonical := to_json(ARRAY[
      'unmask_events/1',
      r."seq"::text,
      to_char(r."at", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      r."businessDate",
      r."tenantId",
      r."userId",
      r."userName",
      r."impersonatedByUserId",
      r."entity",
      r."recordId",
      r."leadId",
      r."leadRef",
      to_json(COALESCE(r."fields", ARRAY[]::text[]))::text,
      r."result"::text,
      CASE WHEN r."consumed" THEN 'true' ELSE 'false' END,
      r."usedToday"::text,
      r."dailyLimit"::text,
      r."reason",
      r."statedReason",
      r."requestId",
      r."ip",
      r."userAgent"
    ]::text[])::text;
    digest := encode(sha256(convert_to(prev || canonical, 'UTF8')), 'hex');
    UPDATE "unmask_events" SET "prevHash" = prev, "hash" = digest WHERE "id" = r."id";
    prev := digest;
  END LOOP;
END $$;

ALTER TABLE "unmask_events" ENABLE TRIGGER "unmask_events_append_only";

ALTER TABLE "unmask_events" ALTER COLUMN "recordId" SET NOT NULL;
ALTER TABLE "unmask_events" ALTER COLUMN "seq" SET NOT NULL;
ALTER TABLE "unmask_events" ALTER COLUMN "prevHash" SET NOT NULL;
ALTER TABLE "unmask_events" ALTER COLUMN "hash" SET NOT NULL;
ALTER TABLE "unmask_events" ADD CONSTRAINT "unmask_events_entity_known" CHECK ("entity" IN ('leads', 'contacts', 'companies'));
CREATE UNIQUE INDEX "unmask_events_seq_key" ON "unmask_events"("seq");
CREATE INDEX "unmask_events_entity_recordId_at_idx" ON "unmask_events"("entity", "recordId", "at");

-- 3. Never emptied: the data reset keeps the log (src/lib/data-reset.ts), and nothing else in the application
--    truncates it. A row trigger doesn't see TRUNCATE, so this is a statement trigger of its own.
CREATE OR REPLACE FUNCTION refuse_unmask_event_truncate() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'The unmasking log is kept through every reset: it is never emptied.'
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "unmask_events_never_emptied"
  BEFORE TRUNCATE ON "unmask_events"
  FOR EACH STATEMENT EXECUTE FUNCTION refuse_unmask_event_truncate();

-- 4. The default daily limit -----------------------------------------------------------------------------------------
CREATE TABLE "unmask_settings" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "defaultDailyLimit" INTEGER DEFAULT 25,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "unmask_settings_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "unmask_settings" ADD CONSTRAINT "unmask_settings_positive"
  CHECK ("defaultDailyLimit" IS NULL OR "defaultDailyLimit" > 0);

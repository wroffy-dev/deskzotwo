-- Lead limits (owner, 12 Nov 2026 — Phase 4 lead limits, audit H.6; src/lib/leads/limits.ts). Opt-in: with no limit row
-- and no plan cap nothing changes for anybody. New tables, a defaulted column, and a warn-only backstop trigger.

-- CreateEnum
CREATE TYPE "LeadOverflowMode" AS ENUM ('SKIP', 'REFUSE');

-- AlterTable
ALTER TABLE "lead_assignment_rules" ADD COLUMN     "overflow" "LeadOverflowMode" NOT NULL DEFAULT 'SKIP';

-- CreateTable
CREATE TABLE "role_lead_limits" (
    "role" TEXT NOT NULL,
    "maxOpen" INTEGER,
    "maxPerDay" INTEGER,
    "maxPerMonth" INTEGER,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "role_lead_limits_pkey" PRIMARY KEY ("role")
);

-- CreateTable
CREATE TABLE "user_lead_limits" (
    "userId" TEXT NOT NULL,
    "limited" BOOLEAN NOT NULL,
    "maxOpen" INTEGER,
    "maxPerDay" INTEGER,
    "maxPerMonth" INTEGER,
    "reason" TEXT,
    "grantedById" TEXT,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_lead_limits_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "lead_usage" (
    "month" TEXT NOT NULL,
    "created" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lead_usage_pkey" PRIMARY KEY ("month")
);

-- CreateTable
CREATE TABLE "lead_limit_settings" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "limitTrigger" TEXT NOT NULL DEFAULT 'warn',
    "timeZone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lead_limit_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_limit_warnings" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leadId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "limitKind" TEXT NOT NULL,
    "maxAllowed" INTEGER NOT NULL,
    "counted" INTEGER NOT NULL,
    "path" TEXT,

    CONSTRAINT "lead_limit_warnings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "lead_limit_warnings_at_idx" ON "lead_limit_warnings"("at");

-- CreateIndex
CREATE INDEX "lead_limit_warnings_userId_at_idx" ON "lead_limit_warnings"("userId", "at");

-- AddForeignKey
ALTER TABLE "role_lead_limits" ADD CONSTRAINT "role_lead_limits_role_fkey" FOREIGN KEY ("role") REFERENCES "roles"("key") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_lead_limits" ADD CONSTRAINT "user_lead_limits_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_lead_limits" ADD CONSTRAINT "user_lead_limits_grantedById_fkey" FOREIGN KEY ("grantedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- `leads.limitTrigger` is "warn" or "enforce", nothing else.
ALTER TABLE "lead_limit_settings" ADD CONSTRAINT "lead_limit_settings_limitTrigger_check" CHECK ("limitTrigger" IN ('warn', 'enforce'));

-- ---------------------------------------------------------------------------------------------
-- The backstop (audit H.6.4): every write that gives a lead an owner, whatever wrote it — the importers, Automate,
-- carry-on, the response sweep, a script — is checked against that person's open and daily limits here, as
-- record_lead_assignment records it whatever wrote it. The app checks first (claimLeadCapacity), for a readable reason
-- and under locks; this is what catches a path that didn't.
--
-- Shipped warn-only (audit J, Phase 4): past a limit it writes a lead_limit_warnings row and lets the write through.
-- With lead_limit_settings."limitTrigger" = 'enforce' it refuses instead, with SQLSTATE DZL01 and a message the app reads
-- back (leadCapacityError): lead_limit_exceeded:<open|perDay>:<person>:<counted>:<max>.
--
-- Cheap: nothing more than two primary-key reads for somebody with no limit row whose role has none; past that, counts
-- on the indexes leads(ownerUserId) and lead_assignments(userId, assignedAt). The day is the workspace's, by the zone
-- the app keeps in lead_limit_settings."timeZone" (the control plane holds it, which this database can't read).
-- Timestamps here are stored as UTC wall-clock, as Prisma writes them.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION check_lead_limit() RETURNS trigger AS $$
DECLARE
  v_limited boolean;
  v_open integer;
  v_day integer;
  v_zone text;
  v_from timestamp;
  v_count integer;
  v_kind text;
  v_max integer;
  v_mode text;
BEGIN
  IF NEW."ownerUserId" IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."ownerUserId" IS NOT DISTINCT FROM OLD."ownerUserId" THEN
    RETURN NEW;
  END IF;

  -- Their own row, unexpired, over their role's; neither is no limit.
  SELECT "limited", "maxOpen", "maxPerDay" INTO v_limited, v_open, v_day
    FROM "user_lead_limits"
    WHERE "userId" = NEW."ownerUserId" AND ("expiresAt" IS NULL OR "expiresAt" > (now() AT TIME ZONE 'UTC'));
  IF FOUND THEN
    IF NOT v_limited THEN
      RETURN NEW;
    END IF;
  ELSE
    SELECT r."maxOpen", r."maxPerDay" INTO v_open, v_day
      FROM "users" u JOIN "role_lead_limits" r ON r."role" = u."role"
      WHERE u."id" = NEW."ownerUserId";
    IF NOT FOUND THEN
      RETURN NEW;
    END IF;
  END IF;
  IF v_open IS NULL AND v_day IS NULL THEN
    RETURN NEW;
  END IF;
  -- The super admin has no limit.
  IF EXISTS (SELECT 1 FROM "users" WHERE "id" = NEW."ownerUserId" AND "isSuperAdmin") THEN
    RETURN NEW;
  END IF;

  IF v_open IS NOT NULL AND NEW."status" NOT IN ('WON', 'LOST', 'DISQUALIFIED') THEN
    SELECT count(*) INTO v_count FROM "leads"
      WHERE "ownerUserId" = NEW."ownerUserId" AND "status" NOT IN ('WON', 'LOST', 'DISQUALIFIED') AND "id" <> NEW."id";
    IF v_count + 1 > v_open THEN
      v_kind := 'open';
      v_max := v_open;
    END IF;
  END IF;

  IF v_kind IS NULL AND v_day IS NOT NULL THEN
    SELECT "timeZone" INTO v_zone FROM "lead_limit_settings" WHERE "id" = 'global';
    v_zone := COALESCE(v_zone, 'Asia/Kolkata');
    v_from := (date_trunc('day', now() AT TIME ZONE v_zone) AT TIME ZONE v_zone) AT TIME ZONE 'UTC';
    SELECT count(*) INTO v_count FROM "lead_assignments"
      WHERE "userId" = NEW."ownerUserId" AND "assignedAt" >= v_from;
    IF v_count + 1 > v_day THEN
      v_kind := 'perDay';
      v_max := v_day;
    END IF;
  END IF;

  IF v_kind IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT "limitTrigger" INTO v_mode FROM "lead_limit_settings" WHERE "id" = 'global';
  IF v_mode = 'enforce' THEN
    RAISE EXCEPTION 'lead_limit_exceeded:%:%:%:%', v_kind, NEW."ownerUserId", v_count, v_max
      USING ERRCODE = 'DZL01', HINT = 'A lead limit set in Deskzo (src/lib/leads/limits.ts).';
  END IF;
  INSERT INTO "lead_limit_warnings" ("leadId", "userId", "limitKind", "maxAllowed", "counted", "path")
    VALUES (NEW."id", NEW."ownerUserId", v_kind, v_max, v_count,
            COALESCE(NULLIF(current_setting('deskzo.lead_path', true), ''), NULLIF(current_setting('application_name', true), '')));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER leads_check_limit
  BEFORE INSERT OR UPDATE OF "ownerUserId" ON "leads"
  FOR EACH ROW EXECUTE FUNCTION check_lead_limit();

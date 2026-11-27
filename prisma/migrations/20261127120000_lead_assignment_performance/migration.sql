-- AlterEnum
ALTER TYPE "LeadAssignmentStrategy" ADD VALUE 'PERFORMANCE';

-- AlterTable
ALTER TABLE "lead_assignment_rules" ADD COLUMN     "cities" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "countries" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "customerCategoryIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "itemIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "pincodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "responseHours" INTEGER;

-- CreateTable
CREATE TABLE "lead_assignments" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "userId" TEXT,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "timedOutAt" TIMESTAMP(3),
    "escalatedAt" TIMESTAMP(3),

    CONSTRAINT "lead_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "lead_assignments_leadId_assignedAt_idx" ON "lead_assignments"("leadId", "assignedAt");

-- CreateIndex
CREATE INDEX "lead_assignments_userId_assignedAt_idx" ON "lead_assignments"("userId", "assignedAt");

-- CreateIndex
CREATE INDEX "lead_assignments_assignedAt_idx" ON "lead_assignments"("assignedAt");

-- AddForeignKey
ALTER TABLE "lead_assignments" ADD CONSTRAINT "lead_assignments_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_assignments" ADD CONSTRAINT "lead_assignments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------
-- Who a lead was with, kept by the database (owner, 26 Oct 2026 — src/lib/leads/response.ts).
--
-- A trigger rather than the application, so every way an owner is set — a form, the assignment rules, a bulk
-- reassign, a workflow, an import, a script — is in the history without each having to remember to write it.
-- Only when the owner actually changes: an edit to anything else on the lead writes nothing.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION record_lead_assignment() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."ownerUserId" IS NOT DISTINCT FROM OLD."ownerUserId" THEN
      RETURN NEW;
    END IF;
    UPDATE "lead_assignments" SET "endedAt" = now() WHERE "leadId" = NEW."id" AND "endedAt" IS NULL;
  ELSIF NEW."ownerUserId" IS NULL THEN
    RETURN NEW;
  END IF;
  INSERT INTO "lead_assignments" ("id", "leadId", "userId", "assignedAt")
    VALUES (gen_random_uuid()::text, NEW."id", NEW."ownerUserId", now());
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER leads_record_assignment
  AFTER INSERT OR UPDATE OF "ownerUserId" ON "leads"
  FOR EACH ROW EXECUTE FUNCTION record_lead_assignment();

-- The history starts with today's owners: one row each, from when the lead came in. Not answered or not —
-- the sweep only looks at the last week, and only rules with response hours (none yet) move anything.
INSERT INTO "lead_assignments" ("id", "leadId", "userId", "assignedAt")
  SELECT gen_random_uuid()::text, "id", "ownerUserId", "createdAt" FROM "leads" WHERE "ownerUserId" IS NOT NULL;

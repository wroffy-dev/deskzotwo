-- A customer notice copied to people (owner, 3 Nov 2026).
ALTER TABLE "marketing_messages" ADD COLUMN "ccEmails" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- A block by hand that stops every email, not only marketing and reminders (owner, 31 Oct 2026). New column only.

-- AlterTable
ALTER TABLE "marketing_suppressions" ADD COLUMN "allMail" BOOLEAN NOT NULL DEFAULT false;

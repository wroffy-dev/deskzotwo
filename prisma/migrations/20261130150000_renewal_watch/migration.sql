-- Renewals nobody misses (owner, 30 Oct 2026 — src/lib/renewal-watch-rules.ts): the reminder ladder, who is told
-- when nothing has happened, the renewal task raised ahead, and Monday's list.
ALTER TABLE "renewal_settings" ADD COLUMN "reminderDays" INTEGER[] DEFAULT ARRAY[60, 30, 15, 7, 1]::INTEGER[];
ALTER TABLE "renewal_settings" ADD COLUMN "escalateManagerDays" INTEGER DEFAULT 15;
ALTER TABLE "renewal_settings" ADD COLUMN "escalateAdminDays" INTEGER DEFAULT 7;
ALTER TABLE "renewal_settings" ADD COLUMN "taskLeadDays" INTEGER DEFAULT 45;
ALTER TABLE "renewal_settings" ADD COLUMN "weeklyList" BOOLEAN NOT NULL DEFAULT true;

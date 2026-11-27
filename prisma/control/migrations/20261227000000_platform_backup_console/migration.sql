-- ---------------------------------------------------------------------------------------------
-- Backup & Restore in the console (owner, 26 Nov 2026 — src/lib/bundle/jobs.ts): a bundle's Verify result and its
-- progress, and when a console session last gave a fresh authenticator code (a download asks for one). Columns added
-- only, every one nullable; nothing existing changes.
-- ---------------------------------------------------------------------------------------------
-- AlterTable
ALTER TABLE "platform_backups" ADD COLUMN     "verifyProgress" JSONB,
ADD COLUMN     "verifiedAt" TIMESTAMP(3),
ADD COLUMN     "verifyOk" BOOLEAN,
ADD COLUMN     "verifyProblems" JSONB;

-- AlterTable
ALTER TABLE "platform_sessions" ADD COLUMN     "stepUpAt" TIMESTAMP(3);

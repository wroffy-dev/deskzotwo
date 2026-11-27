-- ---------------------------------------------------------------------------------------------
-- Backup & Restore, part C (owner, 26 Nov 2026 — src/lib/bundle/restore.ts): how a restore was done, where its safety
-- copy is, a full restore's outcome per workspace, and its worker's heartbeat. Columns added only, every one nullable;
-- nothing existing changes.
-- ---------------------------------------------------------------------------------------------
-- AlterTable
ALTER TABLE "restore_runs" ADD COLUMN     "mode" TEXT,
ADD COLUMN     "safetyPath" TEXT,
ADD COLUMN     "outcomes" JSONB,
ADD COLUMN     "beatAt" TIMESTAMP(3);

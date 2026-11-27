-- ---------------------------------------------------------------------------------------------
-- Backup & Restore (owner, 26 Nov 2026 — src/lib/bundle): each bundle built here or uploaded to be restored, and each
-- restore run from one. Tables and types added only; nothing existing changes.
-- ---------------------------------------------------------------------------------------------
-- CreateEnum
CREATE TYPE "PlatformBackupKind" AS ENUM ('FULL', 'WORKSPACE');

-- CreateEnum
CREATE TYPE "PlatformBackupStatus" AS ENUM ('RUNNING', 'READY', 'FAILED', 'EXPIRED', 'DELETED');

-- CreateEnum
CREATE TYPE "PlatformBackupSource" AS ENUM ('CREATED', 'UPLOADED');

-- CreateEnum
CREATE TYPE "RestoreRunStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED', 'ROLLED_BACK');

-- CreateTable
CREATE TABLE "platform_backups" (
    "id" TEXT NOT NULL,
    "kind" "PlatformBackupKind" NOT NULL,
    "tenantId" TEXT,
    "tenantSlug" TEXT,
    "status" "PlatformBackupStatus" NOT NULL DEFAULT 'RUNNING',
    "source" "PlatformBackupSource" NOT NULL DEFAULT 'CREATED',
    "fileName" TEXT NOT NULL,
    "sizeBytes" BIGINT,
    "sha256" TEXT,
    "header" JSONB,
    "progress" JSONB,
    "startedById" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "error" TEXT,

    CONSTRAINT "platform_backups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restore_runs" (
    "id" TEXT NOT NULL,
    "kind" "PlatformBackupKind" NOT NULL,
    "tenantId" TEXT,
    "tenantSlug" TEXT,
    "backupId" TEXT,
    "status" "RestoreRunStatus" NOT NULL DEFAULT 'RUNNING',
    "log" JSONB NOT NULL DEFAULT '[]',
    "safetyBackupId" TEXT,
    "startedById" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "error" TEXT,

    CONSTRAINT "restore_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "platform_backups_kind_startedAt_idx" ON "platform_backups"("kind", "startedAt");

-- CreateIndex
CREATE INDEX "platform_backups_tenantId_startedAt_idx" ON "platform_backups"("tenantId", "startedAt");

-- CreateIndex
CREATE INDEX "platform_backups_status_idx" ON "platform_backups"("status");

-- CreateIndex
CREATE INDEX "restore_runs_startedAt_idx" ON "restore_runs"("startedAt");

-- CreateIndex
CREATE INDEX "restore_runs_tenantId_startedAt_idx" ON "restore_runs"("tenantId", "startedAt");


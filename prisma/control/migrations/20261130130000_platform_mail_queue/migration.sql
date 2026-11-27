-- A queue for the platform's mail (owner, 30 Oct 2026 — docs: Deskzo at scale, Part 1). New table only.

-- CreateEnum
CREATE TYPE "PlatformMailJobStatus" AS ENUM ('QUEUED', 'SENDING', 'SENT', 'DEAD');

-- CreateTable
CREATE TABLE "platform_mail_jobs" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 5,
    "payload" JSONB NOT NULL,
    "to" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "tenant" TEXT,
    "key" TEXT,
    "status" "PlatformMailJobStatus" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedUntil" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "platform_mail_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "platform_mail_jobs_key_key" ON "platform_mail_jobs"("key");

-- CreateIndex
CREATE INDEX "platform_mail_jobs_status_nextAttemptAt_priority_idx" ON "platform_mail_jobs"("status", "nextAttemptAt", "priority");

-- CreateIndex
CREATE INDEX "platform_mail_jobs_createdAt_idx" ON "platform_mail_jobs"("createdAt");

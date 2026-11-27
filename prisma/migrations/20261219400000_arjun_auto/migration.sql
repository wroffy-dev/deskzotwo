-- Arjun working by himself (owner, 19 Nov 2026 — phase 3, src/lib/collections/arjun-auto.ts): his settings, the
-- customers he took on each morning, and the Monday note's notification kind.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'COLLECTIONS_WEEKLY';

CREATE TABLE "collection_agent_settings" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "perDay" INTEGER NOT NULL DEFAULT 20,
    "minDaysLate" INTEGER NOT NULL DEFAULT 15,
    "minAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "brokenAlways" BOOLEAN NOT NULL DEFAULT true,
    "weeklyTo" TEXT[],
    "onSince" TIMESTAMP(3),
    "enabledById" TEXT,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "collection_agent_settings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "collection_auto_runs" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "forUserId" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "reason" TEXT,
    "chaseId" TEXT,
    "chargedTo" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "collection_auto_runs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "collection_auto_runs_companyId_day_key" ON "collection_auto_runs"("companyId", "day");
CREATE INDEX "collection_auto_runs_day_status_idx" ON "collection_auto_runs"("day", "status");

ALTER TABLE "collection_auto_runs" ADD CONSTRAINT "collection_auto_runs_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

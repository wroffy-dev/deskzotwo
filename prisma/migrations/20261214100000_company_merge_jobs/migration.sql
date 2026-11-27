-- Duplicate companies sharing a GSTIN, merged in the background (owner, 14 Nov 2026 — src/lib/companies/gstin-merge.ts).
CREATE TABLE "company_merge_jobs" (
    "id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "plan" JSONB NOT NULL,
    "done" INTEGER NOT NULL DEFAULT 0,
    "merged" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "notes" JSONB NOT NULL DEFAULT '[]',
    "startedById" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "lockedAt" TIMESTAMP(3),
    "lockedBy" TEXT,
    "error" TEXT,

    CONSTRAINT "company_merge_jobs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "company_merge_jobs_status_idx" ON "company_merge_jobs"("status");

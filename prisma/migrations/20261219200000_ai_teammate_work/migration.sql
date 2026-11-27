-- The jobs AI teammates are doing or did, for the team strip, the cards' live steps and Today (src/lib/ai/teammate-work.ts).
CREATE TABLE "ai_teammate_work" (
    "id" TEXT NOT NULL,
    "teammate" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "subject" TEXT,
    "label" TEXT NOT NULL,
    "href" TEXT,
    "steps" JSONB NOT NULL DEFAULT '[]',
    "step" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "summary" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "ai_teammate_work_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ai_teammate_work_userId_startedAt_idx" ON "ai_teammate_work"("userId", "startedAt");

CREATE INDEX "ai_teammate_work_subject_status_idx" ON "ai_teammate_work"("subject", "status");

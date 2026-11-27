-- Upgrading the AI teammates, step 2 (owner, 20 Nov 2026): drafts and what became of them, thumbs up or down, and the
-- workspace's house style. src/lib/ai/drafts.ts, src/lib/ai/house-style.ts.

-- CreateTable
CREATE TABLE "ai_draft_records" (
    "id" TEXT NOT NULL,
    "teammate" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "draftSubject" TEXT NOT NULL,
    "draftBody" TEXT NOT NULL,
    "sentSubject" TEXT,
    "sentBody" TEXT,
    "outcome" TEXT NOT NULL,
    "changed" DOUBLE PRECISION,
    "repliedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_draft_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_feedback" (
    "id" TEXT NOT NULL,
    "teammate" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "good" BOOLEAN NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_feedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_house_style" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "tone" TEXT,
    "signOff" TEXT,
    "alwaysMention" TEXT,
    "neverSay" TEXT,
    "notes" TEXT,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_house_style_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ai_draft_records_kind_ref_key" ON "ai_draft_records"("kind", "ref");

-- CreateIndex
CREATE INDEX "ai_draft_records_teammate_createdAt_idx" ON "ai_draft_records"("teammate", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ai_feedback_kind_ref_userId_key" ON "ai_feedback"("kind", "ref", "userId");

-- CreateIndex
CREATE INDEX "ai_feedback_teammate_createdAt_idx" ON "ai_feedback"("teammate", "createdAt");

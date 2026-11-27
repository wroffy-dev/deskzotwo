-- Priya, the HR desk (owner, 20 Nov 2026 — src/lib/hr-desk): her settings, the HR guides she may answer from, the
-- questions asked, and the two notification kinds.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'HR_DESK_QUESTION';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'HR_DESK_ANSWERED';

CREATE TABLE "hr_desk_settings" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "handTo" TEXT[],
    "onSince" TIMESTAMP(3),
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hr_desk_settings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "hr_desk_files" (
    "fileId" TEXT NOT NULL,
    "addedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hr_desk_files_pkey" PRIMARY KEY ("fileId")
);

CREATE TABLE "hr_desk_questions" (
    "id" TEXT NOT NULL,
    "askerId" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "answer" TEXT,
    "topic" TEXT,
    "link" TEXT,
    "status" TEXT NOT NULL,
    "handedAt" TIMESTAMP(3),
    "hrAnswer" TEXT,
    "hrAnsweredById" TEXT,
    "hrAnsweredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hr_desk_questions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "hr_desk_questions_askerId_createdAt_idx" ON "hr_desk_questions"("askerId", "createdAt");
CREATE INDEX "hr_desk_questions_status_createdAt_idx" ON "hr_desk_questions"("status", "createdAt");

ALTER TABLE "hr_desk_files" ADD CONSTRAINT "hr_desk_files_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "ai_knowledge_files"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "hr_desk_questions" ADD CONSTRAINT "hr_desk_questions_askerId_fkey" FOREIGN KEY ("askerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

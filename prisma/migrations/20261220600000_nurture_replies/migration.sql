-- Nurture phase 4 (owner, 20 Nov 2026): replies read by Deskzo AI, emails approved for working hours, auto-start and
-- booking links. src/lib/nurture.

-- AlterTable
ALTER TABLE "nurture_settings" ADD COLUMN     "autoStart" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "autoStartSince" TIMESTAMP(3),
ADD COLUMN     "bookingLinks" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "nurture_touches" ADD COLUMN     "sendAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "nurture_replies" (
    "id" TEXT NOT NULL,
    "enrolmentId" TEXT NOT NULL,
    "fromName" TEXT,
    "fromEmail" TEXT,
    "subject" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "summary" TEXT,
    "resumeOn" DATE,
    "suggestedName" TEXT,
    "suggestedEmail" TEXT,
    "suggestedStage" TEXT,
    "answerSubject" TEXT,
    "answerBody" TEXT,
    "answeredAt" TIMESTAMP(3),
    "answeredById" TEXT,
    "acted" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "nurture_replies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "nurture_replies_enrolmentId_createdAt_idx" ON "nurture_replies"("enrolmentId", "createdAt");

-- AddForeignKey
ALTER TABLE "nurture_replies" ADD CONSTRAINT "nurture_replies_enrolmentId_fkey" FOREIGN KEY ("enrolmentId") REFERENCES "nurture_enrolments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

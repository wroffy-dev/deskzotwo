-- Deskzo AI nurturing leads (owner, 18 Nov 2026 — phase 3, src/lib/nurture).
CREATE TABLE "nurture_settings" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "perDay" INTEGER NOT NULL DEFAULT 50,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "nurture_settings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "nurture_enrolments" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "stopReason" TEXT,
    "ownerId" TEXT NOT NULL,
    "enrolledById" TEXT NOT NULL,
    "replyToken" TEXT NOT NULL,
    "touchesSent" INTEGER NOT NULL DEFAULT 0,
    "nextTouchAt" TIMESTAMP(3),
    "lastSentAt" TIMESTAMP(3),
    "repliedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "nurture_enrolments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "nurture_touches" (
    "id" TEXT NOT NULL,
    "enrolmentId" TEXT NOT NULL,
    "step" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "error" TEXT,
    "approvedById" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "nurture_touches_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "nurture_enrolments_leadId_key" ON "nurture_enrolments"("leadId");
CREATE UNIQUE INDEX "nurture_enrolments_replyToken_key" ON "nurture_enrolments"("replyToken");
CREATE INDEX "nurture_enrolments_status_nextTouchAt_idx" ON "nurture_enrolments"("status", "nextTouchAt");
CREATE INDEX "nurture_enrolments_ownerId_status_idx" ON "nurture_enrolments"("ownerId", "status");
CREATE UNIQUE INDEX "nurture_touches_enrolmentId_step_key" ON "nurture_touches"("enrolmentId", "step");
CREATE INDEX "nurture_touches_status_idx" ON "nurture_touches"("status");

ALTER TABLE "nurture_enrolments" ADD CONSTRAINT "nurture_enrolments_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "nurture_enrolments" ADD CONSTRAINT "nurture_enrolments_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "nurture_touches" ADD CONSTRAINT "nurture_touches_enrolmentId_fkey" FOREIGN KEY ("enrolmentId") REFERENCES "nurture_enrolments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

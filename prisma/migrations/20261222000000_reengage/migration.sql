-- Tara re-engaging existing customers (owner, 20 Nov 2026 — step 4). src/lib/reengage.

-- CreateTable
CREATE TABLE "reengage_settings" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "months" INTEGER NOT NULL DEFAULT 6,
    "perDay" INTEGER NOT NULL DEFAULT 10,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reengage_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reengage_emails" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'WAITING',
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "replyToken" TEXT NOT NULL,
    "sendAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "repliedAt" TIMESTAMP(3),
    "replyKind" TEXT,
    "replySummary" TEXT,
    "leadId" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reengage_emails_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "reengage_emails_replyToken_key" ON "reengage_emails"("replyToken");

-- CreateIndex
CREATE INDEX "reengage_emails_companyId_createdAt_idx" ON "reengage_emails"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "reengage_emails_ownerId_status_idx" ON "reengage_emails"("ownerId", "status");

-- CreateIndex
CREATE INDEX "reengage_emails_status_sendAt_idx" ON "reengage_emails"("status", "sendAt");

-- AddForeignKey
ALTER TABLE "reengage_emails" ADD CONSTRAINT "reengage_emails_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reengage_emails" ADD CONSTRAINT "reengage_emails_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

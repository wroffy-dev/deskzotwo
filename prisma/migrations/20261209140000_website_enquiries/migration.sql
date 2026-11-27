-- Website enquiries held for review before anything is made from them (owner, 9 Nov 2026). New tables only.
CREATE TABLE "website_enquiries" (
    "id" TEXT NOT NULL,
    "seq" SERIAL NOT NULL,
    "captureKeyId" TEXT,
    "payload" JSONB NOT NULL,
    "externalId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "suggestedCompanyId" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "leadId" TEXT,
    CONSTRAINT "website_enquiries_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "website_enquiries_seq_key" ON "website_enquiries"("seq");
CREATE UNIQUE INDEX "website_enquiries_captureKeyId_externalId_key" ON "website_enquiries"("captureKeyId", "externalId");
CREATE INDEX "website_enquiries_status_receivedAt_idx" ON "website_enquiries"("status", "receivedAt");
ALTER TABLE "website_enquiries" ADD CONSTRAINT "website_enquiries_captureKeyId_fkey" FOREIGN KEY ("captureKeyId") REFERENCES "lead_capture_keys"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "lead_review_settings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "holdWebsite" BOOLEAN NOT NULL DEFAULT false,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "lead_review_settings_pkey" PRIMARY KEY ("id")
);

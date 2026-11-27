-- Arjun, the Collections teammate (owner, 19 Nov 2026 — phases 1 and 2, src/lib/collections/chase-server.ts): chase
-- emails written by Deskzo AI and sent by a person, and the customers' replies to them, read for a promise, a payment,
-- a dispute or a question.
CREATE TABLE "collection_chases" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'WAITING',
    "tone" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "documentIds" TEXT[],
    "replyToken" TEXT NOT NULL,
    "sentById" TEXT,
    "sentAt" TIMESTAMP(3),
    "sentTo" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "collection_chases_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "collection_replies" (
    "id" TEXT NOT NULL,
    "chaseId" TEXT NOT NULL,
    "fromName" TEXT,
    "fromEmail" TEXT,
    "senderVerified" BOOLEAN NOT NULL DEFAULT false,
    "subject" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "reading" TEXT,
    "readTries" INTEGER NOT NULL DEFAULT 0,
    "summary" TEXT,
    "promisedOn" DATE,
    "promisedAmount" DECIMAL(14,2),
    "paidOn" DATE,
    "paidAmount" DECIMAL(14,2),
    "reference" TEXT,
    "detail" TEXT,
    "documentIds" TEXT[],
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "outcome" TEXT,
    "actedById" TEXT,
    "actedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "collection_replies_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "collection_chases_replyToken_key" ON "collection_chases"("replyToken");
CREATE INDEX "collection_chases_companyId_status_idx" ON "collection_chases"("companyId", "status");
CREATE INDEX "collection_chases_createdById_status_idx" ON "collection_chases"("createdById", "status");
CREATE INDEX "collection_chases_status_sentAt_idx" ON "collection_chases"("status", "sentAt");
CREATE INDEX "collection_replies_chaseId_idx" ON "collection_replies"("chaseId");
CREATE INDEX "collection_replies_status_reading_idx" ON "collection_replies"("status", "reading");

ALTER TABLE "collection_chases" ADD CONSTRAINT "collection_chases_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "collection_replies" ADD CONSTRAINT "collection_replies_chaseId_fkey" FOREIGN KEY ("chaseId") REFERENCES "collection_chases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

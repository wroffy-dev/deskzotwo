-- Arjun reading vendors' bills (owner, 20 Nov 2026 — src/lib/bill-reader): the file, what was read off it, and the
-- draft bill made from it.
CREATE TABLE "bill_readings" (
    "id" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "fileDataUrl" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "read" JSONB,
    "error" TEXT,
    "documentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bill_readings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "bill_readings_documentId_key" ON "bill_readings"("documentId");
CREATE INDEX "bill_readings_createdById_createdAt_idx" ON "bill_readings"("createdById", "createdAt");

ALTER TABLE "bill_readings" ADD CONSTRAINT "bill_readings_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "trade_documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

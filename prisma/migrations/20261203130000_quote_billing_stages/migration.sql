-- A quote billed in stages — progress invoicing (owner, 3 Nov 2026).

-- CreateTable
CREATE TABLE "quote_billing_stages" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "percent" DECIMAL(6,3) NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "invoiceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quote_billing_stages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "quote_billing_stages_documentId_idx" ON "quote_billing_stages"("documentId");

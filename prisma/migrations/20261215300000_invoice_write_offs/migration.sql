-- Writing off what a customer will never pay (owner, 15 Nov 2026 — src/lib/receivables/write-off.ts): one row per
-- invoice, counted as settled everywhere a balance is worked out. New table only; no foreign key, so a workspace's
-- documents are untouched — the invoice's id is kept, and a write-off goes with its invoice in the code that removes one.

CREATE TABLE "invoice_write_offs" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "baseAmount" DECIMAL(14,2) NOT NULL,
    "reliefVat" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "writtenOffOn" DATE NOT NULL,
    "reason" TEXT NOT NULL,
    "customerNotifiedOn" DATE,
    "journalEntryId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoice_write_offs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "invoice_write_offs_invoiceId_key" ON "invoice_write_offs"("invoiceId");
CREATE INDEX "invoice_write_offs_companyId_idx" ON "invoice_write_offs"("companyId");
CREATE INDEX "invoice_write_offs_writtenOffOn_idx" ON "invoice_write_offs"("writtenOffOn");

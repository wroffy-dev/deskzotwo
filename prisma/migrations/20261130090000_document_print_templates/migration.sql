-- How each kind of document looks on paper (owner, 30 Oct 2026 — src/lib/documents/print-template.ts): several
-- templates per document type, one the default. No row is the built-in Standard, so nothing prints differently
-- until somebody makes one.
CREATE TABLE "document_print_templates" (
    "id" TEXT NOT NULL,
    "docType" "TradeDocumentType" NOT NULL,
    "name" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "layout" TEXT NOT NULL DEFAULT 'standard',
    "options" JSONB NOT NULL,
    "createdById" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "document_print_templates_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "document_print_templates_docType_idx" ON "document_print_templates"("docType");

-- At most one default a type. Not expressible in the Prisma schema; the actions keep it by clearing the old default
-- in the same transaction.
CREATE UNIQUE INDEX "document_print_templates_one_default" ON "document_print_templates"("docType") WHERE "isDefault";

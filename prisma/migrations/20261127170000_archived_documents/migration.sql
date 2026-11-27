-- CreateTable
CREATE TABLE "books_archived_documents" (
    "id" TEXT NOT NULL,
    "migrationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "year" TEXT NOT NULL,
    "companyId" TEXT,
    "partyName" TEXT NOT NULL,
    "partyOldId" TEXT,
    "status" TEXT,
    "currency" TEXT,
    "total" DECIMAL(14,2) NOT NULL,
    "balance" DECIMAL(14,2),
    "dueDate" DATE,
    "reference" TEXT,
    "lines" JSONB NOT NULL DEFAULT '[]',
    "oldId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "books_archived_documents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "books_archived_documents_migrationId_key_key" ON "books_archived_documents"("migrationId", "key");

-- CreateIndex
CREATE INDEX "books_archived_documents_companyId_date_idx" ON "books_archived_documents"("companyId", "date");

-- CreateIndex
CREATE INDEX "books_archived_documents_migrationId_kind_idx" ON "books_archived_documents"("migrationId", "kind");

-- AddForeignKey
ALTER TABLE "books_archived_documents" ADD CONSTRAINT "books_archived_documents_migrationId_fkey" FOREIGN KEY ("migrationId") REFERENCES "books_migrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

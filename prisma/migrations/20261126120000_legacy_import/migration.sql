-- Old CRM data migration (owner, 26 Oct 2026): runs, their files and rows, the old-id log and the error report.
-- New tables only.

-- CreateEnum
CREATE TYPE "LegacyImportStatus" AS ENUM ('DRAFT', 'IMPORTING', 'DONE', 'FAILED', 'UNDONE');

-- CreateTable
CREATE TABLE "legacy_imports" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'wroffycrm',
    "status" "LegacyImportStatus" NOT NULL DEFAULT 'DRAFT',
    "strategy" TEXT,
    "decisions" JSONB NOT NULL DEFAULT '{}',
    "analysis" JSONB,
    "progress" JSONB NOT NULL DEFAULT '{}',
    "lookups" JSONB,
    "backupId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "undoneAt" TIMESTAMP(3),
    "undoneById" TEXT,

    CONSTRAINT "legacy_imports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "legacy_import_files" (
    "id" TEXT NOT NULL,
    "importId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT,
    "headers" TEXT[],
    "mapping" JSONB NOT NULL DEFAULT '{}',
    "rowCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "legacy_import_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "legacy_import_chunks" (
    "id" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "rows" JSONB NOT NULL,

    CONSTRAINT "legacy_import_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "legacy_import_records" (
    "id" TEXT NOT NULL,
    "importId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "oldId" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "before" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "legacy_import_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "legacy_import_errors" (
    "id" TEXT NOT NULL,
    "importId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "file" TEXT NOT NULL,
    "line" INTEGER NOT NULL,
    "oldId" TEXT,
    "message" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "legacy_import_errors_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "legacy_imports_status_idx" ON "legacy_imports"("status");

-- CreateIndex
CREATE INDEX "legacy_import_files_importId_idx" ON "legacy_import_files"("importId");

-- CreateIndex
CREATE UNIQUE INDEX "legacy_import_chunks_fileId_seq_key" ON "legacy_import_chunks"("fileId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "legacy_import_records_kind_oldId_key" ON "legacy_import_records"("kind", "oldId");

-- CreateIndex
CREATE INDEX "legacy_import_records_importId_kind_idx" ON "legacy_import_records"("importId", "kind");

-- CreateIndex
CREATE INDEX "legacy_import_records_kind_recordId_idx" ON "legacy_import_records"("kind", "recordId");

-- CreateIndex
CREATE INDEX "legacy_import_errors_importId_idx" ON "legacy_import_errors"("importId");

-- AddForeignKey
ALTER TABLE "legacy_import_files" ADD CONSTRAINT "legacy_import_files_importId_fkey" FOREIGN KEY ("importId") REFERENCES "legacy_imports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "legacy_import_chunks" ADD CONSTRAINT "legacy_import_chunks_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "legacy_import_files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "legacy_import_records" ADD CONSTRAINT "legacy_import_records_importId_fkey" FOREIGN KEY ("importId") REFERENCES "legacy_imports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "legacy_import_errors" ADD CONSTRAINT "legacy_import_errors_importId_fkey" FOREIGN KEY ("importId") REFERENCES "legacy_imports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

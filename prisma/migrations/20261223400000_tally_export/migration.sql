-- Tally export (owner, 23 Nov 2026 — src/lib/tally): settings, Tally's masters, name mappings, exports and the records in them.

-- CreateTable
CREATE TABLE "tally_settings" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "booksIn" TEXT NOT NULL DEFAULT 'DESKZO',
    "companyName" TEXT,
    "itemLines" BOOLEAN NOT NULL DEFAULT true,
    "startDate" DATE,
    "mastersFile" TEXT,
    "mastersAt" TIMESTAMP(3),
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tally_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tally_masters" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "parent" TEXT,
    "gstin" TEXT,

    CONSTRAINT "tally_masters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tally_mappings" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "tallyName" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'MATCHED',
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tally_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tally_exports" (
    "id" TEXT NOT NULL,
    "exportSeq" SERIAL NOT NULL,
    "fromDate" DATE NOT NULL,
    "toDate" DATE NOT NULL,
    "companyName" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'WAITING',
    "mastersXml" TEXT NOT NULL,
    "vouchersXml" TEXT NOT NULL,
    "summary" JSONB NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "importedById" TEXT,
    "importedAt" TIMESTAMP(3),

    CONSTRAINT "tally_exports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tally_export_records" (
    "id" TEXT NOT NULL,
    "exportId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,
    "voucherType" TEXT NOT NULL,
    "voucherNumber" TEXT NOT NULL,

    CONSTRAINT "tally_export_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tally_masters_gstin_idx" ON "tally_masters"("gstin");

-- CreateIndex
CREATE UNIQUE INDEX "tally_masters_kind_name_key" ON "tally_masters"("kind", "name");

-- CreateIndex
CREATE UNIQUE INDEX "tally_mappings_key_key" ON "tally_mappings"("key");

-- CreateIndex
CREATE UNIQUE INDEX "tally_exports_exportSeq_key" ON "tally_exports"("exportSeq");

-- CreateIndex
CREATE INDEX "tally_exports_createdAt_idx" ON "tally_exports"("createdAt");

-- CreateIndex
CREATE INDEX "tally_export_records_exportId_idx" ON "tally_export_records"("exportId");

-- CreateIndex
CREATE UNIQUE INDEX "tally_export_records_kind_recordId_key" ON "tally_export_records"("kind", "recordId");

-- AddForeignKey
ALTER TABLE "tally_export_records" ADD CONSTRAINT "tally_export_records_exportId_fkey" FOREIGN KEY ("exportId") REFERENCES "tally_exports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

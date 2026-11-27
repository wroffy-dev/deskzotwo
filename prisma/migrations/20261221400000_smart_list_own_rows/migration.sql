-- Smart Lists with rows of their own (owner, 20 Nov 2026 — src/lib/smart-lists/own-rows.ts): a backlink tracker, a unit
-- inventory, a candidate pipeline — records typed in or imported, not companies. New tables only, and new enum values
-- nothing reads until a list uses them.

-- AlterEnum
ALTER TYPE "WorkbookMode" ADD VALUE IF NOT EXISTS 'ROWS';

-- AlterEnum
ALTER TYPE "ListPropertyKind" ADD VALUE IF NOT EXISTS 'RATING';
ALTER TYPE "ListPropertyKind" ADD VALUE IF NOT EXISTS 'EMAIL';
ALTER TYPE "ListPropertyKind" ADD VALUE IF NOT EXISTS 'PHONE';

-- CreateTable
CREATE TABLE "workbook_rows" (
    "id" TEXT NOT NULL,
    "workbookId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT NOT NULL DEFAULT '',
    "checklist" JSONB NOT NULL DEFAULT '[]',
    "createdByUserId" TEXT,
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workbook_rows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workbook_row_values" (
    "id" TEXT NOT NULL,
    "workbookId" TEXT NOT NULL,
    "rowId" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedByUserId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workbook_row_values_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workbook_row_settings" (
    "workbookId" TEXT NOT NULL,
    "titleName" TEXT NOT NULL DEFAULT 'Name',
    "template" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workbook_row_settings_pkey" PRIMARY KEY ("workbookId")
);

-- CreateIndex
CREATE INDEX "workbook_rows_workbookId_sortOrder_idx" ON "workbook_rows"("workbookId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "workbook_row_values_propertyId_rowId_key" ON "workbook_row_values"("propertyId", "rowId");

-- CreateIndex
CREATE INDEX "workbook_row_values_workbookId_idx" ON "workbook_row_values"("workbookId");

-- CreateIndex
CREATE INDEX "workbook_row_values_rowId_idx" ON "workbook_row_values"("rowId");

-- AddForeignKey
ALTER TABLE "workbook_rows" ADD CONSTRAINT "workbook_rows_workbookId_fkey" FOREIGN KEY ("workbookId") REFERENCES "workbooks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workbook_row_values" ADD CONSTRAINT "workbook_row_values_rowId_fkey" FOREIGN KEY ("rowId") REFERENCES "workbook_rows"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workbook_row_values" ADD CONSTRAINT "workbook_row_values_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "workbook_properties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workbook_row_settings" ADD CONSTRAINT "workbook_row_settings_workbookId_fkey" FOREIGN KEY ("workbookId") REFERENCES "workbooks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Smart Lists phase 3 (owner, 20 Nov 2026): a row's history and comments, count columns, a gallery view, forms that add
-- rows, and a company's own templates. New tables and enum values only.

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'SMART_LIST_MENTION';

-- AlterEnum
ALTER TYPE "ListPropertyKind" ADD VALUE IF NOT EXISTS 'ROLLUP';

-- AlterEnum
ALTER TYPE "ListViewKind" ADD VALUE IF NOT EXISTS 'GALLERY';

-- CreateTable
CREATE TABLE "workbook_row_changes" (
    "id" TEXT NOT NULL,
    "workbookId" TEXT NOT NULL,
    "rowKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "propertyId" TEXT,
    "before" JSONB,
    "after" JSONB,
    "byUserId" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workbook_row_changes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workbook_row_comments" (
    "id" TEXT NOT NULL,
    "workbookId" TEXT NOT NULL,
    "rowId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "authorUserId" TEXT,
    "authorGuestId" TEXT,
    "shared" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workbook_row_comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workbook_forms" (
    "id" TEXT NOT NULL,
    "workbookId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "intro" TEXT,
    "fields" JSONB NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workbook_forms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workbook_templates" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "titleName" TEXT NOT NULL,
    "shape" JSONB NOT NULL,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workbook_templates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "workbook_row_changes_workbookId_rowKey_at_idx" ON "workbook_row_changes"("workbookId", "rowKey", "at");

-- CreateIndex
CREATE INDEX "workbook_row_comments_rowId_createdAt_idx" ON "workbook_row_comments"("rowId", "createdAt");

-- CreateIndex
CREATE INDEX "workbook_row_comments_workbookId_idx" ON "workbook_row_comments"("workbookId");

-- CreateIndex
CREATE INDEX "workbook_forms_workbookId_idx" ON "workbook_forms"("workbookId");

-- AddForeignKey
ALTER TABLE "workbook_row_comments" ADD CONSTRAINT "workbook_row_comments_rowId_fkey" FOREIGN KEY ("rowId") REFERENCES "workbook_rows"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workbook_forms" ADD CONSTRAINT "workbook_forms_workbookId_fkey" FOREIGN KEY ("workbookId") REFERENCES "workbooks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

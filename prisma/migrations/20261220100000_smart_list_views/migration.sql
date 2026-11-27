-- Smart Lists, Notion-style (owner, 20 Nov 2026 — src/lib/smart-lists): a list's own columns and their values, saved
-- views, a page per row, and companies added by hand.

-- CreateEnum
CREATE TYPE "ListPropertyKind" AS ENUM ('TEXT', 'NUMBER', 'MONEY', 'DATE', 'SELECT', 'MULTI_SELECT', 'CHECKBOX', 'LINK', 'PERSON');

-- CreateEnum
CREATE TYPE "ListViewKind" AS ENUM ('TABLE', 'BOARD', 'CALENDAR');

-- CreateTable
CREATE TABLE "workbook_properties" (
    "id" TEXT NOT NULL,
    "workbookId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "ListPropertyKind" NOT NULL,
    "options" JSONB,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "guestVisible" BOOLEAN NOT NULL DEFAULT false,
    "guestEditable" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workbook_properties_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workbook_values" (
    "id" TEXT NOT NULL,
    "workbookId" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedByUserId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workbook_values_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workbook_views" (
    "id" TEXT NOT NULL,
    "workbookId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "ListViewKind" NOT NULL,
    "propertyId" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workbook_views_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workbook_row_pages" (
    "id" TEXT NOT NULL,
    "workbookId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "notes" TEXT NOT NULL DEFAULT '',
    "checklist" JSONB NOT NULL DEFAULT '[]',
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workbook_row_pages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workbook_pinned_rows" (
    "workbookId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "addedByUserId" TEXT,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workbook_pinned_rows_pkey" PRIMARY KEY ("workbookId","companyId")
);

-- CreateIndex
CREATE INDEX "workbook_properties_workbookId_sortOrder_idx" ON "workbook_properties"("workbookId", "sortOrder");

-- CreateIndex
CREATE INDEX "workbook_values_workbookId_companyId_idx" ON "workbook_values"("workbookId", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "workbook_values_propertyId_companyId_key" ON "workbook_values"("propertyId", "companyId");

-- CreateIndex
CREATE INDEX "workbook_views_workbookId_sortOrder_idx" ON "workbook_views"("workbookId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "workbook_row_pages_workbookId_companyId_key" ON "workbook_row_pages"("workbookId", "companyId");

-- CreateIndex
CREATE INDEX "workbook_pinned_rows_companyId_idx" ON "workbook_pinned_rows"("companyId");

-- AddForeignKey
ALTER TABLE "workbook_properties" ADD CONSTRAINT "workbook_properties_workbookId_fkey" FOREIGN KEY ("workbookId") REFERENCES "workbooks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workbook_values" ADD CONSTRAINT "workbook_values_workbookId_fkey" FOREIGN KEY ("workbookId") REFERENCES "workbooks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workbook_values" ADD CONSTRAINT "workbook_values_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "workbook_properties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workbook_values" ADD CONSTRAINT "workbook_values_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workbook_views" ADD CONSTRAINT "workbook_views_workbookId_fkey" FOREIGN KEY ("workbookId") REFERENCES "workbooks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workbook_row_pages" ADD CONSTRAINT "workbook_row_pages_workbookId_fkey" FOREIGN KEY ("workbookId") REFERENCES "workbooks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workbook_row_pages" ADD CONSTRAINT "workbook_row_pages_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workbook_pinned_rows" ADD CONSTRAINT "workbook_pinned_rows_workbookId_fkey" FOREIGN KEY ("workbookId") REFERENCES "workbooks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workbook_pinned_rows" ADD CONSTRAINT "workbook_pinned_rows_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

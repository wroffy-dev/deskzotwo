-- Smart Lists phase 2 (owner, 20 Nov 2026): a view's filters and sort, reminders from Date columns, columns that link
-- to companies, leads, contacts or another list's rows, and a Files column. New tables and enum values only.

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'SMART_LIST_REMINDER';

-- AlterEnum
ALTER TYPE "ListPropertyKind" ADD VALUE IF NOT EXISTS 'COMPANY';
ALTER TYPE "ListPropertyKind" ADD VALUE IF NOT EXISTS 'LEAD';
ALTER TYPE "ListPropertyKind" ADD VALUE IF NOT EXISTS 'CONTACT';
ALTER TYPE "ListPropertyKind" ADD VALUE IF NOT EXISTS 'ROW';
ALTER TYPE "ListPropertyKind" ADD VALUE IF NOT EXISTS 'FILE';

-- CreateTable
CREATE TABLE "workbook_view_queries" (
    "viewId" TEXT NOT NULL,
    "workbookId" TEXT NOT NULL,
    "query" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workbook_view_queries_pkey" PRIMARY KEY ("viewId")
);

-- CreateTable
CREATE TABLE "workbook_reminders" (
    "propertyId" TEXT NOT NULL,
    "workbookId" TEXT NOT NULL,
    "daysBefore" INTEGER NOT NULL DEFAULT 1,
    "notify" TEXT NOT NULL,
    "personPropertyId" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workbook_reminders_pkey" PRIMARY KEY ("propertyId")
);

-- CreateTable
CREATE TABLE "workbook_reminder_sent" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "rowKey" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workbook_reminder_sent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workbook_files" (
    "id" TEXT NOT NULL,
    "workbookId" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "rowKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "uploadedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workbook_files_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "workbook_view_queries_workbookId_idx" ON "workbook_view_queries"("workbookId");

-- CreateIndex
CREATE INDEX "workbook_reminders_workbookId_idx" ON "workbook_reminders"("workbookId");

-- CreateIndex
CREATE UNIQUE INDEX "workbook_reminder_sent_propertyId_rowKey_day_key" ON "workbook_reminder_sent"("propertyId", "rowKey", "day");

-- CreateIndex
CREATE INDEX "workbook_reminder_sent_sentAt_idx" ON "workbook_reminder_sent"("sentAt");

-- CreateIndex
CREATE INDEX "workbook_files_workbookId_idx" ON "workbook_files"("workbookId");

-- CreateIndex
CREATE INDEX "workbook_files_propertyId_rowKey_idx" ON "workbook_files"("propertyId", "rowKey");

-- AddForeignKey
ALTER TABLE "workbook_view_queries" ADD CONSTRAINT "workbook_view_queries_viewId_fkey" FOREIGN KEY ("viewId") REFERENCES "workbook_views"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workbook_reminders" ADD CONSTRAINT "workbook_reminders_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "workbook_properties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workbook_files" ADD CONSTRAINT "workbook_files_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "workbook_properties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

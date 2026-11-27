-- Smart Lists phase 4 (owner, 20 Nov 2026): who may see and fill in each list, formula columns, a timeline view, public
-- form links, rows added on a schedule, and a guest's changes in a row's history. New tables and enum values, and one
-- column on a table new last release (read by name — NOT_YET_EVERYWHERE).

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'SMART_LIST_SUBMISSION';

-- AlterEnum
ALTER TYPE "ListPropertyKind" ADD VALUE IF NOT EXISTS 'FORMULA';

-- AlterEnum
ALTER TYPE "ListViewKind" ADD VALUE IF NOT EXISTS 'TIMELINE';

-- AlterTable
ALTER TABLE "workbook_row_changes" ADD COLUMN "byGuestId" TEXT;

-- CreateTable
CREATE TABLE "workbook_access" (
    "workbookId" TEXT NOT NULL,
    "audience" TEXT NOT NULL DEFAULT 'EVERYONE',
    "everyoneRole" TEXT NOT NULL DEFAULT 'EDIT',
    "rowRule" TEXT NOT NULL DEFAULT 'ANY',
    "ownerPropertyId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workbook_access_pkey" PRIMARY KEY ("workbookId")
);

-- CreateTable
CREATE TABLE "workbook_members" (
    "id" TEXT NOT NULL,
    "workbookId" TEXT NOT NULL,
    "userId" TEXT,
    "departmentId" TEXT,
    "role" TEXT NOT NULL DEFAULT 'EDIT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workbook_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workbook_view_options" (
    "viewId" TEXT NOT NULL,
    "options" JSONB NOT NULL,

    CONSTRAINT "workbook_view_options_pkey" PRIMARY KEY ("viewId")
);

-- CreateTable
CREATE TABLE "workbook_public_forms" (
    "formId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "consent" TEXT NOT NULL,
    "approve" BOOLEAN NOT NULL DEFAULT true,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workbook_public_forms_pkey" PRIMARY KEY ("formId")
);

-- CreateTable
CREATE TABLE "workbook_form_submissions" (
    "id" TEXT NOT NULL,
    "formId" TEXT NOT NULL,
    "workbookId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "answers" JSONB NOT NULL,
    "email" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "sourceHash" TEXT NOT NULL,
    "rowId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    "decidedByUserId" TEXT,

    CONSTRAINT "workbook_form_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workbook_repeats" (
    "id" TEXT NOT NULL,
    "workbookId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "values" JSONB NOT NULL,
    "every" TEXT NOT NULL,
    "nextOn" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdByUserId" TEXT,
    "lastRunAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workbook_repeats_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "workbook_members_workbookId_userId_key" ON "workbook_members"("workbookId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "workbook_members_workbookId_departmentId_key" ON "workbook_members"("workbookId", "departmentId");

-- CreateIndex
CREATE UNIQUE INDEX "workbook_public_forms_slug_key" ON "workbook_public_forms"("slug");

-- CreateIndex
CREATE INDEX "workbook_form_submissions_formId_status_idx" ON "workbook_form_submissions"("formId", "status");

-- CreateIndex
CREATE INDEX "workbook_form_submissions_sourceHash_createdAt_idx" ON "workbook_form_submissions"("sourceHash", "createdAt");

-- CreateIndex
CREATE INDEX "workbook_form_submissions_workbookId_status_idx" ON "workbook_form_submissions"("workbookId", "status");

-- CreateIndex
CREATE INDEX "workbook_repeats_workbookId_idx" ON "workbook_repeats"("workbookId");

-- AddForeignKey
ALTER TABLE "workbook_access" ADD CONSTRAINT "workbook_access_workbookId_fkey" FOREIGN KEY ("workbookId") REFERENCES "workbooks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workbook_members" ADD CONSTRAINT "workbook_members_workbookId_fkey" FOREIGN KEY ("workbookId") REFERENCES "workbooks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workbook_view_options" ADD CONSTRAINT "workbook_view_options_viewId_fkey" FOREIGN KEY ("viewId") REFERENCES "workbook_views"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workbook_public_forms" ADD CONSTRAINT "workbook_public_forms_formId_fkey" FOREIGN KEY ("formId") REFERENCES "workbook_forms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workbook_repeats" ADD CONSTRAINT "workbook_repeats_workbookId_fkey" FOREIGN KEY ("workbookId") REFERENCES "workbooks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

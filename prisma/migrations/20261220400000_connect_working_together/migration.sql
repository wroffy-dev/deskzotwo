-- Deskzo Connect, phase 3 (owner, 20 Nov 2026 — src/lib/connect): guests suggest companies and corrections for review,
-- comments on a list's rows (shared with guests, or internal), and how a row's account owner is shown to guests.

-- CreateEnum
CREATE TYPE "ListSuggestionKind" AS ENUM ('NEW_COMPANY', 'CORRECTION');

-- CreateEnum
CREATE TYPE "ListSuggestionStatus" AS ENUM ('PENDING', 'LINKED', 'CREATED', 'ACCEPTED', 'DECLINED');

-- CreateTable
CREATE TABLE "list_suggestions" (
    "id" TEXT NOT NULL,
    "workbookId" TEXT NOT NULL,
    "guestId" TEXT NOT NULL,
    "kind" "ListSuggestionKind" NOT NULL,
    "companyId" TEXT,
    "name" TEXT,
    "city" TEXT,
    "website" TEXT,
    "gstin" TEXT,
    "contactName" TEXT,
    "note" TEXT NOT NULL,
    "status" "ListSuggestionStatus" NOT NULL DEFAULT 'PENDING',
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "declineReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "list_suggestions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "list_row_comments" (
    "id" TEXT NOT NULL,
    "workbookId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "authorUserId" TEXT,
    "authorGuestId" TEXT,
    "shared" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "list_row_comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "connect_settings" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "ownerContact" TEXT NOT NULL DEFAULT 'NAME_EMAIL',
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "connect_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "list_suggestions_workbookId_status_idx" ON "list_suggestions"("workbookId", "status");

-- CreateIndex
CREATE INDEX "list_suggestions_guestId_idx" ON "list_suggestions"("guestId");

-- CreateIndex
CREATE INDEX "list_suggestions_companyId_idx" ON "list_suggestions"("companyId");

-- CreateIndex
CREATE INDEX "list_row_comments_workbookId_companyId_createdAt_idx" ON "list_row_comments"("workbookId", "companyId", "createdAt");

-- CreateIndex
CREATE INDEX "list_row_comments_companyId_idx" ON "list_row_comments"("companyId");

-- AddForeignKey
ALTER TABLE "list_suggestions" ADD CONSTRAINT "list_suggestions_workbookId_fkey" FOREIGN KEY ("workbookId") REFERENCES "workbooks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "list_suggestions" ADD CONSTRAINT "list_suggestions_guestId_fkey" FOREIGN KEY ("guestId") REFERENCES "guests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "list_suggestions" ADD CONSTRAINT "list_suggestions_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "list_row_comments" ADD CONSTRAINT "list_row_comments_workbookId_fkey" FOREIGN KEY ("workbookId") REFERENCES "workbooks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "list_row_comments" ADD CONSTRAINT "list_row_comments_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "list_row_comments" ADD CONSTRAINT "list_row_comments_authorGuestId_fkey" FOREIGN KEY ("authorGuestId") REFERENCES "guests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Searching verifiable documents on a public page (owner, 7 Nov 2026 — src/lib/verifiable/search.ts). Off until a workspace turns
-- it on: new columns with defaults, and one setting row made when it's first saved.

-- AlterTable
ALTER TABLE "verifiable_documents"
  ADD COLUMN "numberKey" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "inSearch" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "holderIsPerson" BOOLEAN NOT NULL DEFAULT false;

-- The number as a search compares it: capitals, letters and digits only.
UPDATE "verifiable_documents" SET "numberKey" = upper(regexp_replace("number", '[^A-Za-z0-9]', '', 'g'));

-- CreateIndex
CREATE INDEX "verifiable_documents_numberKey_idx" ON "verifiable_documents"("numberKey");

-- CreateTable
CREATE TABLE "verifiable_settings" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "searchOn" BOOLEAN NOT NULL DEFAULT false,
    "nameSearch" BOOLEAN NOT NULL DEFAULT false,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "verifiable_settings_pkey" PRIMARY KEY ("id")
);

-- Certificates: the workspace's own fields, and how its public pages look (owner, 7 Nov 2026 — src/lib/verifiable). New columns
-- with defaults, and one more kind of record a custom field can be on.

-- AlterEnum
ALTER TYPE "CustomFieldEntity" ADD VALUE IF NOT EXISTS 'VERIFIABLE';

-- AlterTable
ALTER TABLE "verifiable_documents" ADD COLUMN "customFields" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "verifiable_documents" ADD CONSTRAINT "verifiable_documents_customFields_object" CHECK (jsonb_typeof("customFields") = 'object');

-- AlterTable
ALTER TABLE "verifiable_settings"
  ADD COLUMN "template" TEXT NOT NULL DEFAULT 'TRUST',
  ADD COLUMN "heading" TEXT,
  ADD COLUMN "intro" TEXT,
  ADD COLUMN "accent" TEXT,
  ADD COLUMN "contactEmail" TEXT,
  ADD COLUMN "contactPhone" TEXT,
  ADD COLUMN "accreditations" JSONB NOT NULL DEFAULT '[]';

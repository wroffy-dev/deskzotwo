-- Company types become the workspace's own list (Settings › Lists, owner 27 Oct 2026). The eight Deskzo came with
-- keep their keys, so every company keeps its type; the column turns from the enum into text holding a key.

-- CreateTable
CREATE TABLE "company_type_options" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "company_type_options_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "company_type_options_key_key" ON "company_type_options"("key");

-- CreateIndex
CREATE UNIQUE INDEX "company_type_options_name_key" ON "company_type_options"("name");

INSERT INTO "company_type_options" ("id", "key", "name", "sortOrder", "updatedAt") VALUES
  ('ctype_private_limited', 'PRIVATE_LIMITED', 'Private limited', 1, CURRENT_TIMESTAMP),
  ('ctype_public_limited', 'PUBLIC_LIMITED', 'Public limited', 2, CURRENT_TIMESTAMP),
  ('ctype_proprietorship', 'PROPRIETORSHIP', 'Proprietorship', 3, CURRENT_TIMESTAMP),
  ('ctype_partnership', 'PARTNERSHIP', 'Partnership', 4, CURRENT_TIMESTAMP),
  ('ctype_llp', 'LLP', 'LLP', 5, CURRENT_TIMESTAMP),
  ('ctype_ngo', 'NGO', 'NGO', 6, CURRENT_TIMESTAMP),
  ('ctype_government', 'GOVERNMENT', 'Government', 7, CURRENT_TIMESTAMP),
  ('ctype_other', 'OTHER', 'Other', 8, CURRENT_TIMESTAMP);

-- AlterTable: the enum to text, every value kept as it was.
ALTER TABLE "companies" ALTER COLUMN "companyType" TYPE TEXT USING "companyType"::text;

-- DropEnum
DROP TYPE "CompanyType";

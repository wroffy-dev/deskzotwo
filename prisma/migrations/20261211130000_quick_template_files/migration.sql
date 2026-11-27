-- A message template's attachment (owner, 11 Nov 2026): one PDF — the company profile, a brochure — sent with the
-- email, and on WhatsApp as a document. Its own table, so listing templates never reads the file.

CREATE TABLE "quick_template_files" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quick_template_files_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "quick_template_files_templateId_key" ON "quick_template_files"("templateId");

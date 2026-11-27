-- Payment reminders in the invoice's own email thread, if the admin chooses (owner, 3 Nov 2026).

-- AlterTable
ALTER TABLE "collection_settings" ADD COLUMN "reminderThread" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "document_mail_threads" (
    "documentId" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "messageIds" TEXT[],
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "document_mail_threads_pkey" PRIMARY KEY ("documentId")
);

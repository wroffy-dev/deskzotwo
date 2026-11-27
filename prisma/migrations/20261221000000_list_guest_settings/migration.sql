-- A Smart List's own Deskzo Connect settings (owner, 20 Nov 2026): whether its guests are emailed when something
-- changes. No row: guests are emailed.

-- CreateTable
CREATE TABLE "workbook_guest_settings" (
    "workbookId" TEXT NOT NULL,
    "emailGuests" BOOLEAN NOT NULL DEFAULT true,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workbook_guest_settings_pkey" PRIMARY KEY ("workbookId")
);

-- AddForeignKey
ALTER TABLE "workbook_guest_settings" ADD CONSTRAINT "workbook_guest_settings_workbookId_fkey" FOREIGN KEY ("workbookId") REFERENCES "workbooks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

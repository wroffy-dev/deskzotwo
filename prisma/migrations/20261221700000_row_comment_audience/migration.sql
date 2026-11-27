-- A shared comment on a row of a Smart List of its own, meant for one team of guests only (owner, 20 Nov 2026 — Smart
-- Lists phase 3, as Deskzo Connect's company-row comments are). A new table this release, so a plain column.

-- AlterTable
ALTER TABLE "workbook_row_comments" ADD COLUMN "audienceConnectionId" TEXT;

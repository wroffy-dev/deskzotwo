-- Deskzo Connect (owner, 20 Nov 2026): a staff comment shared with one team of guests only. No row: every guest.

-- CreateTable
CREATE TABLE "list_row_comment_audiences" (
    "commentId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,

    CONSTRAINT "list_row_comment_audiences_pkey" PRIMARY KEY ("commentId")
);

-- CreateIndex
CREATE INDEX "list_row_comment_audiences_connectionId_idx" ON "list_row_comment_audiences"("connectionId");

-- AddForeignKey
ALTER TABLE "list_row_comment_audiences" ADD CONSTRAINT "list_row_comment_audiences_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "list_row_comments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "list_row_comment_audiences" ADD CONSTRAINT "list_row_comment_audiences_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

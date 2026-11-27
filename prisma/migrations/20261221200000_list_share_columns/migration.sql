-- Deskzo Connect (owner, 20 Nov 2026): which of a list's guest columns one share shows. No row: all of them.

-- CreateTable
CREATE TABLE "list_share_columns" (
    "shareId" TEXT NOT NULL,
    "columnIds" TEXT[],
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "list_share_columns_pkey" PRIMARY KEY ("shareId")
);

-- AddForeignKey
ALTER TABLE "list_share_columns" ADD CONSTRAINT "list_share_columns_shareId_fkey" FOREIGN KEY ("shareId") REFERENCES "list_shares"("id") ON DELETE CASCADE ON UPDATE CASCADE;

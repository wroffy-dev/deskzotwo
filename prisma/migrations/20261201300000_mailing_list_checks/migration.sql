-- Mailing list uploads, checked first (owner, 1 Nov 2026 — src/lib/marketing/list-import.ts): an address that fails
-- the check goes on the suppression list with a reason of its own, and every row left out is kept for download.
ALTER TYPE "SuppressionReason" ADD VALUE IF NOT EXISTS 'INVALID';

CREATE TABLE "marketing_list_rejects" (
    "id" TEXT NOT NULL,
    "listId" TEXT NOT NULL,
    "line" INTEGER NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "company" TEXT,
    "reason" TEXT NOT NULL,
    "detail" TEXT NOT NULL,

    CONSTRAINT "marketing_list_rejects_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "marketing_list_rejects_listId_idx" ON "marketing_list_rejects"("listId");

ALTER TABLE "marketing_list_rejects" ADD CONSTRAINT "marketing_list_rejects_listId_fkey" FOREIGN KEY ("listId") REFERENCES "marketing_lists"("id") ON DELETE CASCADE ON UPDATE CASCADE;

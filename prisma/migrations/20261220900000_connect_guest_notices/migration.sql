-- Deskzo Connect (owner, 20 Nov 2026 — src/lib/connect/notices.ts): emails guests were sent about a list, so comments mail
-- them at most once a list an hour.

-- CreateTable
CREATE TABLE "guest_notices" (
    "id" TEXT NOT NULL,
    "guestId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "workbookId" TEXT,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "guest_notices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "guest_notices_guestId_kind_sentAt_idx" ON "guest_notices"("guestId", "kind", "sentAt");

-- AddForeignKey
ALTER TABLE "guest_notices" ADD CONSTRAINT "guest_notices_guestId_fkey" FOREIGN KEY ("guestId") REFERENCES "guests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

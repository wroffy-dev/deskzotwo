-- Deskzo Connect, phase 4 (owner, 20 Nov 2026 — src/lib/connect): what guests do, for the activity report.

-- CreateEnum
CREATE TYPE "GuestActivityKind" AS ENUM ('SIGN_IN', 'EDIT', 'COMMENT', 'SUGGEST');

-- CreateTable
CREATE TABLE "guest_activity" (
    "id" TEXT NOT NULL,
    "guestId" TEXT NOT NULL,
    "kind" "GuestActivityKind" NOT NULL,
    "workbookId" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "guest_activity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "guest_activity_guestId_at_idx" ON "guest_activity"("guestId", "at");

-- CreateIndex
CREATE INDEX "guest_activity_workbookId_at_idx" ON "guest_activity"("workbookId", "at");

-- AddForeignKey
ALTER TABLE "guest_activity" ADD CONSTRAINT "guest_activity_guestId_fkey" FOREIGN KEY ("guestId") REFERENCES "guests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

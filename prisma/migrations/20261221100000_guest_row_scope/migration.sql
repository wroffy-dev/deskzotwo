-- Deskzo Connect (owner, 20 Nov 2026): a guest's territory, and a share showing only the rows ticked in a Checkbox
-- column ("Nominated for LC"). No row in either: nothing narrowed.

-- CreateTable
CREATE TABLE "guest_territories" (
    "guestId" TEXT NOT NULL,
    "states" TEXT[],
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "guest_territories_pkey" PRIMARY KEY ("guestId")
);

-- CreateTable
CREATE TABLE "list_share_scopes" (
    "shareId" TEXT NOT NULL,
    "onlyPropertyId" TEXT,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "list_share_scopes_pkey" PRIMARY KEY ("shareId")
);

-- AddForeignKey
ALTER TABLE "guest_territories" ADD CONSTRAINT "guest_territories_guestId_fkey" FOREIGN KEY ("guestId") REFERENCES "guests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "list_share_scopes" ADD CONSTRAINT "list_share_scopes_shareId_fkey" FOREIGN KEY ("shareId") REFERENCES "list_shares"("id") ON DELETE CASCADE ON UPDATE CASCADE;

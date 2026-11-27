-- Deskzo Connect, phase 2 (owner, 20 Nov 2026 — src/lib/connect): outside companies, their guests invited by work
-- email, sign-in codes and sessions, and Smart Lists shared with guests.

-- CreateEnum
CREATE TYPE "ConnectionKind" AS ENUM ('BRAND', 'SUBCONTRACTOR', 'CLIENT', 'ADVISER', 'OTHER');

-- CreateEnum
CREATE TYPE "GuestStatus" AS ENUM ('INVITED', 'ACTIVE', 'SUSPENDED');

-- CreateTable
CREATE TABLE "connections" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "ConnectionKind" NOT NULL DEFAULT 'BRAND',
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guests" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "status" "GuestStatus" NOT NULL DEFAULT 'INVITED',
    "invitedById" TEXT,
    "invitedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inviteExpiresAt" TIMESTAMP(3) NOT NULL,
    "accessUntil" TIMESTAMP(3),
    "lastSignInAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "guests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guest_codes" (
    "id" TEXT NOT NULL,
    "guestId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "guest_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guest_sessions" (
    "id" TEXT NOT NULL,
    "guestId" TEXT NOT NULL,
    "secretHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "guest_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "list_shares" (
    "id" TEXT NOT NULL,
    "workbookId" TEXT NOT NULL,
    "guestId" TEXT NOT NULL,
    "until" TIMESTAMP(3),
    "sharedById" TEXT,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "list_shares_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "guests_email_key" ON "guests"("email");

-- CreateIndex
CREATE INDEX "guests_connectionId_idx" ON "guests"("connectionId");

-- CreateIndex
CREATE INDEX "guest_codes_guestId_createdAt_idx" ON "guest_codes"("guestId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "guest_sessions_secretHash_key" ON "guest_sessions"("secretHash");

-- CreateIndex
CREATE INDEX "guest_sessions_guestId_idx" ON "guest_sessions"("guestId");

-- CreateIndex
CREATE UNIQUE INDEX "list_shares_workbookId_guestId_key" ON "list_shares"("workbookId", "guestId");

-- CreateIndex
CREATE INDEX "list_shares_guestId_idx" ON "list_shares"("guestId");

-- AddForeignKey
ALTER TABLE "guests" ADD CONSTRAINT "guests_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guest_codes" ADD CONSTRAINT "guest_codes_guestId_fkey" FOREIGN KEY ("guestId") REFERENCES "guests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guest_sessions" ADD CONSTRAINT "guest_sessions_guestId_fkey" FOREIGN KEY ("guestId") REFERENCES "guests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "list_shares" ADD CONSTRAINT "list_shares_workbookId_fkey" FOREIGN KEY ("workbookId") REFERENCES "workbooks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "list_shares" ADD CONSTRAINT "list_shares_guestId_fkey" FOREIGN KEY ("guestId") REFERENCES "guests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

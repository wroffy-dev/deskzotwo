-- The platform's own suppression list (owner, 31 Oct 2026): hard bounces and spam complaints on Deskzo's own servers,
-- by a hash of the address, until they expire. New table only.

-- CreateTable
CREATE TABLE "platform_mail_suppressions" (
    "addressHash" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "detail" TEXT,
    "firstAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "hits" INTEGER NOT NULL DEFAULT 1,
    "stopped" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "platform_mail_suppressions_pkey" PRIMARY KEY ("addressHash")
);

-- CreateIndex
CREATE INDEX "platform_mail_suppressions_expiresAt_idx" ON "platform_mail_suppressions"("expiresAt");

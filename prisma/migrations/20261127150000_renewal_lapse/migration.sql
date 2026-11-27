-- CreateTable
CREATE TABLE "renewal_settings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "lapseLostAfterDays" INTEGER DEFAULT 15,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "renewal_settings_pkey" PRIMARY KEY ("id")
);

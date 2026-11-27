-- Alerts that reach a person (owner, 30 Oct 2026): server errors grouped and counted, and what the people on
-- call were told about each alert. New tables only.

-- CreateTable
CREATE TABLE "platform_errors" (
    "fingerprint" TEXT NOT NULL,
    "routeType" TEXT NOT NULL,
    "route" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "firstSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastTenant" TEXT,
    "lastPath" TEXT,
    "lastDigest" TEXT,

    CONSTRAINT "platform_errors_pkey" PRIMARY KEY ("fingerprint")
);

-- CreateTable
CREATE TABLE "platform_error_buckets" (
    "fingerprint" TEXT NOT NULL,
    "bucket" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "platform_error_buckets_pkey" PRIMARY KEY ("fingerprint","bucket")
);

-- CreateTable
CREATE TABLE "platform_alert_notices" (
    "key" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "firstSentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sends" INTEGER NOT NULL DEFAULT 1,
    "clearedAt" TIMESTAMP(3),

    CONSTRAINT "platform_alert_notices_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "platform_errors_lastSeen_idx" ON "platform_errors"("lastSeen");

-- CreateIndex
CREATE INDEX "platform_errors_firstSeen_idx" ON "platform_errors"("firstSeen");

-- CreateIndex
CREATE INDEX "platform_error_buckets_bucket_idx" ON "platform_error_buckets"("bucket");

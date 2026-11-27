-- Website activity: where and how a visitor who agreed was seen, and the journey (owner, 6 Nov 2026).
ALTER TABLE "web_visitors"
  ADD COLUMN "ipAddress" TEXT,
  ADD COLUMN "country" TEXT,
  ADD COLUMN "region" TEXT,
  ADD COLUMN "city" TEXT,
  ADD COLUMN "isp" TEXT,
  ADD COLUMN "networkKind" TEXT,
  ADD COLUMN "deviceKind" TEXT,
  ADD COLUMN "browser" TEXT,
  ADD COLUMN "screen" TEXT,
  ADD COLUMN "language" TEXT,
  ADD COLUMN "timezone" TEXT;

ALTER TABLE "web_page_views"
  ADD COLUMN "visitNo" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "durationSec" INTEGER,
  ADD COLUMN "ipAddress" TEXT,
  ADD COLUMN "country" TEXT,
  ADD COLUMN "region" TEXT,
  ADD COLUMN "city" TEXT,
  ADD COLUMN "isp" TEXT,
  ADD COLUMN "networkKind" TEXT;

-- The Customer inbox's visitor panel (owner, 24 Oct 2026): where the customer is, their browser's time zone,
-- language and device, how many times they've come back, and — on a website — when they were last online and
-- the pages they were on. Columns on a table this release added before; read by name (NOT_YET_EVERYWHERE).

-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "lastSeenAt" TIMESTAMP(3),
ADD COLUMN     "pagesSeen" JSONB,
ADD COLUMN     "visitCount" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "visitorCity" TEXT,
ADD COLUMN     "visitorCountry" TEXT,
ADD COLUMN     "visitorDevice" TEXT,
ADD COLUMN     "visitorLanguage" TEXT,
ADD COLUMN     "visitorRegion" TEXT,
ADD COLUMN     "visitorTimezone" TEXT;

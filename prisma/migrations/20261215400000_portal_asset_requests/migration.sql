-- Customers' requests about their machines in the portal (src/lib/portal/assets.ts).
ALTER TYPE "PortalRequestKind" ADD VALUE IF NOT EXISTS 'ASSET_PROBLEM';
ALTER TYPE "PortalRequestKind" ADD VALUE IF NOT EXISTS 'ASSET_CHANGE';
ALTER TYPE "PortalRequestKind" ADD VALUE IF NOT EXISTS 'ASSET_COVER';

ALTER TABLE "portal_requests" ADD COLUMN IF NOT EXISTS "assetId" TEXT;
DO $$ BEGIN
  ALTER TABLE "portal_requests" ADD CONSTRAINT "portal_requests_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Storage in the plans (owner, 20 Nov 2026 — src/lib/storage/quota.ts): a plan's allowance for the workspace's files,
-- a staff override, the storage a workspace uses as last measured, and the nightly history. Columns added only.

-- AlterTable
ALTER TABLE "plans" ADD COLUMN "storageMb" INTEGER;

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN "storageOverrideMb" INTEGER,
ADD COLUMN "storageUsedBytes" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN "storageMeasuredAt" TIMESTAMP(3),
ADD COLUMN "storageBreakdown" JSONB;

-- AlterTable
ALTER TABLE "tenant_usage" ADD COLUMN "storageBytes" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN "storageLimitMb" INTEGER;

-- The base plans already made start with 7 GB for the workspace (owner, 20 Nov 2026: "abhi base plan ko 7 gb krdo"),
-- as the catalogue now makes new ones (src/lib/platform/product-plans.ts EDITION_STORAGE_MB). Once, here; staff's to
-- change in the console from then on. Add-ons, bundles and internal plans are left with none. A workspace's limit
-- takes effect when its entitlements are worked out again (npm run platform:plans -- refresh).
UPDATE "plans" SET "storageMb" = 7168 WHERE "kind" = 'EDITION' AND "storageMb" IS NULL;

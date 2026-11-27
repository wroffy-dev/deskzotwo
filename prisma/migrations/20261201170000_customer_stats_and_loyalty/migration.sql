-- A customer's history with us and its loyalty tier (owner, 31 Oct 2026 — src/lib/customers/stats.ts): a cached row a
-- customer, refreshed daily, and the tiers' rules. New tables only; nothing existing changes.

-- CreateTable
CREATE TABLE "customer_stats" (
    "companyId" TEXT NOT NULL,
    "firstOrderAt" TIMESTAMP(3),
    "lifetimeValue" DECIMAL(16,2) NOT NULL DEFAULT 0,
    "last12Value" DECIMAL(16,2) NOT NULL DEFAULT 0,
    "prev12Value" DECIMAL(16,2) NOT NULL DEFAULT 0,
    "orders" INTEGER NOT NULL DEFAULT 0,
    "liveSubscriptions" INTEGER NOT NULL DEFAULT 0,
    "lastPurchaseAt" TIMESTAMP(3),
    "renewalsDue" INTEGER NOT NULL DEFAULT 0,
    "renewalsRenewed" INTEGER NOT NULL DEFAULT 0,
    "renewalsLostRecently" INTEGER NOT NULL DEFAULT 0,
    "avgDaysToPay" INTEGER,
    "overdue" DECIMAL(16,2) NOT NULL DEFAULT 0,
    "productCount" INTEGER NOT NULL DEFAULT 0,
    "tier" TEXT,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_stats_pkey" PRIMARY KEY ("companyId")
);

-- CreateTable
CREATE TABLE "loyalty_settings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "newWithinDays" INTEGER NOT NULL DEFAULT 90,
    "championYears" INTEGER NOT NULL DEFAULT 3,
    "championRenewalRate" INTEGER NOT NULL DEFAULT 90,
    "championBoughtMonths" INTEGER NOT NULL DEFAULT 6,
    "championTopPercent" INTEGER NOT NULL DEFAULT 10,
    "loyalYears" INTEGER NOT NULL DEFAULT 2,
    "loyalRenewalRate" INTEGER NOT NULL DEFAULT 75,
    "loyalBoughtMonths" INTEGER NOT NULL DEFAULT 12,
    "growingUnderYears" INTEGER NOT NULL DEFAULT 2,
    "atRiskFromMonths" INTEGER NOT NULL DEFAULT 6,
    "atRiskLostDays" INTEGER NOT NULL DEFAULT 90,
    "lapsedAfterMonths" INTEGER NOT NULL DEFAULT 12,
    "refreshedAt" TIMESTAMP(3),
    "refreshMs" INTEGER,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "loyalty_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "customer_stats_tier_idx" ON "customer_stats"("tier");

-- CreateIndex
CREATE INDEX "customer_stats_lifetimeValue_idx" ON "customer_stats"("lifetimeValue");

-- AddForeignKey
ALTER TABLE "customer_stats" ADD CONSTRAINT "customer_stats_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

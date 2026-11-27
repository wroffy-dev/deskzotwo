-- Credits per person for Apollo and Lusha (owner, 15 Nov 2026 — "admin can assign the credits to each users"; src/lib/enrich/
-- credits.ts): a monthly limit per provider, for everybody ("*") and for one person. No row: no limit. New table only.

-- CreateTable
CREATE TABLE "enrichment_allowances" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "monthlyCredits" INTEGER NOT NULL,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "enrichment_allowances_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "enrichment_allowances_provider_userId_key" ON "enrichment_allowances"("provider", "userId");

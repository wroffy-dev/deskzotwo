-- Data providers other than Apollo (owner, 14 Nov 2026 — "lusha integration also"; src/lib/lusha): one row per
-- provider, its API key encrypted with the workspace's key. Their lookups go in enrichment_lookups with their provider.
-- New table only.

-- CreateTable
CREATE TABLE "enrichment_connections" (
    "provider" TEXT NOT NULL,
    "apiKeyEnc" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastCheckedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "enrichment_connections_pkey" PRIMARY KEY ("provider")
);

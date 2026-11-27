-- Apollo.io enrichment (owner, 14 Nov 2026 — src/lib/apollo): the workspace's own Apollo API key, and every lookup made
-- with it — a company, a person's email, a mobile (which Apollo sends later to a webhook), a search. New tables only.

-- CreateTable
CREATE TABLE "apollo_connections" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "apiKeyEnc" TEXT NOT NULL,
    "webhookTokenHash" TEXT NOT NULL,
    "webhookTokenEnc" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastCheckedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "apollo_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "enrichment_lookups" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'APOLLO',
    "kind" TEXT NOT NULL,
    "companyId" TEXT,
    "contactId" TEXT,
    "requestedById" TEXT,
    "status" TEXT NOT NULL,
    "externalId" TEXT,
    "result" JSONB,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "enrichment_lookups_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "apollo_connections_webhookTokenHash_key" ON "apollo_connections"("webhookTokenHash");
CREATE INDEX "enrichment_lookups_companyId_createdAt_idx" ON "enrichment_lookups"("companyId", "createdAt");
CREATE INDEX "enrichment_lookups_contactId_createdAt_idx" ON "enrichment_lookups"("contactId", "createdAt");
CREATE INDEX "enrichment_lookups_externalId_status_idx" ON "enrichment_lookups"("externalId", "status");
CREATE INDEX "enrichment_lookups_createdAt_idx" ON "enrichment_lookups"("createdAt");

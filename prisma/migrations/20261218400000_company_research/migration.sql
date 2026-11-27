-- Research on a company from free public sources (18 Nov 2026 — src/lib/research): what Refresh gathered and the brief
-- Deskzo AI wrote from it. Read with a fallback (notMigratedYet) until every workspace has it.
CREATE TABLE "company_research" (
    "companyId" TEXT NOT NULL,
    "facts" JSONB NOT NULL DEFAULT '{}',
    "refreshedAt" TIMESTAMP(3),
    "refreshedById" TEXT,
    "brief" TEXT,
    "briefAt" TIMESTAMP(3),
    "briefById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "company_research_pkey" PRIMARY KEY ("companyId")
);

ALTER TABLE "company_research" ADD CONSTRAINT "company_research_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

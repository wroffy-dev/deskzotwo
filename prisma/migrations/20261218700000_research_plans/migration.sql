-- Deskzo AI's "Research & plan" on a lead or company (owner, 18 Nov 2026 — src/lib/research/plan.ts).
CREATE TABLE "research_plans" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "leadId" TEXT,
    "plan" JSONB NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "research_plans_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "research_plans_key_key" ON "research_plans"("key");
CREATE INDEX "research_plans_companyId_idx" ON "research_plans"("companyId");
CREATE INDEX "research_plans_leadId_idx" ON "research_plans"("leadId");

ALTER TABLE "research_plans" ADD CONSTRAINT "research_plans_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "research_plans" ADD CONSTRAINT "research_plans_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "research_plans" ADD CONSTRAINT "research_plans_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

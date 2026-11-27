-- Who looks after a customer's renewals (owner, 30 Oct 2026): empty is the account manager (src/lib/companies/
-- renewal-manager.ts). Cleared, not cascaded, when the person is removed.
ALTER TABLE "companies" ADD COLUMN "renewalManagerId" TEXT;
CREATE INDEX "companies_renewalManagerId_idx" ON "companies"("renewalManagerId");
ALTER TABLE "companies" ADD CONSTRAINT "companies_renewalManagerId_fkey" FOREIGN KEY ("renewalManagerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

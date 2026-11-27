-- A company's CIN (India) or trade licence (UAE) — src/lib/companies/registration.ts.
CREATE TABLE "company_registrations" (
    "companyId" TEXT NOT NULL,
    "cin" TEXT,
    "tradeLicenceNumber" TEXT,
    "tradeLicenceAuthority" TEXT,
    "tradeLicenceExpiresOn" DATE,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "company_registrations_pkey" PRIMARY KEY ("companyId")
);

ALTER TABLE "company_registrations" ADD CONSTRAINT "company_registrations_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

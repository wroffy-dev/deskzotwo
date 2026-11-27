-- A vendor's MSME (Udyam) registration (owner, 17 Nov 2026): the 45-day payment limit on its bills.
-- CreateTable
CREATE TABLE "vendor_msme" (
    "companyId" TEXT NOT NULL,
    "udyamNumber" TEXT NOT NULL,
    "category" "MsmeCategory" NOT NULL,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vendor_msme_pkey" PRIMARY KEY ("companyId")
);

-- AddForeignKey
ALTER TABLE "vendor_msme" ADD CONSTRAINT "vendor_msme_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

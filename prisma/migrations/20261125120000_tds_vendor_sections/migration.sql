-- TDS, phase 1 (owner, 25 Oct 2026): the section a vendor's bills start from, and its lower deduction
-- certificates. New tables only.

-- CreateTable
CREATE TABLE "vendor_tds" (
    "companyId" TEXT NOT NULL,
    "sectionKey" TEXT NOT NULL,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vendor_tds_pkey" PRIMARY KEY ("companyId")
);

-- CreateTable
CREATE TABLE "tds_certificates" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "sectionKey" TEXT NOT NULL,
    "certificateNo" TEXT NOT NULL,
    "ratePercent" DECIMAL(5,2) NOT NULL,
    "amountLimit" DECIMAL(14,2),
    "validFrom" DATE NOT NULL,
    "validTo" DATE NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tds_certificates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tds_certificates_companyId_idx" ON "tds_certificates"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "tds_certificates_companyId_certificateNo_key" ON "tds_certificates"("companyId", "certificateNo");

-- AddForeignKey
ALTER TABLE "vendor_tds" ADD CONSTRAINT "vendor_tds_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tds_certificates" ADD CONSTRAINT "tds_certificates_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

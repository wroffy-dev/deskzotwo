-- GSTIN checks (owner, 25 Oct 2026): a customer's or vendor's GSTIN as the GST system holds it, one row a GSTIN.
-- A new table only.

-- CreateTable
CREATE TABLE "gstin_checks" (
    "gstin" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "legalName" TEXT,
    "tradeName" TEXT,
    "address" TEXT,
    "stateCode" TEXT,
    "pincode" TEXT,
    "taxpayerType" TEXT,
    "blocked" BOOLEAN NOT NULL DEFAULT false,
    "source" TEXT NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "checkedById" TEXT,

    CONSTRAINT "gstin_checks_pkey" PRIMARY KEY ("gstin")
);

-- CreateIndex
CREATE INDEX "gstin_checks_checkedById_checkedAt_idx" ON "gstin_checks"("checkedById", "checkedAt");

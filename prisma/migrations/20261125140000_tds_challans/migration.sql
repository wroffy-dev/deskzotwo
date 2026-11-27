-- TDS, phase 2 (owner, 25 Oct 2026): challans (ITNS 281) and the deductions each paid. New tables only.

-- CreateTable
CREATE TABLE "tds_challans" (
    "id" TEXT NOT NULL,
    "sectionKey" TEXT NOT NULL,
    "majorHead" TEXT NOT NULL,
    "minorHead" TEXT NOT NULL DEFAULT '200',
    "periodMonth" DATE NOT NULL,
    "paidOn" DATE NOT NULL,
    "bsrCode" TEXT NOT NULL,
    "challanSerial" TEXT NOT NULL,
    "crn" TEXT,
    "tax" DECIMAL(14,2) NOT NULL,
    "interest" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "fee" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "others" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "bankAccountId" TEXT,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tds_challans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tds_challan_links" (
    "id" TEXT NOT NULL,
    "challanId" TEXT NOT NULL,
    "documentId" TEXT,
    "payslipId" TEXT,
    "amount" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "tds_challan_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tds_challans_periodMonth_idx" ON "tds_challans"("periodMonth");

-- CreateIndex
CREATE UNIQUE INDEX "tds_challans_bsrCode_paidOn_challanSerial_key" ON "tds_challans"("bsrCode", "paidOn", "challanSerial");

-- CreateIndex
CREATE UNIQUE INDEX "tds_challan_links_documentId_key" ON "tds_challan_links"("documentId");

-- CreateIndex
CREATE UNIQUE INDEX "tds_challan_links_payslipId_key" ON "tds_challan_links"("payslipId");

-- CreateIndex
CREATE INDEX "tds_challan_links_challanId_idx" ON "tds_challan_links"("challanId");

-- AddForeignKey
ALTER TABLE "tds_challans" ADD CONSTRAINT "tds_challans_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "bank_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tds_challan_links" ADD CONSTRAINT "tds_challan_links_challanId_fkey" FOREIGN KEY ("challanId") REFERENCES "tds_challans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tds_challan_links" ADD CONSTRAINT "tds_challan_links_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "trade_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tds_challan_links" ADD CONSTRAINT "tds_challan_links_payslipId_fkey" FOREIGN KEY ("payslipId") REFERENCES "payslips"("id") ON DELETE CASCADE ON UPDATE CASCADE;

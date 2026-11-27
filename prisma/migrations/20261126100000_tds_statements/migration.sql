-- TDS, phase 3 (owner, 26 Oct 2026): the details every quarterly statement repeats, and each quarter's
-- statement with the token number it was filed under. New tables only.

-- CreateTable
CREATE TABLE "tds_settings" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "tan" TEXT,
    "deductorType" TEXT NOT NULL DEFAULT 'K',
    "responsibleName" TEXT,
    "responsibleDesignation" TEXT,
    "responsiblePan" TEXT,
    "responsibleAddress" TEXT,
    "responsibleCity" TEXT,
    "responsibleState" TEXT,
    "responsiblePincode" TEXT,
    "responsibleEmail" TEXT,
    "responsiblePhone" TEXT,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tds_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tds_statements" (
    "id" TEXT NOT NULL,
    "formNumber" TEXT NOT NULL DEFAULT '140',
    "taxYear" INTEGER NOT NULL,
    "quarter" INTEGER NOT NULL,
    "generatedAt" TIMESTAMP(3),
    "generatedById" TEXT,
    "tokenNumber" TEXT,
    "filedOn" DATE,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tds_statements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tds_statements_formNumber_taxYear_quarter_key" ON "tds_statements"("formNumber", "taxYear", "quarter");

-- UAE VAT, phase 1 (owner, 31 Oct 2026): what a line's tax is outside India — standard, zero-rated, exempt or out of
-- scope — on items and document lines. New enum and nullable columns only; India's rows stay null.

-- CreateEnum
CREATE TYPE "TaxCategory" AS ENUM ('STANDARD', 'ZERO_RATED', 'EXEMPT', 'OUT_OF_SCOPE');

-- AlterTable
ALTER TABLE "trade_document_lines" ADD COLUMN "taxCategory" "TaxCategory";

-- AlterTable
ALTER TABLE "items" ADD COLUMN "taxCategory" "TaxCategory";

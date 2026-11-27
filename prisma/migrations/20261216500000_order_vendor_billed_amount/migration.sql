-- What the vendor billed us for an order, before GST (owner, 16 Nov 2026 — src/lib/orders/vendor-invoice.ts): typed with
-- the vendor's invoice number, checked against quantity × purchase price. Read by name; listed in NOT_YET_EVERYWHERE.
ALTER TABLE "company_products" ADD COLUMN "vendorBilledAmount" DECIMAL(14,2);

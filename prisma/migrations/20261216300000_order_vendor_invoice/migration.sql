-- The vendor's own invoice number for what they supplied on an order (owner, 16 Nov 2026 — src/lib/orders/vendor-invoice.ts):
-- added on the order at any stage, fulfilled included, and shown on the orders list. Read by name; listed in
-- NOT_YET_EVERYWHERE until every workspace has it.
ALTER TABLE "company_products" ADD COLUMN "vendorInvoiceNumber" TEXT;

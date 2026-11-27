-- The workspace's default tax rate, for new items and lines (owner, 23 Nov 2026 — Settings › Taxes; src/lib/country-pack.ts).
-- Null: the country's own default.
ALTER TABLE "tenants" ADD COLUMN "defaultTaxRate" DECIMAL(5,2);

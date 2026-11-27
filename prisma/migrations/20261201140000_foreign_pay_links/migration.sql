-- Multi-currency phase 4: pay-now links in a foreign currency (owner, 30 Oct 2026).

-- Whether the business has had international payments enabled on its gateway account, and so whether a link may be
-- made for an invoice in another currency. Off until an admin says so (src/lib/collect/gateways.ts).
ALTER TABLE "payment_gateways" ADD COLUMN "internationalOn" BOOLEAN NOT NULL DEFAULT false;

-- A paid link Deskzo would not record by itself — the gateway reported a different currency from the one asked —
-- and why, for a person to check (src/lib/collect/links.ts).
ALTER TABLE "payment_links" ADD COLUMN "heldReason" TEXT;
